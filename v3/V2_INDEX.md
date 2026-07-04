# v2 Index

Generated as the starting point for the `v3` rebuild.

## High-Level Purpose

`v2` is a local Python voice assistant named Pythos.

Primary flow:

1. Activate through either wake word detection or `Ctrl+Shift+E`.
2. Capture a spoken command with Vosk speech recognition.
3. Send the recognized text to a local Ollama model.
4. Optionally run Ollama Cloud web search when the command starts with `search`.
5. Synthesize the answer through Piper and play the generated audio with Pygame.

## Current Entry Points

| File | Role |
| --- | --- |
| `v2/run.bat` | Starts Ollama, waits briefly, then runs `Main_win+ctrl+e.py` through an absolute Python script path. |
| `v2/Main_win+ctrl+e.py` | Main interactive hotkey entry point. Pressing `Ctrl+Shift+E` toggles listening, skips wake word detection, runs ASR, LLM, then TTS. |
| `v2/Main.py` | Simpler wake-word entry point. Waits for wake word plus one command, calls LLM, speaks response, then exits. |
| `v2/Wakeword.py` | Wake word detection and speech recognition module. Contains standalone functions plus a combined `VoiceAssistant` loop. |
| `v2/LLM.py` | Ollama local generation wrapper plus web search helper. |
| `v2/Voice.py` | Piper text-to-speech wrapper and Pygame playback. |

## Source Modules

### `Main.py`

- Imports `waitForCommand`, `speak`, and `llm`.
- Uses `OLLAMA_MODEL = "llama3:8b"`.
- Waits for wake word and a single command.
- Prints the recognized command, sends it to the LLM, prints the result, and speaks it at speed `0.8`.
- Contains TODOs for looping, interruption, and canceling the current run.

### `Main_win+ctrl+e.py`

- Imports `pynput` for global keyboard hotkey handling.
- Uses `Ctrl+Shift+E` to toggle a background assistant loop.
- Calls `listenForCommand(timeout=10, show_partial=True)` directly, so it bypasses wake word detection.
- Calls `llm(question, "llama3:8b")`, then `speak(result, 0.8)`.
- Resets to paused after each spoken response.

### `Wakeword.py`

- Depends on `numpy`, `pyaudio`, `openwakeword`, and `vosk`.
- Audio constants:
  - `CHUNK = 1280`
  - `CHANNELS = 1`
  - `RATE = 16000`
  - `FORMAT = pyaudio.paInt16`
- Wake word constants:
  - `WAKE_WORD = "pythos"`
  - `WAKE_THRESHOLD = 0.50`
  - `WAKE_TIMEOUT = 30`
  - `WAKE_MODEL_PATH = "Models\\wakeword\\pythos.onnx"`
- ASR constants:
  - `VOSK_MODEL_PATH = "Models\\vosk\\vosk-model-small-en-us-0.15"`
  - `ASR_TIMEOUT = 10`
- Main public functions/classes:
  - `find_model(path)`
  - `WakeDetector`
  - `VoskASR`
  - `listenForWakeword(timeout=WAKE_TIMEOUT)`
  - `listenForCommand(timeout=ASR_TIMEOUT, show_partial=True)`
  - `VoiceAssistant`
  - `waitForCommand(process_command_func=None, wake_timeout=WAKE_TIMEOUT, asr_timeout=ASR_TIMEOUT)`
  - `voiceLoop(process_command_func=None)`

### `LLM.py`

- Depends on `requests`, `json`, and `pathlib`.
- Local generation endpoint: `http://localhost:11434/api/generate`.
- Default fallback model from code: `gemma3:1b`.
- Runtime entry points pass `llama3:8b`.
- Looks for optional `config.json` beside `LLM.py`, but that file is not present in `v2`.
- Loads the system prompt from `v2/Models/LLM/systemPrompt.txt`.
- If the prompt starts with `search`, calls `https://ollama.com/api/web_search`, trims results, injects them into the prompt, and then calls local Ollama.
- Important rebuild note: this file currently contains a hard-coded Ollama API key. Do not copy it into `v3`; move secrets to environment variables or a local ignored config file.

### `Voice.py`

- Depends on `subprocess`, `tempfile`, `os`, and `pygame`.
- Uses bundled Piper at `v2/Models/piper/piper.exe`.
- Uses voice model:
  - `v2/Models/piper/model.onnx`
  - `v2/Models/piper/model.onnx.json`
