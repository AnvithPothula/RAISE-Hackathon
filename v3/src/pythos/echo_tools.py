from __future__ import annotations

import argparse
import json
import subprocess
import wave
from pathlib import Path

from .config import load_config
from .text_to_speech import sanitize_spoken_text


def main() -> int:
    parser = argparse.ArgumentParser(description="Echo bridge audio helpers")
    parser.add_argument("--config", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe_parser = subparsers.add_parser("transcribe", help="Transcribe a WAV file with Vosk")
    transcribe_parser.add_argument("--input", required=True)

    synth_parser = subparsers.add_parser("synthesize", help="Create a Piper WAV file")
    synth_parser.add_argument("--text", required=True)
    synth_parser.add_argument("--output", required=True)
    synth_parser.add_argument("--length-scale", type=float, default=None)

    args = parser.parse_args()
    config = load_config(args.config)

    if args.command == "transcribe":
      text = transcribe_wav(Path(args.input), config.models.vosk)
      print(json.dumps({"text": text}, ensure_ascii=True), flush=True)
      return 0

    if args.command == "synthesize":
      synthesize_wav(
          text=str(args.text),
          output=Path(args.output),
          piper_executable=config.models.piper_executable,
          piper_model=config.models.piper_model,
          piper_config=config.models.piper_config,
          length_scale=args.length_scale or config.audio.tts_length_scale,
      )
      print(json.dumps({"output": str(Path(args.output).resolve())}, ensure_ascii=True), flush=True)
      return 0

    return 1


def transcribe_wav(path: Path, model_path: Path) -> str:
    import vosk

    vosk.SetLogLevel(-1)
    model = vosk.Model(str(model_path))
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1:
            raise ValueError("Expected mono WAV from Echo node")
        if wav.getsampwidth() != 2:
            raise ValueError("Expected 16-bit PCM WAV from Echo node")
        recognizer = vosk.KaldiRecognizer(model, wav.getframerate())
        while True:
            data = wav.readframes(4000)
            if not data:
                break
            recognizer.AcceptWaveform(data)
        result = json.loads(recognizer.FinalResult())
    return str(result.get("text", "")).strip()


def synthesize_wav(
    *,
    text: str,
    output: Path,
    piper_executable: Path,
    piper_model: Path,
    piper_config: Path,
    length_scale: float,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(piper_executable),
        "-m",
        str(piper_model),
        "-c",
        str(piper_config),
        "-f",
        str(output),
        "--length_scale",
        str(length_scale),
    ]
    process = subprocess.run(
        command,
        input=sanitize_spoken_text(text).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr.decode("utf-8", errors="replace"))


if __name__ == "__main__":
    raise SystemExit(main())
