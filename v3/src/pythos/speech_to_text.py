"""Hybrid speech-to-text: streaming Gradium cloud STT with a local Vosk fallback.

Engine choice happens per turn behind the network-state detector
(:class:`~pythos.voice_mode.VoiceModeReporter`):

- **Online + API key** — mic audio streams to Gradium STT over WebSocket for
  both wake-word spotting and dictation (highest quality, semantic VAD).
- **Offline / no key** — the same mic loop drives the on-device Vosk
  recognizer (restored from this repo's pre-Gradium history), so the demo
  keeps hearing you when Wi-Fi dies. Wake word matching runs on transcripts
  in both engines, so behavior is identical.
- **Mid-turn drop** — a Gradium stream that dies with a network error swaps
  to Vosk for the same session without surfacing an error; the HUD flips to
  "Voice: Local (offline)" via the ``voice_mode`` event.

The Gemma brain is local either way and never notices the swap.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import math
import threading
import time
from typing import Callable

import numpy as np

from .config import WorkerConfig
from .debug_log import debug
from .local_voice import contains_wake_word
from .network_monitor import is_network_error
from .protocol import JsonlWriter
from .voice_mode import VoiceModeReporter


class SpeechListener:
    def __init__(self, config: WorkerConfig, events: JsonlWriter, reporter: VoiceModeReporter) -> None:
        self._config = config
        self._events = events
        self._reporter = reporter
        self._local_stt = reporter.local_stt
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()
        self._active_mode: str | None = None
        self._state = "idle"
        self._request_id = 0
        self._preload_thread: threading.Thread | None = None

    def preload(self) -> None:
        if self._preload_thread and self._preload_thread.is_alive():
            debug("preload requested while preload thread is already alive")
            return
        debug("preload thread starting")
        self._preload_thread = threading.Thread(target=self._preload_models, daemon=True)
        self._preload_thread.start()

    def preload_blocking(self) -> None:
        # Startup must stay fast, so even the "blocking" entry point only
        # kicks the model warm-up onto a daemon thread; loading the Vosk
        # model can take seconds and the app is fully usable without it.
        debug("preload requested (delegating to background thread)")
        self.preload()

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
        # Warm the offline recognizer whenever it may serve the next turn
        # (no API key or currently offline), so the first local turn does not
        # pay the multi-second Vosk model load.
        try:
            if self._reporter.decide() == "local" and self._local_stt.available:
                debug("preload warming Vosk model for local voice mode")
                self._local_stt.preload()
                debug("preload Vosk model ready")
            else:
                debug("preload no-op (Gradium streaming mode or Vosk model not installed)")
        except Exception as exc:
            debug(f"preload error: {exc}")
            self._events.emit("error", source="model-preload", message=str(exc))

    # -- microphone turns -----------------------------------------------------

    def _listen_once(self, stop_event: threading.Event) -> None:
        try:
            import pyaudio

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
                self._run_transcription_turn(stream.read, stop_event)
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
                detected = self._run_wake_turn(stream.read, stop_event)
                if detected and not stop_event.is_set():
                    debug(f"wakeword detected word={self._config.audio.wake_word}; listening")
                    self._set_active_mode("listening", stop_event)
                    self._emit_state("listening", stop_event)
                    self._run_transcription_turn(stream.read, stop_event)
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

    # -- engine selection ------------------------------------------------------

    def _run_transcription_turn(self, read: Callable[..., bytes], stop_event: threading.Event) -> None:
        """Transcribe one listening turn on the current engine.

        Gradium is tried first when the detector says the cloud voice is
        reachable; a mid-stream network failure falls back to the local Vosk
        engine for the same session instead of surfacing an error.
        """
        try:
            engine = self._reporter.refresh("listening turn")
            if engine == "gradium":
                try:
                    self._transcribe_gradium(read, stop_event)
                    return
                except Exception as exc:
                    if not self._should_fall_back(exc, stop_event):
                        raise
                    debug(f"gradium stt failed mid-turn; swapping to local vosk: {exc}")
                    self._reporter.note_network_failure("speech recognition")
                    self._emit_state("listening", stop_event)
            self._transcribe_local(read, stop_event)
        except Exception as exc:
            debug(f"transcription turn error: {exc}")
            if self._is_current_stop_event(stop_event):
                self._events.emit("state", value="error")
                self._events.emit("error", source="asr", message=str(exc))
        finally:
            self._emit_state("idle", stop_event)

    def _run_wake_turn(self, read: Callable[..., bytes], stop_event: threading.Event) -> bool:
        """Wait for the wake word on the current engine (with fallback)."""
        engine = self._reporter.refresh("wake word turn")
        if engine == "gradium":
            try:
                return asyncio.run(self._detect_wake_word_async(read, stop_event))
            except Exception as exc:
                if not self._should_fall_back(exc, stop_event):
                    raise
                debug(f"gradium wakeword failed mid-turn; swapping to local vosk: {exc}")
                self._reporter.note_network_failure("wake word detection")
                self._emit_state("wakeword", stop_event)
        return self._wait_for_wake_word_local(read, stop_event)

    def _should_fall_back(self, exc: BaseException, stop_event: threading.Event) -> bool:
        return (
            is_network_error(exc)
            and self._local_stt.available
            and self._is_current_stop_event(stop_event)
            and not stop_event.is_set()
        )

    # -- local (Vosk) engine ----------------------------------------------------

    def _transcribe_local(self, read: Callable[..., bytes], stop_event: threading.Event) -> None:
        if not self._local_stt.available:
            raise RuntimeError(self._local_stt.install_hint())
        final = self._local_stt.transcribe_stream(
            read,
            stop_event.is_set,
            on_partial=lambda text: self._emit_partial(text, stop_event),
            on_level=self._emit_audio_level,
        )
        if final and self._is_current_stop_event(stop_event):
            debug(f"local final transcript text={final!r}")
            self._events.emit("final_transcript", text=final)
        elif not final:
            debug("local stt produced no transcript")

    def _wait_for_wake_word_local(self, read: Callable[..., bytes], stop_event: threading.Event) -> bool:
        if not self._local_stt.available:
            raise RuntimeError(self._local_stt.install_hint())
        return self._local_stt.wait_for_wake_word(
            read,
            stop_event.is_set,
            self._config.audio.wake_word,
            on_level=self._emit_audio_level,
        )

    def _emit_partial(self, text: str, stop_event: threading.Event) -> None:
        if self._is_current_stop_event(stop_event):
            self._events.emit("partial_transcript", text=text)

    def _emit_audio_level(self, data: bytes) -> None:
        self._events.emit("audio_level", value=_rms_level(data))

    # -- Gradium (cloud) engine --------------------------------------------------

    async def _detect_wake_word_async(
        self, read: Callable[..., bytes], stop_event: threading.Event
    ) -> bool:
        """Stream mic audio to Gradium STT until the wake word is transcribed.

        Returns True when the configured wake word is heard, or False if the
        listener was stopped first. Network failures propagate to the caller,
        which decides whether to swap to the local engine.
        """
        import websockets

        cfg = self._config.gradium
        url = f"{cfg.base_ws_url}/speech/asr"
        setup = {
            "type": "setup",
            "model_name": cfg.stt_model,
            "input_format": cfg.stt_input_format,
        }
        loop = asyncio.get_event_loop()
        chunk = self._config.audio.chunk
        wake_word = self._config.audio.wake_word
        detected = asyncio.Event()
        segments: list[str] = []

        debug(f"gradium wakeword connecting url={url} word={wake_word!r}")
        async with websockets.connect(url, additional_headers={"x-api-key": cfg.api_key}) as ws:
            await ws.send(json.dumps(setup))
            ready = json.loads(await ws.recv())
            if ready.get("type") != "ready":
                raise RuntimeError(f"Unexpected STT handshake response: {ready}")

            async def producer() -> None:
                while not stop_event.is_set() and not detected.is_set():
                    data = await loop.run_in_executor(
                        None, lambda: read(chunk, exception_on_overflow=False)
                    )
                    self._emit_audio_level(data)
                    await ws.send(
                        json.dumps({"type": "audio", "audio": base64.b64encode(data).decode()})
                    )
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({"type": "end_of_stream"}))

            async def consumer() -> None:
                async for raw in ws:
                    if stop_event.is_set():
                        return
                    msg = json.loads(raw)
                    kind = msg.get("type")
                    if kind == "text":
                        text = str(msg.get("text", "")).strip()
                        if text:
                            segments.append(text)
                            heard = " ".join(segments)
                            if contains_wake_word(heard, wake_word):
                                debug(f"gradium wakeword matched in transcript={heard!r}")
                                detected.set()
                                return
                    elif kind == "step":
                        # A completed phrase without the wake word: drop stale text so
                        # matching stays anchored to what is currently being said.
                        vad = msg.get("vad") or []
                        idx = cfg.vad_horizon_index
                        if (
                            segments
                            and len(vad) > idx
                            and float(vad[idx].get("inactivity_prob", 0.0))
                            > cfg.vad_inactivity_threshold
                        ):
                            segments.clear()
                    elif kind == "end_of_stream":
                        return
                    elif kind == "error":
                        raise RuntimeError(msg.get("message", "Gradium STT error"))

            await asyncio.gather(producer(), consumer())

        return detected.is_set()

    def _transcribe_gradium(self, read: Callable[..., bytes], stop_event: threading.Event) -> None:
        """Stream one listening turn to Gradium STT (errors propagate)."""
        asyncio.run(self._transcribe_async(read, stop_event))

    async def _transcribe_async(self, read: Callable[..., bytes], stop_event: threading.Event) -> None:
        import websockets

        cfg = self._config.gradium
        url = f"{cfg.base_ws_url}/speech/asr"
        setup = {
            "type": "setup",
            "model_name": cfg.stt_model,
            "input_format": cfg.stt_input_format,
        }
        loop = asyncio.get_event_loop()
        chunk = self._config.audio.chunk
        started = time.time()
        turn_done = asyncio.Event()
        segments: list[str] = []
        last_partial = ""

        debug(f"gradium stt connecting url={url} format={cfg.stt_input_format}")
        async with websockets.connect(url, additional_headers={"x-api-key": cfg.api_key}) as ws:
            await ws.send(json.dumps(setup))
            ready = json.loads(await ws.recv())
            if ready.get("type") != "ready":
                raise RuntimeError(f"Unexpected STT handshake response: {ready}")

            async def producer() -> None:
                while not stop_event.is_set() and not turn_done.is_set():
                    data = await loop.run_in_executor(
                        None, lambda: read(chunk, exception_on_overflow=False)
                    )
                    self._emit_audio_level(data)
                    await ws.send(
                        json.dumps({"type": "audio", "audio": base64.b64encode(data).decode()})
                    )
                    if time.time() - started > self._config.audio.asr_timeout_seconds:
                        debug("gradium stt ASR timeout")
                        break
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({"type": "end_of_stream"}))

            async def consumer() -> None:
                nonlocal last_partial
                silence_started: float | None = None
                async for raw in ws:
                    msg = json.loads(raw)
                    kind = msg.get("type")
                    if kind == "text":
                        text = str(msg.get("text", "")).strip()
                        if text:
                            segments.append(text)
                            partial = " ".join(segments).strip()
                            if partial and partial != last_partial:
                                last_partial = partial
                                debug(f"gradium partial text={partial!r}")
                                self._emit_partial(partial, stop_event)
                            # New speech arrived; cancel any pending end-of-turn.
                            silence_started = None
                    elif kind == "step":
                        vad = msg.get("vad") or []
                        idx = cfg.vad_horizon_index
                        inactive = (
                            segments
                            and len(vad) > idx
                            and float(vad[idx].get("inactivity_prob", 0.0))
                            > cfg.vad_inactivity_threshold
                        )
                        if inactive:
                            now = time.monotonic()
                            if silence_started is None:
                                silence_started = now
                            if now - silence_started >= cfg.vad_min_silence_seconds:
                                debug(
                                    "gradium stt end-of-turn via semantic VAD "
                                    f"after {now - silence_started:.2f}s silence"
                                )
                                turn_done.set()
                                return
                        else:
                            # Speech resumed (or never paused); reset the silence timer.
                            silence_started = None
                    elif kind == "end_of_stream":
                        return
                    elif kind == "error":
                        raise RuntimeError(msg.get("message", "Gradium STT error"))

            await asyncio.gather(producer(), consumer())

        final = " ".join(segments).strip()
        if final and self._is_current_stop_event(stop_event):
            debug(f"gradium final transcript text={final!r}")
            self._events.emit("final_transcript", text=final)
        elif not final:
            debug("gradium stt produced no transcript")


def _rms_level(audio_bytes: bytes) -> float:
    if not audio_bytes:
        return 0.0
    samples = np.frombuffer(audio_bytes, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    rms = math.sqrt(float(np.mean(np.square(samples.astype(np.float64)))))
    return min(1.0, rms / 32768.0)
