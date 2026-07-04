# Pythos v3

Pythos is a voice assistant whose **brain never leaves your machine**. Wake word,
conversation, tool calling, and screen understanding all run on-device with
**Gemma 4 via [Ollama](https://ollama.com)** — so it keeps working when the
internet doesn't, and your prompts and screen never get shipped to a datacenter.

Built for the RAISE Summit Hackathon 2026 (Google DeepMind Remote / on-device Gemma track).

## Built during RAISE 2026 (July 4–5)

Work created at the event (see git history on `main`):

- **Gemma 4 on-device brain** — full migration from cloud Gemini to local Ollama (`gemma4:12b`), including tool calling, vision, and adaptive thinking
- **Agentic loops** — `deep_research` self-looping research agent, local sub-agents, `run_code` sandbox
- **Cursor integration** — optional `delegate_coding_task` via Cursor agent CLI when installed
- **MCP connector layer** — pythos-system, filesystem, and memory servers with live status in the UI
- **Demo HUD** — on-device badge, offline indicator, tok/s + TTFT performance stats for judges
- **Gradium streaming voice**, cross-platform/Mac support, Alexa/Android remote bridge, SSL fix

## Architecture

- **Brain (local):** Gemma 4 served by Ollama at `http://127.0.0.1:11434`. Reasoning,
  tool calling, and sub-agents run fully on-device — no cloud LLM, no API key.
- **Screen understanding (local):** "what's on my screen?" is answered by Gemma 4
  vision; the screenshot never leaves the machine.
- **Tools:** transport-agnostic tool runtime (`src/main/toolRuntime.ts`) — weather,
  alarms, Spotify, open app/website, web search, calculator, memory, MCP tools.
- **Electron main:** process supervision, typed IPC, tool dispatch, Echo/Android bridge.
- **React renderer:** voice orb visualizer, transcript, controls, tool timeline.
- **Voice:** wake word, STT, and TTS currently run through the Gradium cloud API
  (typed input works fully offline). Legacy Vosk/Piper assets remain for the
  offline-voice fallback.
- **Python worker:** audio capture/playback and the speech pipeline (no LLM).

## Prerequisites

- **[Ollama](https://ollama.com/download)** with a Gemma 4 model pulled (the brain).
- **Node.js 20+** and **Python 3.11+**.
- **PortAudio** (for PyAudio): macOS `brew install portaudio`; Debian/Ubuntu
  `sudo apt-get install -y portaudio19-dev`.

## Setup

### 1. Install the local model (the brain)

```bash
# Install Ollama (macOS: brew install ollama), then pull the Gemma models:
./scripts/install-ollama-models.sh        # macOS / Linux
# .\scripts\install-ollama-models.ps1      # Windows PowerShell
```

This pulls `gemma4:12b` (default, best tool calling, ~7.6 GB / 256K context) and
`gemma4:e2b` (optional low-resource fallback). You can also do it manually:

```bash
ollama pull gemma4:12b
ollama pull gemma4:e2b   # optional
```

### 2. Install app dependencies

```bash
# macOS / Linux
./scripts/setup-venv.sh
npm install

# Windows PowerShell
# .\scripts\setup-venv.ps1
# npm install
```

No API key is required to run the assistant. For spoken voice (optional), add
`GRADIUM_API_KEY` — see `API_KEYS_SETUP.txt`.

## Run

```bash
npm run dev
```

Then say the wake word (or type) and ask away. Everything the model does runs
locally — try turning off Wi-Fi and it keeps answering.

### Low-resource mode

On modest hardware, enable **"Low resource mode"** in Settings (or set
`python.lowResourceMode: true` in `config.json`) to run the smaller `gemma4:e2b`
model instead of `gemma4:12b`. Pull it first (`ollama pull gemma4:e2b`). Override
the model or endpoint any time with `PYTHOS_OLLAMA_MODEL` / `PYTHOS_OLLAMA_URL`.

## MCP tool support

Pythos can connect to external [Model Context Protocol](https://modelcontextprotocol.io)
servers and expose their tools to the local Gemma assistant automatically.
Configure servers under the `mcp` key in `config.json`:

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "name": "filesystem",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      },
      {
        "name": "docs",
        "transport": "http",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    ]
  }
}
```

- `enabled` (top-level) turns the whole MCP subsystem on or off.
- Each server needs a unique `name`; it namespaces the tools as `mcp_<server>_<tool>`.
- `transport` is `stdio` (spawns `command`/`args`, optional `env`/`cwd`) or `http`
  (streamable HTTP `url`, optional `headers`).
- Individual servers can be disabled with `"enabled": false`.

On startup (and after saving settings) Pythos connects to each enabled server,
discovers its tools, and adds them to Gemma's function-calling toolset. Connection
state is available via the `mcp:getStatus` IPC channel and `mcp:status` events.
Servers that fail to connect are skipped and logged without blocking the app.

## Android Remote over Tailscale

A native Android client lives at `android/pythos-remote`. It connects to this
desktop bridge over Tailscale and sends prompts back to the machine, so local
commands such as `open excel` still execute on the desktop. Turn any old phone
into a private smart speaker.

Use this server URL in the phone app:

```text
http://<tailscale-ip-or-magicdns-name>:9000
```

The phone sends heartbeat events and appears as an orbiting node in the desktop orb.

## Alexa / Echo Remote

The same bridge accepts Alexa/Echo clients on port `9000`.

- Realtime websocket: `ws://<tailscale-ip-or-magicdns-name>:9000/echo`
- Audio prompt upload: `http://<tailscale-ip-or-magicdns-name>:9000/api/audio/request`
- Text prompt: `http://<tailscale-ip-or-magicdns-name>:9000/api/text/request`

Alexa/Echo clients can include `deviceId`, `sessionId`, and `deviceName` as query
params or request fields. An Echo websocket without identity fields is registered
as `echo-node` and shown as `Alexa` in the desktop orbit.

## Test

```bash
npm test                 # TypeScript (vitest)
npm run test:python      # Python (pytest)
# or: ./scripts/test.sh  (macOS/Linux) / .\scripts\test.ps1 (Windows)
```

## Worker Protocol

Commands are JSONL objects sent to stdin: `start_listening`, `stop_listening`,
`speak`, `stop_speaking`, `shutdown`.

Events are JSONL objects emitted to stdout: `state`, `audio_level`,
`partial_transcript`, `final_transcript`, `tts_started`, `tts_done`, `error`.

## Notes

- The LLM backend is **local Gemma 4 via Ollama** — no cloud key, no data leaves
  the machine. Configure it under the `ollama` key in `config.json`.
- `GEMINI_API_KEY` is **not** used by the assistant anymore. It is only relevant
  for the optional, off-by-default experimental Pi tool bridge (`pi.enabled`).
- The default ASR model is the full `vosk-model-en-us-0.22` under `Models/vosk`;
  `scripts/install-vosk-model.*` can reinstall it. These are for the offline-voice
  fallback path.
