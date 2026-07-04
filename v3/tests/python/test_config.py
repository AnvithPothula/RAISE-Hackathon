import json
from pathlib import Path

from pythos.config import load_config, validate_model_paths


def write_test_config(root: Path) -> Path:
    model_root = root / "Models"
    (model_root / "wakeword").mkdir(parents=True)
    (model_root / "vosk" / "vosk-model-small-en-us-0.15").mkdir(parents=True)
    (model_root / "piper").mkdir(parents=True)
    (model_root / "wakeword" / "pythos.onnx").write_text("", encoding="utf-8")
    (model_root / "piper" / "piper.exe").write_text("", encoding="utf-8")
    (model_root / "piper" / "model.onnx").write_text("", encoding="utf-8")
    (model_root / "piper" / "model.onnx.json").write_text("{}", encoding="utf-8")

    config_path = root / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "python": {"lowResourceMode": True},
                "models": {
                    "wakeWord": "Models/wakeword/pythos.onnx",
                    "vosk": "Models/vosk/vosk-model-small-en-us-0.15",
                    "piperExecutable": "Models/piper/piper.exe",
                    "piperModel": "Models/piper/model.onnx",
                    "piperConfig": "Models/piper/model.onnx.json",
                },
                "audio": {},
                "ollama": {"baseUrl": "http://127.0.0.1:11434", "model": "gemma4:12b"},
            }
        ),
        encoding="utf-8",
    )
    return config_path


def test_load_config_resolves_local_model_paths(tmp_path: Path) -> None:
    config_path = write_test_config(tmp_path)
    config = load_config(config_path)

    assert config.models.piper_executable.name == "piper.exe"
    assert config.models.vosk.name == "vosk-model-small-en-us-0.15"


def test_validate_model_paths_uses_existing_configured_assets(tmp_path: Path) -> None:
    config = load_config(write_test_config(tmp_path))

    missing = validate_model_paths(config)

    assert missing == []
