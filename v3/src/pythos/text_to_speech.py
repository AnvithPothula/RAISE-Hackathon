from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import contextlib
import sys
from pathlib import Path

from .config import WorkerConfig
from .protocol import JsonlWriter


class PiperSpeaker:
    def __init__(self, config: WorkerConfig, events: JsonlWriter) -> None:
        self._config = config
        self._events = events
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
            self._events.emit("tts_started", text=text)
            for chunk in split_spoken_chunks(text):
                if self._stop.is_set():
                    self._events.emit("tts_done", cancelled=True)
                    return
                self._synthesize_and_play(chunk, length_scale)
            self._events.emit("tts_done", cancelled=self._stop.is_set())
        except Exception as exc:
            self._events.emit("error", source="tts", message=str(exc))

    def _synthesize_and_play(self, text: str, length_scale: float) -> None:
        wav_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
                wav_path = Path(tmp.name)

            command = [
                str(self._config.models.piper_executable),
                "-m",
                str(self._config.models.piper_model),
                "-c",
                str(self._config.models.piper_config),
                "-f",
                str(wav_path),
                "--length_scale",
                str(length_scale),
            ]
            self._events.emit("tts_command", command=command)
            process = subprocess.run(
                command,
                input=text.encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if process.returncode != 0:
                self._events.emit(
                    "error",
                    source="tts",
                    message=process.stderr.decode("utf-8", errors="replace"),
                )
                return

            if self._stop.is_set():
                return

            self._play_wav(wav_path)
        finally:
            if wav_path is not None:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

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
