import io
import json
from pathlib import Path

import pytest

from pythos.config import load_config
from pythos.local_voice import LocalSttSettings, LocalSynthesizer, VoskTranscriber
from pythos.network_monitor import NetworkMonitor
from pythos.protocol import JsonlWriter
from pythos.voice_mode import VoiceModeReporter


def write_config(root: Path, *, api_key: str = "") -> Path:
    model_root = root / "Models"
    (model_root / "vosk" / "vosk-model-en-us-0.22").mkdir(parents=True)
    (model_root / "piper").mkdir(parents=True)

    config_path = root / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "python": {"lowResourceMode": True},
                "models": {
                    "wakeWord": "Models/wakeword/pythos.onnx",
                    "vosk": "Models/vosk/vosk-model-en-us-0.22",
                    "piperExecutable": "Models/piper/piper.exe",
                    "piperModel": "Models/piper/model.onnx",
                    "piperConfig": "Models/piper/model.onnx.json",
                },
                "audio": {},
                "gradium": {"apiKey": api_key},
                "ollama": {"baseUrl": "http://127.0.0.1:11434", "model": "gemma4:12b"},
            }
        ),
        encoding="utf-8",
    )
    return config_path


def make_reporter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_key: str,
    online: bool,
) -> tuple[VoiceModeReporter, io.StringIO, dict[str, bool]]:
    monkeypatch.delenv("GRADIUM_API_KEY", raising=False)
    config = load_config(write_config(tmp_path, api_key=api_key))
    stream = io.StringIO()
    events = JsonlWriter(stream)
    verdict = {"online": online}
    network = NetworkMonitor(
        [("probe", 1)],
        prober=lambda host, port, timeout: verdict["online"],
        cache_ttl=0.0,
    )
    local_stt = VoskTranscriber(
        config.models.vosk,
        LocalSttSettings(chunk=1280, rate=16000, asr_timeout_seconds=7, silence_timeout_seconds=2),
    )
    local_tts = LocalSynthesizer(
        config.models.piper_executable,
        config.models.piper_model,
        config.models.piper_config,
        platform="darwin",
    )
    reporter = VoiceModeReporter(config, events, network, local_stt, local_tts)
    return reporter, stream, verdict


def emitted_events(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def test_no_api_key_selects_local_engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reporter, stream, _ = make_reporter(tmp_path, monkeypatch, api_key="", online=True)
    assert reporter.refresh("startup", force=True) == "local"
    events = emitted_events(stream)
    assert events[0]["type"] == "voice_mode"
    payload = events[0]["payload"]
    assert payload["engine"] == "local"
    assert payload["gradiumConfigured"] is False
    assert payload["stt"] == "vosk"


def test_configured_and_online_selects_gradium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reporter, stream, _ = make_reporter(tmp_path, monkeypatch, api_key="key", online=True)
    assert reporter.refresh("startup", force=True) == "gradium"
    payload = emitted_events(stream)[0]["payload"]
    assert payload["engine"] == "gradium"
    assert payload["stt"] == "gradium"
    assert payload["tts"] == "gradium"


def test_configured_but_offline_selects_local(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reporter, stream, _ = make_reporter(tmp_path, monkeypatch, api_key="key", online=False)
    assert reporter.refresh("startup", force=True) == "local"
    payload = emitted_events(stream)[0]["payload"]
    assert payload["engine"] == "local"
    assert payload["online"] is False


def test_refresh_emits_only_on_change(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reporter, stream, _ = make_reporter(tmp_path, monkeypatch, api_key="key", online=True)
    reporter.refresh("startup", force=True)
    reporter.refresh("turn 2")
    reporter.refresh("turn 3")
    assert len(emitted_events(stream)) == 1


def test_network_drop_swaps_engine_and_emits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reporter, stream, verdict = make_reporter(tmp_path, monkeypatch, api_key="key", online=True)
    assert reporter.refresh("startup", force=True) == "gradium"

    verdict["online"] = False
    reporter.note_network_failure("speech recognition")
    events = emitted_events(stream)
    assert len(events) == 2
    payload = events[-1]["payload"]
    assert payload["engine"] == "local"
    assert "network failure" in payload["reason"]

    # Wi-Fi comes back: the next refresh flips back to the cloud voice.
    verdict["online"] = True
    assert reporter.refresh("turn after reconnect") == "gradium"
    assert emitted_events(stream)[-1]["payload"]["engine"] == "gradium"
