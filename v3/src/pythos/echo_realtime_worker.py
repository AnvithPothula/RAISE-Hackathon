from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import time
from typing import Any

import numpy as np

from .config import load_config, validate_model_paths
from .debug_log import debug
from .protocol import JsonlWriter, parse_command
from .speech_to_text import _validate_openwakeword_resources


class EchoRealtimeListener:
    def __init__(self, config_path: str | None) -> None:
        self.events = JsonlWriter()
        self.config = load_config(config_path)
        self.state = "loading"
        self.last_partial = ""
        self.last_speech = time.time()
        self.listen_started = time.time()
        self._load_models()
        self.state = "wakeword"
        self.events.emit("state", value=self.state)

    def _load_models(self) -> None:
        missing = validate_model_paths(self.config)
        if missing:
            self.events.emit("error", source="config", message="Missing model paths", missing=missing)
        import vosk
        from openwakeword.model import Model

        vosk.SetLogLevel(-1)
        debug(f"echo realtime loading Vosk model path={self.config.models.vosk}")
        self.vosk_model = vosk.Model(str(self.config.models.vosk))
        debug("echo realtime validating openwakeword resources")
        _validate_openwakeword_resources()
        debug(f"echo realtime loading wake model path={self.config.models.wake_word}")
        self.wake_model = Model(
            wakeword_models=[str(self.config.models.wake_word)],
            inference_framework="onnx",
        )
        self.recognizer = vosk.KaldiRecognizer(self.vosk_model, self.config.audio.rate)

    def reset_to_wakeword(self) -> None:
        if hasattr(self.wake_model, "reset"):
            self.wake_model.reset()
        self.recognizer.Reset()
        self.last_partial = ""
        self.state = "wakeword"
        self.events.emit("state", value=self.state)

    def manual_wake(self) -> None:
        self._start_listening("manual")

    def accept_audio(self, audio: bytes) -> None:
        self.events.emit("audio_level", value=_rms_level(audio))
        if self.state == "wakeword":
            self._accept_wakeword(audio)
            return
        if self.state == "listening":
            self._accept_speech(audio)

    def _accept_wakeword(self, audio: bytes) -> None:
        samples = np.frombuffer(audio, dtype=np.int16)
        if samples.size == 0:
            return
        prediction = self.wake_model.predict(samples)
        score = float(prediction.get(self.config.audio.wake_word, 0.0))
        if score >= self.config.audio.wake_threshold:
            self.events.emit("wake", word=self.config.audio.wake_word, score=score)
            self._start_listening("wakeword")

    def _start_listening(self, source: str) -> None:
        self.recognizer.Reset()
        self.last_partial = ""
        now = time.time()
        self.last_speech = now
        self.listen_started = now
        self.state = "listening"
        self.events.emit("state", value=self.state, source=source)

    def _accept_speech(self, audio: bytes) -> None:
        if self.recognizer.AcceptWaveform(audio):
            result = json.loads(self.recognizer.Result())
            text = str(result.get("text", "")).strip()
            if text:
                self.events.emit("final_transcript", text=text)
                self.reset_to_wakeword()
                return
            self.last_speech = time.time()
        else:
            partial = str(json.loads(self.recognizer.PartialResult()).get("partial", "")).strip()
            if partial and partial != self.last_partial:
                self.last_partial = partial
                self.last_speech = time.time()
                self.events.emit("partial_transcript", text=partial)

        now = time.time()
        if now - self.listen_started > self.config.audio.asr_timeout_seconds:
            self._emit_final_or_reset("timeout")
        elif now - self.last_speech > self.config.audio.silence_timeout_seconds:
            self._emit_final_or_reset("silence")

    def _emit_final_or_reset(self, reason: str) -> None:
        final = str(json.loads(self.recognizer.FinalResult()).get("text", "")).strip()
        if final:
            self.events.emit("final_transcript", text=final, reason=reason)
        else:
            self.events.emit("state", value="wakeword", reason=reason)
        self.reset_to_wakeword()


def main() -> int:
    parser = argparse.ArgumentParser(description="Echo realtime wake word and ASR worker")
    parser.add_argument("--config", default=None)
    args = parser.parse_args()

    try:
        listener = EchoRealtimeListener(args.config)
    except Exception as exc:
        debug(f"echo realtime startup error: {exc}")
        JsonlWriter().emit("error", source="startup", message=str(exc))
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            command = parse_command(line)
            command_type = command["type"]
            if command_type == "audio":
                data = base64.b64decode(str(command.get("data", "")))
                listener.accept_audio(data)
            elif command_type == "wake":
                listener.manual_wake()
            elif command_type == "reset":
                listener.reset_to_wakeword()
            elif command_type == "shutdown":
                listener.events.emit("state", value="shutdown")
                return 0
            else:
                listener.events.emit("error", source="protocol", message=f"Unknown command: {command_type}")
        except Exception as exc:
            debug(f"echo realtime protocol error: {exc}")
            listener.events.emit("error", source="protocol", message=str(exc))

    return 0


def _rms_level(audio_bytes: bytes) -> float:
    if not audio_bytes:
        return 0.0
    samples = np.frombuffer(audio_bytes, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    rms = math.sqrt(float(np.mean(np.square(samples.astype(np.float64)))))
    return min(1.0, rms / 32768.0)


if __name__ == "__main__":
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    raise SystemExit(main())
