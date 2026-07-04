"""Voice-mode state shared by the STT listener and the TTS speaker.

One reporter instance is created by the worker and handed to both halves of
the voice pipeline. Before every turn (listening, wake word, or speaking) the
pipeline calls :meth:`VoiceModeReporter.refresh`, which decides the effective
engine — streaming Gradium cloud voice when an API key is set and the network
is up, the local Vosk/Piper stack otherwise — and emits a ``voice_mode``
worker event whenever the effective mode changes. The Electron renderer turns
those events into the demo HUD badge ("Voice: Gradium (cloud)" / "Voice:
Local (offline)").
"""

from __future__ import annotations

import threading
from typing import Any, Literal

from .config import WorkerConfig
from .debug_log import debug
from .local_voice import LocalSynthesizer, VoskTranscriber
from .network_monitor import NetworkMonitor
from .protocol import JsonlWriter

VoiceEngine = Literal["gradium", "local"]


class VoiceModeReporter:
    def __init__(
        self,
        config: WorkerConfig,
        events: JsonlWriter,
        network: NetworkMonitor,
        local_stt: VoskTranscriber,
        local_tts: LocalSynthesizer,
    ) -> None:
        self._config = config
        self._events = events
        self._network = network
        self._local_stt = local_stt
        self._local_tts = local_tts
        self._lock = threading.Lock()
        self._last_payload: dict[str, Any] | None = None

    @property
    def local_stt(self) -> VoskTranscriber:
        return self._local_stt

    @property
    def local_tts(self) -> LocalSynthesizer:
        return self._local_tts

    def decide(self) -> VoiceEngine:
        """The engine that should serve the next voice turn."""
        if not self._config.gradium.is_configured:
            return "local"
        if not self._network.is_online():
            return "local"
        return "gradium"

    def refresh(self, reason: str, *, force: bool = False) -> VoiceEngine:
        """Re-evaluate the mode and emit ``voice_mode`` if it changed.

        Returns the effective engine so callers can branch on it directly.
        The emitted payload always carries availability of the local engines,
        so the UI can distinguish "local voice ready" from "text-only".
        """
        engine = self.decide()
        online = engine == "gradium" or self._network.is_online()
        payload: dict[str, Any] = {
            "engine": engine,
            "online": online,
            "gradiumConfigured": self._config.gradium.is_configured,
            "stt": "gradium" if engine == "gradium" else ("vosk" if self._local_stt.available else "unavailable"),
            "tts": "gradium" if engine == "gradium" else (self._local_tts.engine or "unavailable"),
            "reason": reason,
        }

        with self._lock:
            changed = self._last_payload is None or {
                key: value for key, value in self._last_payload.items() if key != "reason"
            } != {key: value for key, value in payload.items() if key != "reason"}
            if changed or force:
                self._last_payload = payload
                should_emit = True
            else:
                should_emit = False

        if should_emit:
            debug(
                f"voice mode engine={payload['engine']} online={payload['online']} "
                f"stt={payload['stt']} tts={payload['tts']} reason={reason}"
            )
            self._events.emit("voice_mode", **payload)
        return engine

    def note_network_failure(self, source: str) -> None:
        """Record a mid-stream network failure and force a mode re-probe.

        Invalidating the monitor's cache makes the refresh below (and the
        next turn's) re-probe instead of trusting a stale "online" verdict,
        so the swap to the local engines is instant.
        """
        debug(f"voice mode network failure source={source}; invalidating probe cache")
        self._network.invalidate()
        self.refresh(f"network failure during {source}", force=True)