- Creates a temporary `.wav`, runs Piper with `--length_scale`, plays the file with Pygame, then attempts to delete the temp file.
- Prints debug and status messages directly from the module.

## Config And Instructions

| File | Contents |
| --- | --- |
| `v2/INSTRUCTIONS/requirements.txt` | Python packages: `numpy`, `pyaudio`, `pygame`, `requests`, `pathlib`, `openwakeword`, `vosk`, `ollama`, `pynput`. |
| `v2/INSTRUCTIONS/things needed.txt` | Notes: Python 3, Ollama, install requirements, pull `llama3:8b`. |
| `v2/Models/LLM/systemPrompt.txt` | Voice-assistant persona prompt for Pythos with short spoken responses. |
| `v2/todo.txt` | Notes that model storage and LLM work are done, search exists, and future work includes context memory. |

## Model And Binary Assets

The `v2` folder includes about 390 non-cache files totaling about 237 MB. Most of that is model and runtime data.

Large asset groups:

| Path | Purpose |
| --- | --- |
| `v2/Models/wakeword/pythos.onnx` | OpenWakeWord wake model used by `Wakeword.py`. |
| `v2/Models/wakeword/pythos.tflite` | Alternate wake model format, currently not used by the code. |
| `v2/Models/vosk/vosk-model-small-en-us-0.15/` | Vosk English ASR model. |
| `v2/Models/piper/piper.exe` | Piper executable. |
| `v2/Models/piper/model.onnx` | Current Piper voice model used by `Voice.py`. |
| `v2/Models/piper/model.onnx.json` | Current Piper voice config used by `Voice.py`. |
| `v2/Models/piper/en_US-john-medium.onnx` | Bundled alternate Piper voice model. |
| `v2/Models/piper/espeak-ng-data/` | Piper phonemization data. |

## Current Design Problems To Fix In v3

- Secrets: `LLM.py` contains a hard-coded API key.
- Paths: `run.bat` hard-codes `C:\Helper-Base\v2\Main_win+ctrl+e.py`.
- Configuration: constants are spread across modules instead of a single config object or file.
- Lifecycle: microphone streams, Pygame mixer, and subprocess calls are managed inline.
- Control flow: hotkey mode, wake-word mode, one-shot command mode, and demo code live in overlapping modules.
- Blocking behavior: LLM generation and speech playback block the assistant loop.
- Cancellation: TODOs mention interrupting speech, but there is no cancellation mechanism yet.
- Context memory: TODO says to cache recent speech context, but this is not implemented.
- Encoding: several status strings appear mojibake-corrupted, likely from emoji or non-UTF-8 console handling.
- Error handling: most failures print or raise raw exceptions rather than returning typed results.
- Testability: hardware, model paths, and network calls are directly embedded, making unit tests hard.
- Packaging: dependencies and instructions live under `INSTRUCTIONS` rather than standard project files.

## Suggested v3 Shape

Keep `v3` source small and modular before copying any models.

Proposed structure:

```text
v3/
  README.md
  V2_INDEX.md
  pyproject.toml
  .env.example
  src/
    pythos/
      __init__.py
      app.py
      config.py
      audio_input.py
      wakeword.py
      speech_to_text.py
      llm.py
      text_to_speech.py
      hotkeys.py
      context_memory.py
  models/
    README.md
  scripts/
    run_hotkey.ps1
    run_wakeword.ps1
  tests/
```

Recommended v3 build order:

1. Add config loading with model paths, Ollama model, timeouts, thresholds, and optional web-search key.
2. Wrap ASR, wake word, LLM, and TTS behind small interfaces.
3. Rebuild the hotkey entry point first because it avoids wake-word complexity.
4. Add wake-word mode after the basic command loop is stable.
5. Add cancellation for speech playback and in-flight LLM work.
6. Add short context memory with a fixed-size transcript buffer.
7. Add tests around config, prompt construction, context memory, and command orchestration.

## Copy-Forward Rules

- Copy behavior, not file layout.
- Do not copy `__pycache__`.
- Do not copy hard-coded keys.
- Do not copy absolute paths.
- Do not copy model binaries into git unless that is intentional for this repo.
- Keep model asset references configurable so `v3` can point at existing `v2/Models` during development.
