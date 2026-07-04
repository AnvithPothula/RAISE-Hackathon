"""One-shot STT/TTS helpers for the Echo/Android bridge, with offline fallback.

The Electron bridge shells out to this module to transcribe an uploaded WAV
and to synthesize a spoken reply. Engine selection matches the desktop voice
pipeline: Gradium cloud when an API key is set and the network is up, the
local Vosk/Piper/system stack otherwise — so a remote node round-trip keeps
working when the Wi-Fi (or just the cloud) is down. Results include the
engine used so the bridge can surface it in the UI.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import wave
from pathlib import Path

from .config import GradiumConfig, WorkerConfig, load_config
from .debug_log import debug
from .local_voice import LocalSttSettings, LocalSynthesizer, VoskTranscriber
from .network_monitor import NetworkMonitor, is_network_error
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

    transcribe_parser = subparsers.add_parser("transcribe", help="Transcribe a WAV file (Gradium or local Vosk)")
    transcribe_parser.add_argument("--input", required=True)

    synth_parser = subparsers.add_parser("synthesize", help="Create a WAV file (Gradium or local TTS)")
    synth_parser.add_argument("--text", required=True)
    synth_parser.add_argument("--output", required=True)
    synth_parser.add_argument("--length-scale", type=float, default=None)

    args = parser.parse_args()
    config = load_config(args.config)
    network = NetworkMonitor.for_gradium(config.gradium.base_ws_url)

    if args.command == "transcribe":
        text, engine = transcribe_wav(Path(args.input), config, network)
        print(json.dumps({"text": text, "engine": engine}, ensure_ascii=True), flush=True)
        return 0

    if args.command == "synthesize":
        engine = synthesize_wav(
            text=str(args.text),
            output=Path(args.output),
            config=config,
            network=network,
            length_scale=args.length_scale,
        )
        print(
            json.dumps({"output": str(Path(args.output).resolve()), "engine": engine}, ensure_ascii=True),
            flush=True,
        )
        return 0

    return 1


def _use_gradium(config: WorkerConfig, network: NetworkMonitor) -> bool:
    return config.gradium.is_configured and network.is_online()


def _local_transcriber(config: WorkerConfig) -> VoskTranscriber:
    return VoskTranscriber(
        config.models.vosk,
        LocalSttSettings(
            chunk=config.audio.chunk,
            rate=config.audio.rate,
            asr_timeout_seconds=config.audio.asr_timeout_seconds,
            silence_timeout_seconds=config.audio.silence_timeout_seconds,
        ),
    )


def _local_synthesizer(config: WorkerConfig) -> LocalSynthesizer:
    return LocalSynthesizer(
        config.models.piper_executable,
        config.models.piper_model,
        config.models.piper_config,
        default_length_scale=config.audio.tts_length_scale,
    )


def transcribe_wav(path: Path, config: WorkerConfig, network: NetworkMonitor) -> tuple[str, str]:
    """Transcribe a WAV upload; returns (text, engine)."""
    if _use_gradium(config, network):
        try:
            return transcribe_wav_gradium(path, config.gradium), "gradium"
        except Exception as exc:
            local = _local_transcriber(config)
            if not is_network_error(exc) or not local.available:
                raise
            debug(f"echo transcribe: gradium failed, falling back to local vosk: {exc}")
            network.invalidate()
            return local.transcribe_wav_file(path), "vosk"

    local = _local_transcriber(config)
    if not local.available:
        raise RuntimeError(local.install_hint())
    return local.transcribe_wav_file(path), "vosk"


def transcribe_wav_gradium(path: Path, cfg: GradiumConfig) -> str:
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


def synthesize_wav(
    *,
    text: str,
    output: Path,
    config: WorkerConfig,
    network: NetworkMonitor,
    length_scale: float | None = None,
) -> str:
    """Synthesize a reply WAV; returns the engine used."""
    output.parent.mkdir(parents=True, exist_ok=True)
    clean = sanitize_spoken_text(text)

    if _use_gradium(config, network):
        try:
            pcm = asyncio.run(gradium_tts_pcm(config.gradium, clean))
            write_wav_pcm(output, pcm, pcm_sample_rate(config.gradium))
            return "gradium"
        except Exception as exc:
            local = _local_synthesizer(config)
            if not is_network_error(exc) or local.engine is None:
                raise
            debug(f"echo synthesize: gradium failed, falling back to local tts: {exc}")
            network.invalidate()
            return local.synthesize_to_wav(clean, output, length_scale)

    return _local_synthesizer(config).synthesize_to_wav(clean, output, length_scale)


if __name__ == "__main__":
    raise SystemExit(main())
