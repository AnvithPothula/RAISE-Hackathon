# Pythos

**A privacy-first voice assistant whose brain never leaves your machine.**

Pythos runs wake word detection, conversation, tool calling, and screen understanding on-device with **Gemma 4 via [Ollama](https://ollama.com)**. Typed chat works fully offline with no API keys. Optional cloud voice (Gradium) adds studio-quality speech when you want it.

Built for the **RAISE Summit Hackathon 2026** — Google DeepMind Remote / on-device Gemma track.

---

## Table of contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Run](#run)
- [Optional configuration](#optional-configuration)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Remote clients](#remote-clients)
- [Documentation](#documentation)

---

## Features

- **On-device LLM** — Gemma 4 through Ollama; no cloud API key required for reasoning or tools
- **Local screen vision** — “What’s on my screen?” answered without sending screenshots off-device
- **Voice orb UI** — Electron + React desktop app with transcript, controls, and tool timeline
- **Agentic tools** — weather, alarms, Spotify, app launcher, web search, memory, MCP connectors, and more
- **Offline resilience** — keep *talking* after Wi‑Fi drops: a network detector swaps cloud voice for on-device Vosk STT + Piper/system TTS, and the local Gemma brain never skips a beat
- **Live demo HUD** — “All inference on-device” badge, voice-mode indicator, and real tok/s + TTFT from Ollama
- **MLX engine variant** — optional Apple-Silicon build (`gemma4:12b-mlx`) toggle for extra token throughput
- **Remote nodes** — Android and Alexa/Echo clients over Tailscale (optional), with the same offline voice fallback

---

## Prerequisites

Install these before setup:

| Requirement | Version | Notes |
|-------------|---------|-------|
| [Ollama](https://ollama.com/download) | latest | Serves Gemma 4 locally |
| Node.js | 20+ | Electron + React app |
| Python | 3.11+ | Audio worker |
| PortAudio | — | **macOS/Linux only** — needed for PyAudio |

**PortAudio (macOS / Linux):**

```bash
# macOS
brew install portaudio

# Debian / Ubuntu
sudo apt-get install -y portaudio19-dev
```

---

## Installation

All application code lives in the `v3/` directory.

### 1. Clone the repository

```bash
git clone https://github.com/AnvithPothula/RAISE-Hackathon.git
cd RAISE-Hackathon/v3
```

### 2. Pull the local model (required)

Pythos needs Gemma 4 available through Ollama:

```bash
# macOS / Linux
./scripts/install-ollama-models.sh

# Windows (PowerShell)
.\scripts\install-ollama-models.ps1
```

Or manually:

```bash
ollama serve          # if not already running
ollama pull gemma4:12b
ollama pull gemma4:e2b   # optional — low-resource fallback
```

Verify:

```bash
curl http://127.0.0.1:11434/api/tags
```

You should see `gemma4:12b` (and optionally `gemma4:e2b`).

**Optional — offline voice input.** Spoken replies work offline out of the box
(Piper if installed, otherwise the OS voice). To also *speak to* Pythos with the
network down, install the offline recognizer once:

```bash
./scripts/install-vosk-model.sh        # macOS / Linux
# .\scripts\install-vosk-model.ps1      # Windows PowerShell
```

**Optional — MLX variant (Apple Silicon).** `ollama pull gemma4:12b-mlx`, then
enable **Settings → Engine variant → MLX** for higher tok/s; it falls back to
the standard build automatically when the tag is missing.

### 3. Install Python dependencies

```bash
# macOS / Linux
chmod +x scripts/*.sh          # first time only
./scripts/setup-venv.sh

# Windows (PowerShell)
.\scripts\setup-venv.ps1
```

This creates `v3/.venv` and installs packages from `requirements.txt`.

### 4. Install Node dependencies

From `v3/`:

```bash
npm install
```

### 5. (Optional) Install Pi coding agent

Only needed if you enable the experimental Pi tool bridge in `config.json`:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
./scripts/install-pi-models.sh        # macOS / Linux
# .\scripts\install-pi-models.ps1     # Windows
```

---

## Run

From `v3/`:

```bash
npm run dev
```

Then use the wake word or type in the UI. The assistant runs locally — you can turn off Wi‑Fi and keep chatting.

**Low-resource mode:** enable **Low resource mode** in Settings, or set `python.lowResourceMode: true` in `config.json`, to use `gemma4:e2b` instead of `gemma4:12b`. Pull that model first.

Override the model or endpoint with environment variables:

```bash
export PYTHOS_OLLAMA_MODEL=gemma4:12b
export PYTHOS_OLLAMA_URL=http://127.0.0.1:11434
```

---

## Optional configuration

No API keys are required for typed chat, tools, or screen vision.

| Variable | Purpose |
|----------|---------|
| `GRADIUM_API_KEY` | Studio-quality cloud voice (STT + TTS) via [Gradium](https://studio.gradium.ai); without it (or offline) voice runs on-device (Vosk + Piper/system TTS) |
| `PYTHOS_OLLAMA_MODEL` | Override default model (`gemma4:12b`) |
| `PYTHOS_OLLAMA_URL` | Override Ollama endpoint |
| `PYTHOS_CURSOR_WORKSPACE` | Project path for Cursor agent delegation |
| `PYTHOS_MCP_SANDBOX` | Root directory for MCP file tools |

Create a local env file (gitignored):

```bash
cp .env.example .env
# Edit .env, then load before launch:

# macOS / Linux
set -a; source ./.env; set +a && npm run dev

# Windows PowerShell
Copy-Item .env.example .env -Force
# Add keys to .env, then set each var or use: Get-Content .env | ForEach-Object { ... }
npm run dev
```

See [`v3/API_KEYS_SETUP.txt`](v3/API_KEYS_SETUP.txt) for the full reference.

---

## Testing

From `v3/`:

```bash
npm test                 # TypeScript (Vitest)
npm run test:python      # Python (pytest)

# Or use the helper scripts:
./scripts/test.sh        # macOS / Linux
.\scripts\test.ps1       # Windows
```

---

## Project structure

```text
RAISE-Hackathon/
├── README.md              ← you are here
├── HACKATHON_PLAN.md      ← hackathon strategy notes
└── v3/                    ← main application
    ├── src/
    │   ├── main/          ← Electron main process, Ollama, tools, MCP
    │   ├── renderer/      ← React UI (voice orb, transcript)
    │   ├── preload/       ← typed IPC bridge
    │   └── pythos/        ← Python audio worker
    ├── android/           ← optional Android remote client
    ├── scripts/           ← setup, model install, test helpers
    ├── config.json        ← runtime settings
    ├── .env.example       ← optional env template
    └── API_KEYS_SETUP.txt ← detailed env documentation
```

---

## Remote clients

### Android (Tailscale)

Native client: `v3/android/pythos-remote`. Point it at your desktop bridge:

```text
http://<tailscale-ip-or-magicdns-name>:9000
```

Connected phones appear as orbiting nodes in the desktop UI.

### Alexa / Echo

Same bridge on port `9000`:

- WebSocket: `ws://<host>:9000/echo`
- Audio: `http://<host>:9000/api/audio/request`
- Text: `http://<host>:9000/api/text/request`

---

## Documentation

- **[v3/README.md](v3/README.md)** — architecture, MCP setup, worker protocol, and technical notes
- **[v3/API_KEYS_SETUP.txt](v3/API_KEYS_SETUP.txt)** — environment variables and verification steps
- **[HACKATHON_PLAN.md](HACKATHON_PLAN.md)** — RAISE 2026 hackathon plan and demo strategy

---

## License

This project was created for the RAISE Summit Hackathon. See repository history and individual skill directories for third-party licenses where applicable.
