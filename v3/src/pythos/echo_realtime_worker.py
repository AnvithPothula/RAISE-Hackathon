from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import math
import os
import sys
import threading
import time
from typing import Any

import numpy as np

from .config import WorkerConfig, load_config, validate_model_paths
from .debug_log import debug
from .protocol import JsonlWriter, parse_command
from .speech_to_text import _contains_wake_word


class GradiumPushTranscriber:
    """Push-based streaming transcriber for the Echo/Alexa bridge.

    Audio arrives from the device as discrete chunks (not a mic stream we can
    pull), so this owns a background asyncio loop and a per-turn Gradium STT
    WebSocket session. The main worker thread drives turn state and only ever
    calls the thread-safe ``open`` / ``send`` / ``poll`` / ``finalize`` / ``close``
    methods; all shared fields are guarded by a lock so no worker state is
    mutated from the background thread.
    """

    def __init__(self, config: WorkerConfig) -> None:
        self._cfg = config.gradium
        self._url = f"{self._cfg.base_ws_url}/speech/asr"
        self._lock = threading.Lock()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self._reset_state()

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _reset_state(self) -> None:
        with self._lock:
            self._segments: list[str] = []
            self._partial = ""
            self._turn_ended = False
            self._error: str | None = None
        self._ws: Any = None
        self._audio_queue: asyncio.Queue[bytes | None] | None = None
        self._tasks: list[asyncio.Task[Any]] = []
        self._ready = threading.Event()
        self._eos_done = threading.Event()

    # -- lifecycle -----------------------------------------------------------

    def open(self, timeout: float = 6.0) -> None:
        """Open a fresh STT session and block until the server is ready."""
        self.close()
        self._reset_state()
        asyncio.run_coroutine_threadsafe(self._open_async(), self._loop)
        if not self._ready.wait(timeout):
            raise RuntimeError("Timed out opening Gradium STT session")
        with self._lock:
            if self._error:
                raise RuntimeError(self._error)

    async def _open_async(self) -> None:
        import websockets

        try:
            queue: asyncio.Queue[bytes | None] = asyncio.Queue()
            ws = await websockets.connect(
                self._url, additional_headers={"x-api-key": self._cfg.api_key}
            )
            await ws.send(
                json.dumps(
                    {
                        "type": "setup",
                        "model_name": self._cfg.stt_model,
                        "input_format": self._cfg.stt_input_format,
                    }
                )
            )
            ready = json.loads(await ws.recv())
            if ready.get("type") != "ready":
                with contextlib.suppress(Exception):
                    await ws.close()
                raise RuntimeError(f"Unexpected STT handshake response: {ready}")
            self._ws = ws
            self._audio_queue = queue
            # Bind ws/queue as locals so a later session can never be driven by
            # these tasks (they operate only on the session they were created for).
            self._tasks = [
                self._loop.create_task(self._produce(ws, queue)),
                self._loop.create_task(self._consume(ws)),
            ]
            self._ready.set()
        except Exception as exc:  # noqa: BLE001 - surfaced to the worker thread
            with self._lock:
                self._error = str(exc)
            self._eos_done.set()
            self._ready.set()

    async def _produce(self, ws: Any, queue: asyncio.Queue[bytes | None]) -> None:
        while True:
            item = await queue.get()
            if item is None:
                with contextlib.suppress(Exception):
                    await ws.send(json.dumps({"type": "end_of_stream"}))
                return
            with contextlib.suppress(Exception):
                await ws.send(
                    json.dumps({"type": "audio", "audio": base64.b64encode(item).decode()})
                )

    async def _consume(self, ws: Any) -> None:
        try:
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "text":
                    text = str(msg.get("text", "")).strip()
                    if text:
                        with self._lock:
                            self._segments.append(text)
                            self._partial = " ".join(self._segments).strip()
                elif kind == "step":
                    vad = msg.get("vad") or []
                    idx = self._cfg.vad_horizon_index
                    if len(vad) > idx:
                        inactivity = float(vad[idx].get("inactivity_prob", 0.0))
                        if inactivity > self._cfg.vad_inactivity_threshold:
                            with self._lock:
                                if self._segments:
                                    self._turn_ended = True
                elif kind == "end_of_stream":
                    break
                elif kind == "error":
                    with self._lock:
                        self._error = str(msg.get("message", "Gradium STT error"))
                    break
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._error = self._error or str(exc)
        finally:
            self._eos_done.set()

    # -- per-turn driving (called from the worker thread) --------------------

    def send(self, pcm: bytes) -> None:
        queue = self._audio_queue
        if queue is None or not pcm:
            return
        self._loop.call_soon_threadsafe(queue.put_nowait, pcm)

    def poll(self) -> dict[str, Any]:
        with self._lock:
            return {"partial": self._partial, "turn_ended": self._turn_ended, "error": self._error}

    def finalize(self, timeout: float = 5.0) -> str:
        """Flush remaining audio, wait for the transcript to settle, return it."""
        queue = self._audio_queue
        if queue is not None:
            self._loop.call_soon_threadsafe(queue.put_nowait, None)
        self._eos_done.wait(timeout)
        with self._lock:
            return " ".join(self._segments).strip()

    def close(self) -> None:
        ws = self._ws
        tasks = self._tasks
        self._ws = None
        self._tasks = []
        self._audio_queue = None
        if ws is None and not tasks:
            return

        async def _cleanup() -> None:
            for task in tasks:
                task.cancel()
            if ws is not None:
                with contextlib.suppress(Exception):
                    await ws.close()

        with contextlib.suppress(Exception):
            asyncio.run_coroutine_threadsafe(_cleanup(), self._loop)


