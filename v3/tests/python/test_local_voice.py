import json
from pathlib import Path

from pythos.local_voice import (
    LocalSttSettings,
    LocalSynthesizer,
    VoskPushTranscriber,
    VoskTranscriber,
    build_piper_command,
    build_system_tts_command,
    contains_wake_word,
    resolve_piper_voice,
    system_tts_available,
)


def make_settings() -> LocalSttSettings:
    return LocalSttSettings(chunk=1280, rate=16000, asr_timeout_seconds=7, silence_timeout_seconds=2)


class FakeRecognizer:
    """Scriptable stand-in for vosk.KaldiRecognizer."""

    def __init__(self) -> None:
        self.partial_text = ""
        self.final_text = ""
        self.accept_next = False
        self.reset_count = 0
        self.fed: list[bytes] = []

    def AcceptWaveform(self, data: bytes) -> bool:  # noqa: N802 - vosk API casing
        self.fed.append(data)
        accepted = self.accept_next
        self.accept_next = False
        return accepted

    def Result(self) -> str:  # noqa: N802
        return json.dumps({"text": self.final_text})

    def PartialResult(self) -> str:  # noqa: N802
        return json.dumps({"partial": self.partial_text})

    def FinalResult(self) -> str:  # noqa: N802
        return json.dumps({"text": self.final_text})

    def Reset(self) -> None:  # noqa: N802
        self.reset_count += 1


def test_contains_wake_word_matches_whole_words_only() -> None:
    assert contains_wake_word("hey mark what's up", "mark") is True
    assert contains_wake_word("the market is open", "mark") is False
    assert contains_wake_word("Hey, Pythos! Weather?", "pythos") is True
    assert contains_wake_word("okay py thos", "pythos") is False


def test_contains_wake_word_matches_multiword_phrases() -> None:
    assert contains_wake_word("well hey pythos, set an alarm", "hey pythos") is True
    assert contains_wake_word("hey there pythos", "hey pythos") is False


def test_vosk_transcriber_reports_availability_and_hint(tmp_path: Path) -> None:
    missing = VoskTranscriber(tmp_path / "nope", make_settings())
    assert missing.available is False
    assert "install-vosk-model" in missing.install_hint()

    model_dir = tmp_path / "vosk-model"
    model_dir.mkdir()
    present = VoskTranscriber(model_dir, make_settings())
    assert present.available is True


def test_transcribe_stream_returns_final_on_accepted_utterance(tmp_path: Path) -> None:
    transcriber = VoskTranscriber(tmp_path, make_settings())
    fake = FakeRecognizer()
    transcriber._create_recognizer = lambda rate=None: fake  # type: ignore[method-assign]

    partials: list[str] = []
    levels: list[int] = []
    reads = {"count": 0}

    def read(chunk: int, exception_on_overflow: bool = False) -> bytes:
        reads["count"] += 1
        if reads["count"] == 1:
            fake.partial_text = "turn off the"
        if reads["count"] == 2:
            fake.accept_next = True
            fake.final_text = "turn off the lights"
        return b"\x00\x00" * 10

    final = transcriber.transcribe_stream(
        read,
        lambda: False,
        on_partial=partials.append,
        on_level=lambda data: levels.append(len(data)),
    )
    assert final == "turn off the lights"
    assert partials == ["turn off the"]
    assert len(levels) == 2


def test_transcribe_stream_returns_empty_when_stopped(tmp_path: Path) -> None:
    transcriber = VoskTranscriber(tmp_path, make_settings())
    transcriber._create_recognizer = lambda rate=None: FakeRecognizer()  # type: ignore[method-assign]
    final = transcriber.transcribe_stream(
        lambda chunk, exception_on_overflow=False: b"\x00\x00",
        lambda: True,
        on_partial=lambda text: None,
        on_level=lambda data: None,
    )
    assert final == ""


def test_wait_for_wake_word_matches_partial(tmp_path: Path) -> None:
    transcriber = VoskTranscriber(tmp_path, make_settings())
    fake = FakeRecognizer()
    transcriber._create_recognizer = lambda rate=None: fake  # type: ignore[method-assign]

    reads = {"count": 0}

    def read(chunk: int, exception_on_overflow: bool = False) -> bytes:
        reads["count"] += 1
        if reads["count"] == 2:
            fake.partial_text = "hey mark"
        return b"\x00\x00"

    detected = transcriber.wait_for_wake_word(
        read, lambda: False, "mark", on_level=lambda data: None
    )
    assert detected is True


