from __future__ import annotations

import json
import math
from pathlib import Path
import threading
import time
from typing import Any, Callable

import numpy as np

from .config import WorkerConfig
from .debug_log import debug
from .protocol import JsonlWriter


class SpeechListener:
    def __init__(self, config: WorkerConfig, events: JsonlWriter) -> None:
        self._config = config
        self._events = events
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()
        self._active_mode: str | None = None
        self._state = "idle"
        self._request_id = 0
        self._preload_thread: threading.Thread | None = None
        self._wake_model_lock = threading.Lock()
        self._vosk_model_lock = threading.Lock()
        self._wake_model: Any | None = None
        self._vosk_model: Any | None = None

    def preload(self) -> None:
        if self._preload_thread and self._preload_thread.is_alive():
            debug("preload requested while preload thread is already alive")
            return
        debug("preload thread starting")
        self._preload_thread = threading.Thread(target=self._preload_models, daemon=True)
        self._preload_thread.start()

    def preload_blocking(self) -> None:
        debug("blocking preload starting")
        self._preload_models()

    def start(self) -> None:
        debug("start PTT requested")
        self._start_thread(self._listen_once, "listening")

    def start_wakeword(self) -> None:
        debug("start wakeword requested")
        self._start_thread(self._wakeword_once, "wakeword")

    def _start_thread(self, target: Callable[[threading.Event], None], mode: str) -> None:
        with self._thread_lock:
            current_alive = bool(self._thread and self._thread.is_alive())
            debug(
                f"start_thread mode={mode} current_alive={current_alive} "
                f"active_mode={self._active_mode} request_id={self._request_id}"
            )
            if self._thread and self._thread.is_alive():
                if self._active_mode == mode:
                    debug(f"start_thread ignored because mode already active: {mode}; state={self._state}")
                    self._events.emit("state", value=self._state)
                    return
                self._request_id += 1
                request_id = self._request_id
                previous = self._thread
                self._stop.set()
                debug(
                    f"switching listener from {self._active_mode} to {mode}; "
                    f"request_id={request_id}"
                )
                self._events.emit("state", value="loading")
                threading.Thread(
                    target=self._restart_after_stop,
                    args=(previous, target, mode, request_id),
                    daemon=True,
                ).start()
                return

            self._request_id += 1
            debug(f"starting listener mode={mode} request_id={self._request_id}")
            self._events.emit("state", value="loading")
            self._begin_thread_locked(target, mode)

    def _restart_after_stop(
        self,
        previous: threading.Thread,
        target: Callable[[threading.Event], None],
        mode: str,
        request_id: int,
    ) -> None:
        debug(f"waiting for previous listener to stop before mode={mode} request_id={request_id}")
        previous.join(timeout=1.5)
        debug(
            f"previous listener join complete alive={previous.is_alive()} "
            f"for mode={mode} request_id={request_id}"
        )
        with self._thread_lock:
            if request_id != self._request_id:
                debug(
                    f"restart cancelled for mode={mode}; stale request_id={request_id} "
                    f"current={self._request_id}"
                )
                return
            self._begin_thread_locked(target, mode)

    def _begin_thread_locked(self, target: Callable[[threading.Event], None], mode: str) -> None:
        stop_event = threading.Event()
        self._stop = stop_event
        self._active_mode = mode
        self._state = "loading"
        self._thread = threading.Thread(target=self._run_target, args=(target, stop_event), daemon=True)
        debug(f"listener thread created mode={mode} thread_id={id(self._thread)}")
        self._thread.start()

    def stop(self) -> None:
        with self._thread_lock:
            self._request_id += 1
            debug(
                f"stop requested active_mode={self._active_mode} "
                f"thread_alive={bool(self._thread and self._thread.is_alive())} "
                f"request_id={self._request_id}"
            )
            self._active_mode = None
            self._state = "idle"
            self._stop.set()
        self._events.emit("state", value="idle")

    def _run_target(self, target: Callable[[threading.Event], None], stop_event: threading.Event) -> None:
        debug(f"listener target entering thread={threading.current_thread().name}")
        try:
            target(stop_event)
        finally:
            current = threading.current_thread()
            with self._thread_lock:
                if self._thread is current:
                    debug("listener target finished; clearing active thread")
                    self._thread = None
                    self._active_mode = None
                else:
                    debug("listener target finished but was no longer current")

    def _is_current_stop_event(self, stop_event: threading.Event) -> bool:
        with self._thread_lock:
            return self._stop is stop_event

    def _emit_state(self, value: str, stop_event: threading.Event) -> None:
        if self._is_current_stop_event(stop_event):
            with self._thread_lock:
                self._state = value
            self._events.emit("state", value=value)
        else:
            debug(f"skipped stale state={value}")

    def _set_active_mode(self, value: str, stop_event: threading.Event) -> None:
        if not self._is_current_stop_event(stop_event):
            return
        with self._thread_lock:
            self._active_mode = value

    def _preload_models(self) -> None:
        try:
            started = time.perf_counter()
            debug("preload loading Vosk model")
            self._get_vosk_model()
            debug("preload loading wake model")
            self._get_wake_model()
            debug(f"preload complete elapsed={time.perf_counter() - started:.2f}s")
        except Exception as exc:
            debug(f"preload error: {exc}")
            self._events.emit("error", source="model-preload", message=str(exc))

    def _listen_once(self, stop_event: threading.Event) -> None:
        try:
            import pyaudio
            import vosk

            vosk.SetLogLevel(-1)
            debug("PTT creating recognizer")
            recognizer = vosk.KaldiRecognizer(self._get_vosk_model(), self._config.audio.rate)
            if stop_event.is_set():
                debug("PTT cancelled before microphone open")
                self._emit_state("idle", stop_event)
                return
            audio = pyaudio.PyAudio()
            debug("PTT opening microphone stream")
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=self._config.audio.channels,
                rate=self._config.audio.rate,
                input=True,
                frames_per_buffer=self._config.audio.chunk,
            )
            try:
                debug("PTT state=listening")
                self._emit_state("listening", stop_event)
                self._listen_stream(stream.read, recognizer, stop_event)
            finally:
                debug("PTT closing microphone stream")
                stream.stop_stream()
                stream.close()
                audio.terminate()
        except Exception as exc:
            debug(f"PTT error: {exc}")
            if self._is_current_stop_event(stop_event):
                self._events.emit("state", value="error")
                self._events.emit("error", source="asr", message=str(exc))

    def _wakeword_once(self, stop_event: threading.Event) -> None:
        try:
            import pyaudio
            import vosk

            vosk.SetLogLevel(-1)
            debug("wakeword getting wake model")
            wake_model = self._get_wake_model()
            if hasattr(wake_model, "reset"):
                wake_model.reset()
                debug("wakeword model reset")
            debug("wakeword creating recognizer")
            recognizer = vosk.KaldiRecognizer(self._get_vosk_model(), self._config.audio.rate)
            if stop_event.is_set():
                debug("wakeword cancelled before microphone open")
                self._emit_state("idle", stop_event)
                return
            audio = pyaudio.PyAudio()
            debug("wakeword opening microphone stream")
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=self._config.audio.channels,
                rate=self._config.audio.rate,
                input=True,
                frames_per_buffer=self._config.audio.chunk,
            )
            try:
                debug("wakeword state=wakeword")
                self._emit_state("wakeword", stop_event)
                while not stop_event.is_set():
                    data = stream.read(self._config.audio.chunk, exception_on_overflow=False)
                    self._events.emit("audio_level", value=_rms_level(data))
                    samples = np.frombuffer(data, dtype=np.int16)
                    prediction = wake_model.predict(samples)
                    score = float(prediction.get(self._config.audio.wake_word, 0.0))
                    if score >= self._config.audio.wake_threshold:
                        debug(
                            f"wakeword detected word={self._config.audio.wake_word} "
                            f"score={score:.3f} threshold={self._config.audio.wake_threshold}"
                        )
                        recognizer.Reset()
                        self._set_active_mode("listening", stop_event)
                        self._emit_state("listening", stop_event)
                        self._listen_stream(stream.read, recognizer, stop_event)
                        return
                debug("wakeword stop_event set; returning idle")
                self._emit_state("idle", stop_event)
            finally:
                debug("wakeword closing microphone stream")
                stream.stop_stream()
                stream.close()
                audio.terminate()
        except Exception as exc:
            debug(f"wakeword error: {exc}")
            if self._is_current_stop_event(stop_event):
                self._events.emit("state", value="error")
                self._events.emit("error", source="wakeword", message=str(exc))

    def _get_vosk_model(self) -> Any:
        if self._vosk_model is not None:
            return self._vosk_model
        with self._vosk_model_lock:
            if self._vosk_model is None:
                import vosk

                vosk.SetLogLevel(-1)
                started = time.perf_counter()
                debug(f"loading Vosk model path={self._config.models.vosk}")
                self._vosk_model = vosk.Model(str(self._config.models.vosk))
                debug(f"loaded Vosk model elapsed={time.perf_counter() - started:.2f}s")
            return self._vosk_model

    def _get_wake_model(self) -> Any:
        if self._wake_model is not None:
            return self._wake_model
        with self._wake_model_lock:
            if self._wake_model is None:
                debug("importing openwakeword Model")
                from openwakeword.model import Model

                debug("validating openwakeword resources")
                _validate_openwakeword_resources()
                started = time.perf_counter()
                debug(f"loading wake model path={self._config.models.wake_word}")
                self._wake_model = Model(
                    wakeword_models=[str(self._config.models.wake_word)],
                    inference_framework="onnx",
                )
                debug(f"loaded wake model elapsed={time.perf_counter() - started:.2f}s")
            return self._wake_model

    def _listen_stream(
        self,
        read: Callable[..., bytes],
        recognizer: object,
        stop_event: threading.Event,
    ) -> None:
        started = time.time()
        last_speech = time.time()
        last_partial = ""

        while not stop_event.is_set():
            data = read(self._config.audio.chunk, exception_on_overflow=False)
            self._events.emit("audio_level", value=_rms_level(data))

            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                text = result.get("text", "").strip()
                if text:
                    debug(f"final transcript accepted text={text!r}")
                    if self._is_current_stop_event(stop_event):
                        self._events.emit("final_transcript", text=text)
                    self._emit_state("idle", stop_event)
                    return
                last_speech = time.time()
            else:
                partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
                if partial and partial != last_partial:
                    last_partial = partial
                    last_speech = time.time()
                    debug(f"partial transcript text={partial!r}")
                    if self._is_current_stop_event(stop_event):
                        self._events.emit("partial_transcript", text=partial)

            if time.time() - started > self._config.audio.asr_timeout_seconds:
                debug("listen stream ASR timeout")
                self._emit_state("idle", stop_event)
                return

            if time.time() - last_speech > self._config.audio.silence_timeout_seconds:
                final = json.loads(recognizer.FinalResult()).get("text", "").strip()
                if final:
                    debug(f"final transcript after silence text={final!r}")
                    if self._is_current_stop_event(stop_event):
                        self._events.emit("final_transcript", text=final)
                else:
                    debug("listen stream silence timeout without final transcript")
                self._emit_state("idle", stop_event)
                return

        debug("listen stream stop_event set")
        self._emit_state("idle", stop_event)


def _rms_level(audio_bytes: bytes) -> float:
    if not audio_bytes:
        return 0.0
    samples = np.frombuffer(audio_bytes, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    rms = math.sqrt(float(np.mean(np.square(samples.astype(np.float64)))))
    return min(1.0, rms / 32768.0)


def _validate_openwakeword_resources() -> None:
    import openwakeword

    model_dir = openwakeword.FEATURE_MODELS["melspectrogram"]["model_path"]
    resource_dir = Path(model_dir).parent
    required = ["melspectrogram.onnx", "embedding_model.onnx"]
    missing = [name for name in required if not (resource_dir / name).exists()]
    if missing:
        raise FileNotFoundError(
            "OpenWakeWord runtime resources are missing from the venv: "
            + ", ".join(missing)
            + f". Expected them in {resource_dir}."
        )
