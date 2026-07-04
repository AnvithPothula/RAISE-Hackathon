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

from .config import GradiumConfig, WorkerConfig
from .protocol import JsonlWriter

# Sample rate (Hz) for each Gradium raw-PCM output format. "pcm" is 48 kHz.
_PCM_SAMPLE_RATES = {
    "pcm": 48000,
    "pcm_48000": 48000,
    "pcm_24000": 24000,
    "pcm_16000": 16000,
    "pcm_8000": 8000,
}


class GradiumSpeaker:
    """Text-to-speech backed by the Gradium streaming TTS WebSocket API.

    Synthesises each spoken chunk into raw PCM over ``wss://.../speech/tts``,
    wraps it in a WAV container, and plays it locally with pygame. The public
    surface, threading model, and emitted events match the previous local
    (Piper) speaker so the worker and renderer need no changes.
    """

    def __init__(self, config: WorkerConfig, events: JsonlWriter) -> None:
        self._config = config
        self._gradium = config.gradium
        self._events = events
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def speak_async(self, text: str, length_scale: float | None = None) -> None:
        # length_scale is accepted for wire compatibility with the worker/renderer
        # but is a Piper concept; Gradium speed is controlled via voice settings.
        self.stop()
        self._stop.clear()
        safe_text = sanitize_spoken_text(text)
        self._thread = threading.Thread(
            target=self._speak,
            args=(safe_text,),
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _speak(self, text: str) -> None:
        try:
            if not self._gradium.is_configured:
                self._events.emit(
                    "error",
                    source="tts",
                    message="GRADIUM_API_KEY is not set; cannot synthesize speech.",
                )
                self._events.emit("tts_done", cancelled=True)
                return
            self._events.emit("tts_started", text=text)
            for chunk in split_spoken_chunks(text):
                if self._stop.is_set():
                    self._events.emit("tts_done", cancelled=True)
                    return
                self._synthesize_and_play(chunk)
            self._events.emit("tts_done", cancelled=self._stop.is_set())
        except Exception as exc:
            self._events.emit("error", source="tts", message=str(exc))

    def _synthesize_and_play(self, text: str) -> None:
        wav_path: Path | None = None
        try:
            pcm = asyncio.run(self._synthesize(text))
            if self._stop.is_set() or not pcm:
                return

            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                wav_path = Path(tmp.name)
            self._write_wav(wav_path, pcm)
            self._play_wav(wav_path)
        finally:
            if wav_path is not None:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

    async def _synthesize(self, text: str) -> bytes:
        import websockets

        cfg: GradiumConfig = self._gradium
        output_format = cfg.tts_output_format if cfg.tts_output_format in _PCM_SAMPLE_RATES else "pcm"
        setup = {
            "type": "setup",
            "voice_id": cfg.tts_voice_id,
            "model_name": cfg.tts_model,
            "output_format": output_format,
        }
        chunks: list[bytes] = []
        url = f"{cfg.base_ws_url}/speech/tts"
        self._events.emit(
            "tts_command",
            command=["gradium", url, cfg.tts_voice_id, output_format],
        )

        async with websockets.connect(url, additional_headers={"x-api-key": cfg.api_key}) as ws:
            await ws.send(json.dumps(setup))
            ready = json.loads(await ws.recv())
            if ready.get("type") != "ready":
                raise RuntimeError(f"Unexpected TTS handshake response: {ready}")

            await ws.send(json.dumps({"type": "text", "text": text}))
            await ws.send(json.dumps({"type": "end_of_stream"}))

            while True:
                if self._stop.is_set():
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

    def _write_wav(self, wav_path: Path, pcm: bytes) -> None:
        sample_rate = _PCM_SAMPLE_RATES.get(self._gradium.tts_output_format, 48000)
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)  # 16-bit signed
            handle.setframerate(sample_rate)
            handle.writeframes(pcm)

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
