"""Fully local (offline) voice engines: Vosk STT and Piper/system TTS.

These are the fallback engines behind the network-state detector. When the
streaming Gradium cloud voice is unreachable — no API key, no network, or a
stream that dies mid-turn — the worker swaps to these engines and keeps the
conversation going. The Gemma brain never notices: it is local either way.

The Vosk implementation is restored and modernized from this repo's git
history (commit 4cd88d7 "Base" shipped the original KaldiRecognizer loop).
Wake-word detection now rides on Vosk transcripts, matching the transcript
strategy the Gradium path already uses, so no extra wake-word model is needed.

Text-to-speech is a defensive chain:

1. **Piper** — used when the configured executable and voice model exist
   (see ``config.json`` ``models.piper*``; install is optional).
2. **System TTS** — macOS ``say``, Windows ``System.Speech``, Linux
   ``espeak-ng``/``espeak``. Zero setup: present on effectively every OS, so
   the offline demo can never be stranded without a voice.

All heavy imports (vosk) are deferred to call time so this module stays
importable in test environments without the audio stack installed.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .debug_log import debug

ReadFn = Callable[..., bytes]

# Generous ceiling per spoken chunk (chunks are <= ~220 chars): if a
# synthesizer takes longer than this it is wedged and the turn should fail
# loudly instead of hanging the speak thread.
_SYNTH_TIMEOUT_SECONDS = 60.0


def contains_wake_word(text: str, wake_word: str) -> bool:
    """True if the wake word appears in a transcript.

    Matching is punctuation- and case-insensitive. A single-word wake word is
    matched against whole transcribed words (so "pythos" won't fire on an
    unrelated substring), while a multi-word wake phrase is matched as a
    contiguous substring of the normalized text. Shared by the Gradium and
    Vosk wake paths so both engines behave identically.
    """
    target = re.sub(r"[^a-z0-9 ]", " ", wake_word.lower()).strip()
    if not target:
        return False
    normalized = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    words = normalized.split()
    if " " in target:
        return target in " ".join(words)
    return target in words


@dataclass(frozen=True)
class LocalSttSettings:
    """The slice of audio config the offline recognizer needs."""

    chunk: int
    rate: int
    asr_timeout_seconds: float
    silence_timeout_seconds: float


class VoskTranscriber:
    """Streaming offline speech-to-text over a Vosk model.

    The model loads lazily on first use and is cached for the worker's
    lifetime (the en-us 0.22 model takes a few seconds to map). All loops are
    driven by a ``should_stop`` callable owned by the caller, mirroring how
    ``SpeechListener`` cancels Gradium turns.
    """

    def __init__(self, model_path: Path, settings: LocalSttSettings) -> None:
        self._model_path = Path(model_path)
        self._settings = settings
        self._model: Any | None = None
        self._model_lock = threading.Lock()

    @property
    def settings(self) -> LocalSttSettings:
        return self._settings

    @property
    def available(self) -> bool:
        """True when the Vosk model directory exists on disk."""
        return self._model_path.is_dir()

    def install_hint(self) -> str:
        return (
            "Offline speech recognition needs the Vosk model. Run "
            "scripts/install-vosk-model.sh (macOS/Linux) or "
            "scripts\\install-vosk-model.ps1 (Windows), then try again. "
            f"Expected model at: {self._model_path}"
        )

    def preload(self) -> None:
        """Warm the Vosk model so the first offline turn skips the load cost."""
        self._get_model()

    def _get_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                import vosk

                vosk.SetLogLevel(-1)
                started = time.perf_counter()
                debug(f"loading Vosk model path={self._model_path}")
                self._model = vosk.Model(str(self._model_path))
                debug(f"loaded Vosk model elapsed={time.perf_counter() - started:.2f}s")
            return self._model

    def _create_recognizer(self, rate: int | None = None) -> Any:
        import vosk

        vosk.SetLogLevel(-1)
        return vosk.KaldiRecognizer(self._get_model(), rate or self._settings.rate)

    def transcribe_stream(
        self,
        read: ReadFn,
        should_stop: Callable[[], bool],
        *,
        on_partial: Callable[[str], None],
        on_level: Callable[[bytes], None],
    ) -> str:
        """Transcribe one listening turn from a microphone read function.

        Returns the final transcript, or "" when nothing was recognized or the
        caller stopped the turn. Turn boundaries: Vosk end-of-utterance, the
        ASR timeout, or the silence timeout — the same semantics as the
        original local pipeline and the Gradium VAD path.
        """
        recognizer = self._create_recognizer()
        started = time.time()
        last_speech = started
        last_partial = ""

        while not should_stop():
            data = read(self._settings.chunk, exception_on_overflow=False)
            on_level(data)

            if recognizer.AcceptWaveform(data):
                text = str(json.loads(recognizer.Result()).get("text", "")).strip()
                if text:
                    debug(f"vosk final transcript text={text!r}")
                    return text
                last_speech = time.time()
            else:
                partial = str(json.loads(recognizer.PartialResult()).get("partial", "")).strip()
                if partial and partial != last_partial:
                    last_partial = partial
                    last_speech = time.time()
                    debug(f"vosk partial transcript text={partial!r}")
                    on_partial(partial)

            now = time.time()
            if now - started > self._settings.asr_timeout_seconds:
                debug("vosk listen stream ASR timeout")
                break
            if now - last_speech > self._settings.silence_timeout_seconds:
                debug("vosk listen stream silence timeout")
                break

        if should_stop():
            return ""
        final = str(json.loads(recognizer.FinalResult()).get("text", "")).strip()
        if final:
            debug(f"vosk final transcript after flush text={final!r}")
        return final

    def wait_for_wake_word(
        self,
        read: ReadFn,
        should_stop: Callable[[], bool],
        wake_word: str,
        *,
        on_level: Callable[[bytes], None],
    ) -> bool:
        """Block until the wake word is transcribed offline (or stop is set).

        Partial results are matched for fast reaction; completed phrases
        without the wake word reset the recognizer so matching stays anchored
        to what is currently being said (same policy as the Gradium path).
        """
        recognizer = self._create_recognizer()
        debug(f"vosk wakeword loop starting word={wake_word!r}")
        while not should_stop():
            data = read(self._settings.chunk, exception_on_overflow=False)
            on_level(data)

            if recognizer.AcceptWaveform(data):
                text = str(json.loads(recognizer.Result()).get("text", "")).strip()
                if text and contains_wake_word(text, wake_word):
                    debug(f"vosk wakeword matched in final={text!r}")
                    return True
                recognizer.Reset()
            else:
                partial = str(json.loads(recognizer.PartialResult()).get("partial", "")).strip()
                if partial and contains_wake_word(partial, wake_word):
                    debug(f"vosk wakeword matched in partial={partial!r}")
                    return True
        return False

    def transcribe_wav_file(self, wav_path: Path) -> str:
        """Transcribe a whole 16-bit mono WAV file (Echo/Android uploads)."""
        with wave.open(str(wav_path), "rb") as handle:
            if handle.getnchannels() != 1:
                raise ValueError("Expected mono WAV for offline transcription")
            if handle.getsampwidth() != 2:
                raise ValueError("Expected 16-bit PCM WAV for offline transcription")
            rate = handle.getframerate()
            recognizer = self._create_recognizer(rate)
            segments: list[str] = []
            chunk_frames = max(1, rate // 4)
            while True:
                frames = handle.readframes(chunk_frames)
                if not frames:
                    break
                if recognizer.AcceptWaveform(frames):
                    text = str(json.loads(recognizer.Result()).get("text", "")).strip()
                    if text:
                        segments.append(text)
        final = str(json.loads(recognizer.FinalResult()).get("text", "")).strip()
        if final:
            segments.append(final)
        return " ".join(segments).strip()


class VoskPushTranscriber:
    """Push-based offline transcriber for the Echo/Alexa bridge.

    Implements the same duck-typed protocol as ``GradiumPushTranscriber``
    (``open`` / ``send`` / ``poll`` / ``finalize`` / ``close``) so the echo
    realtime listener can swap engines per session without special cases.
    Vosk end-of-utterance results mark ``turn_ended``, mirroring the role of
    Gradium's semantic VAD signal.
    """

    def __init__(self, transcriber: VoskTranscriber) -> None:
        self._transcriber = transcriber
        self._lock = threading.Lock()
        self._recognizer: Any | None = None
        self._segments: list[str] = []
        self._partial = ""
        self._turn_ended = False
        self._error: str | None = None

    def open(self, timeout: float = 6.0) -> None:
        del timeout  # symmetric signature with the Gradium transcriber
        with self._lock:
            self._segments = []
            self._partial = ""
            self._turn_ended = False
            self._error = None
            try:
                self._recognizer = self._transcriber._create_recognizer()
            except Exception as exc:
                self._recognizer = None
                self._error = str(exc)
                raise

    def send(self, pcm: bytes) -> None:
        if not pcm:
            return
        with self._lock:
            recognizer = self._recognizer
            if recognizer is None:
                return
            try:
                if recognizer.AcceptWaveform(pcm):
                    text = str(json.loads(recognizer.Result()).get("text", "")).strip()
                    if text:
                        self._segments.append(text)
                        self._turn_ended = True
                    self._partial = " ".join(self._segments).strip()
                else:
                    live = str(json.loads(recognizer.PartialResult()).get("partial", "")).strip()
                    self._partial = " ".join([*self._segments, live]).strip() if live else " ".join(self._segments).strip()
            except Exception as exc:
                self._error = str(exc)

    def poll(self) -> dict[str, Any]:
        with self._lock:
            return {"partial": self._partial, "turn_ended": self._turn_ended, "error": self._error}

    def finalize(self, timeout: float = 5.0) -> str:
        del timeout
        with self._lock:
            recognizer = self._recognizer
            if recognizer is not None:
                try:
                    final = str(json.loads(recognizer.FinalResult()).get("text", "")).strip()
                    if final:
                        self._segments.append(final)
                except Exception as exc:
                    self._error = self._error or str(exc)
            return " ".join(self._segments).strip()

    def close(self) -> None:
        with self._lock:
            self._recognizer = None


@dataclass(frozen=True)
class PiperVoice:
    executable: Path
    model: Path
    config: Path


def resolve_piper_voice(
    executable: Path,
    model: Path,
    config: Path,
    *,
    which: Callable[[str], str | None] = shutil.which,
) -> PiperVoice | None:
    """Locate a usable Piper install, tolerating the Windows-era config path.

    Candidates for the executable, in order: the configured path as-is, the
    same path without a ``.exe`` suffix (the committed config predates mac
    support), and ``piper`` on PATH. The voice model and its JSON config must
    both exist regardless of where the binary comes from.
    """
    if not model.is_file() or not config.is_file():
        return None

    candidates: list[Path] = [executable]
    if executable.suffix.lower() == ".exe":
        candidates.append(executable.with_suffix(""))
    on_path = which("piper")
    if on_path:
        candidates.append(Path(on_path))

    for candidate in candidates:
        if candidate.is_file():
            return PiperVoice(executable=candidate, model=model, config=config)
    return None


def build_piper_command(voice: PiperVoice, wav_path: Path, length_scale: float) -> list[str]:
    return [
        str(voice.executable),
        "-m",
        str(voice.model),
        "-c",
        str(voice.config),
        "-f",
        str(wav_path),
        "--length_scale",
        str(length_scale),
    ]


def build_system_tts_command(text: str, wav_path: Path, platform: str) -> list[str] | None:
    """Zero-setup system TTS command per OS, writing 16-bit PCM WAV."""
    if platform == "darwin":
        return [
            "say",
            "-o",
            str(wav_path),
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            text,
        ]
    if platform == "win32":
        escaped_text = text.replace("'", "''")
        escaped_path = str(wav_path).replace("'", "''")
        script = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SetOutputToWaveFile('{escaped_path}'); "
            f"$s.Speak('{escaped_text}'); "
            "$s.Dispose()"
        )
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", script]
    for binary in ("espeak-ng", "espeak"):
        if shutil.which(binary):
            return [binary, "-w", str(wav_path), text]
    return None


def system_tts_available(platform: str, *, which: Callable[[str], str | None] = shutil.which) -> bool:
    if platform == "darwin":
        return which("say") is not None
    if platform == "win32":
        return which("powershell") is not None
    return which("espeak-ng") is not None or which("espeak") is not None


class LocalSynthesizer:
    """Offline text-to-speech chain: Piper when installed, system TTS always.

    ``synthesize_to_wav`` writes a playable WAV and returns the engine name it
    used ("piper" or "system") so the pipeline can report the active voice in
    the demo HUD. Raises RuntimeError when no engine could produce audio.
    """

    def __init__(
        self,
        piper_executable: Path,
        piper_model: Path,
        piper_config: Path,
        *,
        default_length_scale: float = 1.0,
        platform: str | None = None,
    ) -> None:
        self._piper_executable = Path(piper_executable)
        self._piper_model = Path(piper_model)
        self._piper_config = Path(piper_config)
        self._default_length_scale = default_length_scale
        self._platform = platform or sys.platform

    def resolve_piper(self) -> PiperVoice | None:
        return resolve_piper_voice(self._piper_executable, self._piper_model, self._piper_config)

    @property
    def engine(self) -> str | None:
        """The engine that would serve the next request, or None if voiceless."""
        if self.resolve_piper() is not None:
            return "piper"
        if system_tts_available(self._platform):
            return "system"
        return None

    def synthesize_to_wav(self, text: str, wav_path: Path, length_scale: float | None = None) -> str:
        clean = text.strip()
        if not clean:
            raise ValueError("Cannot synthesize empty text.")
        wav_path.parent.mkdir(parents=True, exist_ok=True)

        voice = self.resolve_piper()
        if voice is not None:
            command = build_piper_command(voice, wav_path, length_scale or self._default_length_scale)
            debug(f"piper synth command={command[0]} chars={len(clean)}")
            completed = subprocess.run(
                command,
                input=clean.encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=_SYNTH_TIMEOUT_SECONDS,
                check=False,
            )
            if completed.returncode == 0 and wav_path.is_file() and wav_path.stat().st_size > 0:
                return "piper"
            stderr = completed.stderr.decode("utf-8", errors="replace").strip()
            debug(f"piper synth failed code={completed.returncode} stderr={stderr[:200]}")
            # Fall through to system TTS rather than leaving the turn silent.

        command = build_system_tts_command(clean, wav_path, self._platform)
        if command is None:
            raise RuntimeError(
                "No offline text-to-speech engine is available. Install Piper "
                "(models/piper in config.json) or a system voice (espeak-ng on Linux)."
            )
        debug(f"system tts command={command[0]} chars={len(clean)}")
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=_SYNTH_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not wav_path.is_file() or wav_path.stat().st_size == 0:
            stderr = completed.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"System text-to-speech failed: {stderr or f'exit code {completed.returncode}'}")
        return "system"