def test_wake_word_loop_resets_after_unrelated_phrase(tmp_path: Path) -> None:
    transcriber = VoskTranscriber(tmp_path, make_settings())
    fake = FakeRecognizer()
    transcriber._create_recognizer = lambda rate=None: fake  # type: ignore[method-assign]

    reads = {"count": 0}

    def read(chunk: int, exception_on_overflow: bool = False) -> bytes:
        reads["count"] += 1
        if reads["count"] == 1:
            fake.accept_next = True
            fake.final_text = "completely unrelated sentence"
        if reads["count"] == 2:
            fake.partial_text = "mark"
        return b"\x00\x00"

    detected = transcriber.wait_for_wake_word(
        read, lambda: False, "mark", on_level=lambda data: None
    )
    assert detected is True
    assert fake.reset_count == 1


def test_push_transcriber_marks_turn_end_on_final(tmp_path: Path) -> None:
    transcriber = VoskTranscriber(tmp_path, make_settings())
    fake = FakeRecognizer()
    transcriber._create_recognizer = lambda rate=None: fake  # type: ignore[method-assign]

    push = VoskPushTranscriber(transcriber)
    push.open()
    fake.partial_text = "what is the"
    push.send(b"\x00\x00")
    status = push.poll()
    assert status["partial"] == "what is the"
    assert status["turn_ended"] is False

    fake.accept_next = True
    fake.final_text = "what is the weather"
    push.send(b"\x00\x00")
    status = push.poll()
    assert status["turn_ended"] is True
    fake.final_text = ""
    assert push.finalize() == "what is the weather"


def test_resolve_piper_voice_tolerates_windows_era_exe_path(tmp_path: Path) -> None:
    model = tmp_path / "model.onnx"
    config = tmp_path / "model.onnx.json"
    model.write_bytes(b"onnx")
    config.write_text("{}")

    posix_binary = tmp_path / "piper"
    posix_binary.write_bytes(b"#!/bin/sh\n")

    voice = resolve_piper_voice(
        tmp_path / "piper.exe", model, config, which=lambda name: None
    )
    assert voice is not None
    assert voice.executable == posix_binary


def test_resolve_piper_voice_requires_model_files(tmp_path: Path) -> None:
    binary = tmp_path / "piper"
    binary.write_bytes(b"bin")
    assert (
        resolve_piper_voice(binary, tmp_path / "missing.onnx", tmp_path / "missing.json", which=lambda name: None)
        is None
    )


def test_resolve_piper_voice_falls_back_to_path_lookup(tmp_path: Path) -> None:
    model = tmp_path / "model.onnx"
    config = tmp_path / "model.onnx.json"
    model.write_bytes(b"onnx")
    config.write_text("{}")
    path_binary = tmp_path / "piper-on-path"
    path_binary.write_bytes(b"bin")

    voice = resolve_piper_voice(
        tmp_path / "missing" / "piper.exe",
        model,
        config,
        which=lambda name: str(path_binary),
    )
    assert voice is not None
    assert voice.executable == path_binary


def test_build_piper_command_shape(tmp_path: Path) -> None:
    model = tmp_path / "model.onnx"
    config = tmp_path / "model.onnx.json"
    binary = tmp_path / "piper"
    for file, payload in ((model, b"m"), (config, b"{}"), (binary, b"b")):
        file.write_bytes(payload)
    voice = resolve_piper_voice(binary, model, config, which=lambda name: None)
    assert voice is not None
    command = build_piper_command(voice, tmp_path / "out.wav", 1.5)
    assert command[0] == str(binary)
    assert "--length_scale" in command
    assert command[command.index("--length_scale") + 1] == "1.5"


def test_build_system_tts_command_darwin_and_windows(tmp_path: Path) -> None:
    wav = tmp_path / "out.wav"
    darwin = build_system_tts_command("hello world", wav, "darwin")
    assert darwin is not None
    assert darwin[0] == "say"
    assert str(wav) in darwin

    windows = build_system_tts_command("it's ready", wav, "win32")
    assert windows is not None
    assert windows[0] == "powershell"
    # Single quotes must be doubled for the PowerShell string literal.
    assert "it''s ready" in windows[-1]


def test_system_tts_available_uses_injected_lookup() -> None:
    assert system_tts_available("darwin", which=lambda name: "/usr/bin/say" if name == "say" else None) is True
    assert system_tts_available("linux", which=lambda name: None) is False
    assert (
        system_tts_available("linux", which=lambda name: "/usr/bin/espeak-ng" if name == "espeak-ng" else None)
        is True
    )


def test_local_synthesizer_prefers_piper_when_installed(tmp_path: Path) -> None:
    model = tmp_path / "model.onnx"
    config = tmp_path / "model.onnx.json"
    binary = tmp_path / "piper"
    for file, payload in ((model, b"m"), (config, b"{}"), (binary, b"b")):
        file.write_bytes(payload)
    synth = LocalSynthesizer(binary, model, config, platform="darwin")
    assert synth.engine == "piper"


def test_local_synthesizer_reports_missing_piper(tmp_path: Path) -> None:
    synth = LocalSynthesizer(
        tmp_path / "piper.exe", tmp_path / "model.onnx", tmp_path / "model.onnx.json", platform="darwin"
    )
    assert synth.resolve_piper() is None
