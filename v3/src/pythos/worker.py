from __future__ import annotations

import argparse
import os
import sys

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

from .config import load_config, validate_model_paths
from .debug_log import debug
from .local_voice import LocalSttSettings, LocalSynthesizer, VoskTranscriber
from .network_monitor import NetworkMonitor
from .protocol import JsonlWriter, parse_command
from .speech_to_text import SpeechListener
from .text_to_speech import HybridSpeaker
from .voice_mode import VoiceModeReporter


def main() -> int:
    parser = argparse.ArgumentParser(description="Pythos v3 JSONL worker")
    parser.add_argument("--config", default=None)
    args = parser.parse_args()

    events = JsonlWriter()
    try:
        debug(f"startup config={args.config}")
        config = load_config(args.config)
        missing = validate_model_paths(config)
        if missing:
            debug(f"missing model paths count={len(missing)}")
            events.emit("error", source="config", message="Missing model paths", missing=missing)

        # Hybrid voice pipeline: Gradium cloud voice when an API key is set and
        # the network is up; local Vosk STT + Piper/system TTS otherwise. A
        # missing key is NOT an error anymore — it just means local voice mode
        # (the zero-setup default). The Gemma brain is local either way.
        network = NetworkMonitor.for_gradium(config.gradium.base_ws_url)
        local_stt = VoskTranscriber(
            config.models.vosk,
            LocalSttSettings(
                chunk=config.audio.chunk,
                rate=config.audio.rate,
                asr_timeout_seconds=config.audio.asr_timeout_seconds,
                silence_timeout_seconds=config.audio.silence_timeout_seconds,
            ),
        )
        local_tts = LocalSynthesizer(
            config.models.piper_executable,
            config.models.piper_model,
            config.models.piper_config,
            default_length_scale=config.audio.tts_length_scale,
        )
        reporter = VoiceModeReporter(config, events, network, local_stt, local_tts)
        if not config.gradium.is_configured:
            debug("GRADIUM_API_KEY missing; voice runs fully local (Vosk/Piper/system)")

        listener = SpeechListener(config, events, reporter)
        speaker = HybridSpeaker(config, events, reporter)
        events.emit("state", value="loading", lowResourceMode=config.low_resource_mode)
        debug("state loading emitted; announcing voice mode and warming audio models")
        reporter.refresh("startup", force=True)
        listener.preload_blocking()
        events.emit("state", value="idle", lowResourceMode=config.low_resource_mode)
        debug("state idle emitted; audio pipeline ready")
    except Exception as exc:
        debug(f"startup error: {exc}")
        events.emit("error", source="startup", message=str(exc))
        return 1

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            command = parse_command(line)
            command_type = command["type"]
            debug(f"command received type={command_type}")
            if command_type == "start_listening":
                listener.start()
            elif command_type == "start_wakeword":
                listener.start_wakeword()
            elif command_type == "stop_listening":
                listener.stop()
            elif command_type == "speak":
                speaker.speak_async(
                    str(command.get("text", "")),
                    length_scale=command.get("lengthScale"),
                )
            elif command_type == "stop_speaking":
                speaker.stop()
            elif command_type == "shutdown":
                debug("shutdown command received")
                listener.stop()
                speaker.stop()
                events.emit("state", value="shutdown")
                return 0
            else:
                debug(f"unknown command: {command_type}")
                events.emit("error", source="protocol", message=f"Unknown command: {command_type}")
        except Exception as exc:
            debug(f"protocol error: {exc}")
            events.emit("error", source="protocol", message=str(exc))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
