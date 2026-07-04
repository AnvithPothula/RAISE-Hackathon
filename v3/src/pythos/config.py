from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelPaths:
    wake_word: Path
    vosk: Path
    piper_executable: Path
    piper_model: Path
    piper_config: Path


@dataclass(frozen=True)
class AudioConfig:
    chunk: int
    rate: int
    channels: int
    wake_word: str
    wake_threshold: float
    asr_timeout_seconds: float
    silence_timeout_seconds: float
    tts_length_scale: float


@dataclass(frozen=True)
class GeminiConfig:
    base_url: str
    model: str


@dataclass(frozen=True)
class GradiumConfig:
    api_key: str
    base_ws_url: str
    tts_voice_id: str
    tts_model: str
    tts_output_format: str
    stt_model: str
    stt_input_format: str
    vad_horizon_index: int
    vad_inactivity_threshold: float
    vad_min_silence_seconds: float

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key)


@dataclass(frozen=True)
class WorkerConfig:
    root: Path
    low_resource_mode: bool
    models: ModelPaths
    audio: AudioConfig
    gemini: GeminiConfig
    gradium: GradiumConfig


def _resolve_path(root: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve()


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"Expected config object in {path}")
    return data


def load_config(config_path: str | Path | None = None) -> WorkerConfig:
    if config_path is None:
        config_path = os.environ.get("PYTHOS_CONFIG", "config.json")

    path = Path(config_path).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    path = path.resolve()
    root = path.parent
    data = _read_json(path)

    python_data = data.get("python", {})
    model_data = data.get("models", {})
    audio_data = data.get("audio", {})
    gemini_data = data.get("gemini", {})
    gradium_data = data.get("gradium", {})

    model_name = os.environ.get("PYTHOS_GEMINI_MODEL") or gemini_data.get("model", "gemini-2.5-flash")

    # API key never lives in config.json (public repo); read it from the environment.
    # A config.json "apiKey" is honoured only as a local fallback for convenience.
    gradium_api_key = os.environ.get("GRADIUM_API_KEY") or str(gradium_data.get("apiKey", ""))

    return WorkerConfig(
        root=root,
        low_resource_mode=bool(python_data.get("lowResourceMode", True)),
        models=ModelPaths(
            wake_word=_resolve_path(root, model_data["wakeWord"]),
            vosk=_resolve_path(root, model_data["vosk"]),
            piper_executable=_resolve_path(root, model_data["piperExecutable"]),
            piper_model=_resolve_path(root, model_data["piperModel"]),
            piper_config=_resolve_path(root, model_data["piperConfig"]),
        ),
        audio=AudioConfig(
            chunk=int(audio_data.get("chunk", 1280)),
            rate=int(audio_data.get("rate", 16000)),
            channels=int(audio_data.get("channels", 1)),
            wake_word=str(audio_data.get("wakeWord", "mark")),
            wake_threshold=float(audio_data.get("wakeThreshold", 0.5)),
            asr_timeout_seconds=float(audio_data.get("asrTimeoutSeconds", 10)),
            silence_timeout_seconds=float(audio_data.get("silenceTimeoutSeconds", 3)),
            tts_length_scale=float(audio_data.get("ttsLengthScale", 0.8)),
        ),
        gemini=GeminiConfig(
            base_url=str(gemini_data.get("baseUrl", "https://generativelanguage.googleapis.com/v1beta")).rstrip("/"),
            model=str(model_name),
        ),
        gradium=GradiumConfig(
            api_key=gradium_api_key,
            base_ws_url=str(gradium_data.get("baseWsUrl", "wss://api.gradium.ai/api")).rstrip("/"),
            tts_voice_id=str(gradium_data.get("ttsVoiceId", "YTpq7expH9539ERJ")),
            tts_model=str(gradium_data.get("ttsModel", "default")),
            tts_output_format=str(gradium_data.get("ttsOutputFormat", "pcm")),
            stt_model=str(gradium_data.get("sttModel", "default")),
            stt_input_format=str(gradium_data.get("sttInputFormat", "pcm_16000")),
            vad_horizon_index=int(gradium_data.get("vadHorizonIndex", 2)),
            vad_inactivity_threshold=float(gradium_data.get("vadInactivityThreshold", 0.5)),
            vad_min_silence_seconds=float(gradium_data.get("vadMinSilenceSeconds", 1.0)),
        ),
    )


def validate_model_paths(config: WorkerConfig) -> list[str]:
    """Validate on-device model assets that are still required.

    Wake word detection, STT (Vosk) and TTS (Piper) now all run through the
    Gradium cloud API, so no local model assets are required. The model paths
    remain in the config for backward compatibility but are no longer validated.
    """
    return []
