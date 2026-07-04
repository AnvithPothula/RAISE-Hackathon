"""Hybrid text-to-speech: streaming Gradium cloud TTS with a local fallback.

Per spoken chunk, the engine is chosen behind the network-state detector:
Gradium's studio voice when an API key is set and the network is up, the
local chain (Piper when installed, OS system voice otherwise) when it is
not. A Gradium synthesis that dies mid-utterance falls back to the local
engine for that chunk instead of going silent — the demo's audible
"cloud voice degrades to local voice" moment.

The public surface, threading model, and emitted events match the previous
speaker, so the worker protocol and renderer need no changes beyond the new
optional ``engine`` field on ``tts_started``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import re
import sys
import tempfile
import threading
import wave
from pathlib import Path

from typing import Callable

from .config import GradiumConfig, WorkerConfig
from .debug_log import debug
from .network_monitor import is_network_error
from .protocol import JsonlWriter
from .voice_mode import VoiceModeReporter

# Sample rate (Hz) for each Gradium raw-PCM output format. "pcm" is 48 kHz.
_PCM_SAMPLE_RATES = {
    "pcm": 48000,
    "pcm_48000": 48000,
    "pcm_24000": 24000,
    "pcm_16000": 16000,
    "pcm_8000": 8000,
}


def pcm_output_format(cfg: GradiumConfig) -> str:
    """The raw-PCM output format to request (falls back to 48 kHz "pcm")."""
    return cfg.tts_output_format if cfg.tts_output_format in _PCM_SAMPLE_RATES else "pcm"


def pcm_sample_rate(cfg: GradiumConfig) -> int:
    return _PCM_SAMPLE_RATES.get(pcm_output_format(cfg), 48000)


def write_wav_pcm(wav_path: Path, pcm: bytes, sample_rate: int) -> None:
    """Wrap raw 16-bit mono PCM in a standard WAV container."""
    with wave.open(str(wav_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)  # 16-bit signed
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)


async def gradium_tts_pcm(
    cfg: GradiumConfig,
    text: str,
    should_stop: Callable[[], bool] | None = None,
) -> bytes:
    """Synthesize ``text`` via the Gradium TTS WebSocket and return raw PCM bytes."""
    import websockets

    setup = {
        "type": "setup",
        "voice_id": cfg.tts_voice_id,
        "model_name": cfg.tts_model,
        "output_format": pcm_output_format(cfg),
    }
    chunks: list[bytes] = []
    url = f"{cfg.base_ws_url}/speech/tts"

    async with websockets.connect(url, additional_headers={"x-api-key": cfg.api_key}) as ws:
        await ws.send(json.dumps(setup))
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Unexpected TTS handshake response: {ready}")

        await ws.send(json.dumps({"type": "text", "text": text}))
        await ws.send(json.dumps({"type": "end_of_stream"}))

        while True:
            if should_stop is not None and should_stop():
                break
            msg = json.loads(await ws.recv())
            kind = msg.get("type")
            if kind == "audio":
                chunks.append(base64.b64decode(msg["audio"]))
            elif kind == "end_of_stream":
                break
            elif kind == "error":
                raise RuntimeError(msg.get("message", "Gradium TTS error"))

    return b"".join(chunks)


class HybridSpeaker:
    """Text-to-speech with per-chunk cloud/local engine selection.

    Synthesizes each spoken chunk into a WAV file (Gradium PCM or the local
    Piper/system chain) and plays it with pygame. Engine choice and network
    fallback are delegated to the shared :class:`VoiceModeReporter` so the
    speaker and the listener always agree on the active voice mode.
    """

    def __init__(self, config: WorkerConfig, events: JsonlWriter, reporter: VoiceModeReporter) -> None:
        self._config = config
        self._gradium = config.gradium
        self._events = events
        self._reporter = reporter
        self._local = reporter.local_tts
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def speak_async(self, text: str, length_scale: float | None = None) -> None:
        self.stop()
        self._stop.clear()
        safe_text = sanitize_spoken_text(text)
        self._thread = threading.Thread(
            target=self._speak,
            args=(safe_text, length_scale or self._config.audio.tts_length_scale),
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _speak(self, text: str, length_scale: float) -> None:
        try:
            engine = self._reporter.refresh("speaking turn")
            self._events.emit("tts_started", text=text, engine=engine)
            for chunk in split_spoken_chunks(text):
                if self._stop.is_set():
                    self._events.emit("tts_done", cancelled=True)
                    return
                engine = self._synthesize_and_play(chunk, engine, length_scale)
            self._events.emit("tts_done", cancelled=self._stop.is_set())
        except Exception as exc:
            self._events.emit("error", source="tts", message=str(exc))

    def _synthesize_and_play(self, text: str, engine: str, length_scale: float) -> str:
        """Synthesize and play one chunk; returns the engine to use next.

        A Gradium failure caused by the network swaps this and subsequent
        chunks to the local engine mid-utterance. Non-network failures
        propagate so real problems stay visible.
        """
        wav_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                wav_path = Path(tmp.name)

            if engine == "gradium":
                try:
                    pcm = asyncio.run(self._synthesize_gradium(text))
                    if self._stop.is_set():
                        return engine
                    if pcm:
                        write_wav_pcm(wav_path, pcm, pcm_sample_rate(self._gradium))
                        self._play_wav(wav_path)
                    return engine
                except Exception as exc:
                    if not is_network_error(exc) or self._local.engine is None:
                        raise
                    debug(f"gradium tts failed mid-utterance; swapping to local voice: {exc}")
                    self._reporter.note_network_failure("speech synthesis")
                    engine = "local"

            used = self._synthesize_local(text, wav_path, length_scale)
            if self._stop.is_set():
                return engine
            self._play_wav(wav_path)
            debug(f"local tts chunk spoken engine={used}")
            return engine
        finally:
            if wav_path is not None:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

    async def _synthesize_gradium(self, text: str) -> bytes:
        cfg = self._gradium
        self._events.emit(
            "tts_command",
            command=["gradium", f"{cfg.base_ws_url}/speech/tts", cfg.tts_voice_id, pcm_output_format(cfg)],
        )
        return await gradium_tts_pcm(cfg, text, should_stop=self._stop.is_set)

    def _synthesize_local(self, text: str, wav_path: Path, length_scale: float) -> str:
        engine = self._local.synthesize_to_wav(text, wav_path, length_scale)
        self._events.emit("tts_command", command=[engine, "local", str(wav_path)])
        return engine

    def _play_wav(self, wav_path: Path) -> None:
        os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
        with contextlib.redirect_stdout(sys.stderr):
            import pygame

        pygame.mixer.init()
        try:
            pygame.mixer.music.load(str(wav_path))
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy() and not self._stop.is_set():
                pygame.time.wait(50)
            if self._stop.is_set():
                pygame.mixer.music.stop()
        finally:
            pygame.mixer.quit()


def split_spoken_chunks(text: str, max_chars: int = 220) -> list[str]:
    clean = " ".join(sanitize_spoken_text(text).split())
    if not clean:
        return []

    sentences = re.split(r"(?<=[.!?])\s+", clean)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if len(sentence) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_sentence(sentence, max_chars))
            continue
        candidate = f"{current} {sentence}".strip()
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = sentence
    if current:
        chunks.append(current)
    return chunks


def sanitize_spoken_text(text: str) -> str:
    safe = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    safe = re.sub(r"°\s*F", " degrees Fahrenheit", safe, flags=re.IGNORECASE)
    safe = re.sub(r"°\s*C", " degrees Celsius", safe, flags=re.IGNORECASE)
    safe = re.sub(r"[\U0001F000-\U0001FAFF]", "", safe)
    safe = re.sub(r"[\u2600-\u27BF]", "", safe)
    safe = re.sub(r"[\uFE00-\uFE0F]", "", safe)
    safe = re.sub(r"[\U000E0000-\U000E007F]", "", safe)
    safe = re.sub(r"[\u200D\u20E3]", "", safe)
    safe = "".join(
        char
        for char in safe
        if char in "\t\n\r" or "\u0020" <= char <= "\u024F"
    )
    safe = re.sub(r"[ \t]{2,}", " ", safe)
    safe = re.sub(r"\s+([,.!?;:])", r"\1", safe)
    return safe.strip()


def _split_long_sentence(sentence: str, max_chars: int) -> list[str]:
    words = sentence.split()
    chunks: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = word
    if current:
        chunks.append(current)
    return chunks
