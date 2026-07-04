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
class OllamaConfig:
    base_url: str
    model: str


@dataclass(frozen=True)
class WorkerConfig:
    root: Path
    low_resource_mode: bool
    models: ModelPaths
    audio: AudioConfig
    ollama: OllamaConfig


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
    ollama_data = data.get("ollama", {})

    model_name = os.environ.get("PYTHOS_OLLAMA_MODEL") or ollama_data.get("model", "llama3:8b")

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
            wake_word=str(audio_data.get("wakeWord", "pythos")),
            wake_threshold=float(audio_data.get("wakeThreshold", 0.5)),
            asr_timeout_seconds=float(audio_data.get("asrTimeoutSeconds", 10)),
            silence_timeout_seconds=float(audio_data.get("silenceTimeoutSeconds", 3)),
            tts_length_scale=float(audio_data.get("ttsLengthScale", 0.8)),
        ),
        ollama=OllamaConfig(
            base_url=str(ollama_data.get("baseUrl", "http://localhost:11434")).rstrip("/"),
            model=str(model_name),
        ),
    )


def validate_model_paths(config: WorkerConfig) -> list[str]:
    missing: list[str] = []
    for label, path in (
        ("wake word model", config.models.wake_word),
        ("Vosk model", config.models.vosk),
        ("Piper executable", config.models.piper_executable),
        ("Piper model", config.models.piper_model),
        ("Piper config", config.models.piper_config),
    ):
        if not path.exists():
            missing.append(f"{label}: {path}")
    return missing
