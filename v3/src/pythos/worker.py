from __future__ import annotations

import argparse
import os
import sys

os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

from .config import load_config, validate_model_paths
from .debug_log import debug
from .protocol import JsonlWriter, parse_command
from .speech_to_text import SpeechListener
from .text_to_speech import GradiumSpeaker


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
        if not config.gradium.is_configured:
            debug("GRADIUM_API_KEY missing; speech-to-text and text-to-speech will be unavailable")
            events.emit(
                "error",
                source="config",
                message="GRADIUM_API_KEY is not set. Export it before launching (see API_KEYS_SETUP.txt).",
            )
        listener = SpeechListener(config, events)
        speaker = GradiumSpeaker(config, events)
        events.emit("state", value="loading", lowResourceMode=config.low_resource_mode)
        debug("state loading emitted; warming audio models")
        listener.preload_blocking()
        events.emit("state", value="idle", lowResourceMode=config.low_resource_mode)
        debug("state idle emitted; audio models ready")
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
