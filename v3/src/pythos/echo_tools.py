from __future__ import annotations

import argparse
import asyncio
import base64
import json
import wave
from pathlib import Path

from .config import GradiumConfig, load_config
from .text_to_speech import (
    gradium_tts_pcm,
    pcm_sample_rate,
    sanitize_spoken_text,
    write_wav_pcm,
)

# Raw-PCM input formats Gradium accepts, keyed by WAV sample rate.
_STT_PCM_FORMATS = {
    8000: "pcm_8000",
    16000: "pcm_16000",
    22050: "pcm_22050",
    24000: "pcm_24000",
    44100: "pcm_44100",
    48000: "pcm_48000",
}
_STT_CHUNK_BYTES = 2560  # 80 ms of 16 kHz 16-bit mono PCM


def main() -> int:
    parser = argparse.ArgumentParser(description="Echo bridge audio helpers")
    parser.add_argument("--config", default=None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe_parser = subparsers.add_parser("transcribe", help="Transcribe a WAV file with Gradium")
    transcribe_parser.add_argument("--input", required=True)

    synth_parser = subparsers.add_parser("synthesize", help="Create a WAV file with Gradium TTS")
    synth_parser.add_argument("--text", required=True)
    synth_parser.add_argument("--output", required=True)
    synth_parser.add_argument("--length-scale", type=float, default=None)

    args = parser.parse_args()
    config = load_config(args.config)

    if not config.gradium.is_configured:
        raise RuntimeError("GRADIUM_API_KEY is not set. Export it before launching (see API_KEYS_SETUP.txt).")

    if args.command == "transcribe":
      text = transcribe_wav(Path(args.input), config.gradium)
      print(json.dumps({"text": text}, ensure_ascii=True), flush=True)
      return 0

    if args.command == "synthesize":
      synthesize_wav(text=str(args.text), output=Path(args.output), cfg=config.gradium)
      print(json.dumps({"output": str(Path(args.output).resolve())}, ensure_ascii=True), flush=True)
      return 0

    return 1


def transcribe_wav(path: Path, cfg: GradiumConfig) -> str:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1:
            raise ValueError("Expected mono WAV from Echo node")
        if wav.getsampwidth() != 2:
            raise ValueError("Expected 16-bit PCM WAV from Echo node")
        framerate = wav.getframerate()
        pcm = wav.readframes(wav.getnframes())

    input_format = _STT_PCM_FORMATS.get(framerate)
    if input_format is None:
        # Unusual sample rate: hand the whole WAV to Gradium and let it parse.
        with path.open("rb") as handle:
            pcm = handle.read()
        input_format = "wav"

    return asyncio.run(_transcribe_async(cfg, pcm, input_format))


async def _transcribe_async(cfg: GradiumConfig, audio: bytes, input_format: str) -> str:
    import websockets

    url = f"{cfg.base_ws_url}/speech/asr"
    segments: list[str] = []

    async with websockets.connect(url, additional_headers={"x-api-key": cfg.api_key}) as ws:
        await ws.send(
            json.dumps({"type": "setup", "model_name": cfg.stt_model, "input_format": input_format})
        )
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Unexpected STT handshake response: {ready}")

        async def producer() -> None:
            for offset in range(0, len(audio), _STT_CHUNK_BYTES):
                chunk = audio[offset : offset + _STT_CHUNK_BYTES]
                await ws.send(json.dumps({"type": "audio", "audio": base64.b64encode(chunk).decode()}))
            await ws.send(json.dumps({"type": "end_of_stream"}))

        async def consumer() -> None:
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "text":
                    text = str(msg.get("text", "")).strip()
                    if text:
                        segments.append(text)
                elif kind == "end_of_stream":
                    return
                elif kind == "error":
                    raise RuntimeError(msg.get("message", "Gradium STT error"))

        await asyncio.gather(producer(), consumer())

    return " ".join(segments).strip()


def synthesize_wav(*, text: str, output: Path, cfg: GradiumConfig) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    pcm = asyncio.run(gradium_tts_pcm(cfg, sanitize_spoken_text(text)))
    write_wav_pcm(output, pcm, pcm_sample_rate(cfg))


if __name__ == "__main__":
    raise SystemExit(main())