class EchoRealtimeListener:
    def __init__(self, config_path: str | None) -> None:
        self.events = JsonlWriter()
        self.config = load_config(config_path)
        self.state = "loading"
        self.last_partial = ""
        self.last_speech = time.time()
        self.listen_started = time.time()
        missing = validate_model_paths(self.config)
        if missing:
            self.events.emit("error", source="config", message="Missing model paths", missing=missing)
        # A single push transcriber drives both phases: it streams device audio to
        # Gradium STT to spot the wake word, then a fresh session captures the
        # command that follows.
        self.transcriber = GradiumPushTranscriber(self.config)
        if not self.config.gradium.is_configured:
            self.events.emit(
                "error",
                source="config",
                message="GRADIUM_API_KEY is not set. Export it before launching (see API_KEYS_SETUP.txt).",
            )
        else:
            self._open_wake_session()
        self.state = "wakeword"
        self.events.emit("state", value=self.state)

    def _open_wake_session(self) -> None:
        """Open a fresh Gradium STT session for wake word detection."""
        if not self.config.gradium.is_configured:
            return
        try:
            self.transcriber.open()
        except Exception as exc:
            debug(f"echo realtime failed to open wake session: {exc}")
            self.events.emit("error", source="wakeword", message=str(exc))

    def reset_to_wakeword(self) -> None:
        self.last_partial = ""
        self.state = "wakeword"
        # Re-open the STT session so stale command audio never leaks into wake
        # detection (open() closes the previous session first).
        self._open_wake_session()
        self.events.emit("state", value=self.state)

    def manual_wake(self) -> None:
        self._start_listening("manual")

    def accept_audio(self, audio: bytes) -> None:
        # np.frombuffer(int16) requires an even byte count; drop a stray odd byte.
        if len(audio) % 2:
            audio = audio[:-1]
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
        self.transcriber.send(audio)
        status = self.transcriber.poll()

        if status["error"]:
            debug(f"echo realtime wake session error: {status['error']}")
            self._open_wake_session()
            return

        partial = str(status["partial"]).strip()
        if partial and _contains_wake_word(partial, self.config.audio.wake_word):
            self.events.emit("wake", word=self.config.audio.wake_word, score=1.0)
            self._start_listening("wakeword")
            return

        # A phrase completed without the wake word: refresh the session so the
        # transcript context stays bounded and matching tracks live speech.
        if status["turn_ended"]:
            self._open_wake_session()

    def _start_listening(self, source: str) -> None:
        if not self.config.gradium.is_configured:
            self.events.emit(
                "error", source="asr", message="GRADIUM_API_KEY is not set; cannot transcribe speech."
            )
            self.reset_to_wakeword()
            return
        try:
            self.transcriber.open()
        except Exception as exc:
            debug(f"echo realtime failed to open Gradium session: {exc}")
            self.events.emit("error", source="asr", message=str(exc))
            self.reset_to_wakeword()
            return
        self.last_partial = ""
        now = time.time()
        self.last_speech = now
        self.listen_started = now
        self.state = "listening"
        self.events.emit("state", value=self.state, source=source)

    def _accept_speech(self, audio: bytes) -> None:
        self.transcriber.send(audio)
        status = self.transcriber.poll()

        if status["error"]:
            self.events.emit("error", source="asr", message=str(status["error"]))
            self.reset_to_wakeword()
            return

        partial = str(status["partial"]).strip()
        now = time.time()
        if partial and partial != self.last_partial:
            self.last_partial = partial
            self.last_speech = now
            self.events.emit("partial_transcript", text=partial)

        if status["turn_ended"]:
            self._emit_final_or_reset("vad")
        elif now - self.listen_started > self.config.audio.asr_timeout_seconds:
            self._emit_final_or_reset("timeout")
        elif now - self.last_speech > self.config.audio.silence_timeout_seconds:
            self._emit_final_or_reset("silence")

    def _emit_final_or_reset(self, reason: str) -> None:
        final = self.transcriber.finalize()
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
                listener.transcriber.close()
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
