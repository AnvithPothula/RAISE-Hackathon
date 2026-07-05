# Pythos v3

Pythos is a voice assistant whose **brain never leaves your machine**. Wake word,
conversation, tool calling, and screen understanding all run on-device with
**Gemma 4 via [Ollama](https://ollama.com)** — so it keeps working when the
internet doesn't, and your prompts and screen never get shipped to a datacenter.

Built for the RAISE Summit Hackathon 2026 (Google DeepMind Remote / on-device Gemma track).

Pythos is a voice agent that *acts* — it is not a dashboard, not a chatbot, and not RAG.

## Built during RAISE 2026 (July 4–5)

Work created at the event (see git history on `main`):

- **Gemma 4 on-device brain** — full migration from cloud Gemini to local Ollama (`gemma4:12b`), including tool calling, vision, and adaptive thinking
- **Offline voice fallback** — a network-state detector swaps the streaming Gradium cloud voice for on-device Vosk STT + Piper/system TTS the moment the network drops (or when no API key is set); the Gemma brain never notices
- **Agentic loops** — `deep_research` self-looping research agent (auto-routed for explicit research/compare prompts), local sub-agents, `run_code` sandbox
- **Calendar integration** — add/list dated events via macOS Calendar (AppleScript); alarm requests create Calendar events instead of native Clock alarms
- **Deterministic intent routing** — `intentRouter.ts` matches weather, calendar, alarms, clipboard, screen, Spotify play, and more before Gemma runs; compound requests execute multiple direct tools in parallel
- **Free web search** — DuckDuckGo HTML parsing (no API key); specific URLs open via `open_website` with full paths and query strings preserved
- **Cursor integration** — optional `delegate_coding_task` via Cursor agent CLI when installed
- **MCP connector layer** — pythos-system, filesystem, and memory servers with live status in the UI
- **Demo HUD** — on-device badge, live voice-mode indicator (cloud vs local), tok/s + TTFT performance stats for judges
- **MLX engine variant** — Settings toggle to serve the Apple-Silicon MLX build (`gemma4:12b-mlx`) with automatic fallback to the standard build
- **Gradium streaming voice**, cross-platform/Mac support, Alexa/Android remote bridge, SSL fix

## Architecture

- **Brain (local):** Gemma 4 served by Ollama at `http://127.0.0.1:11434`. Reasoning,
  tool calling, and sub-agents run fully on-device — no cloud LLM, no API key.
- **Screen understanding (local):** "what's on my screen?" is answered by Gemma 4
  vision; the screenshot never leaves the machine.
- **Tools:** transport-agnostic tool runtime (`src/main/toolRuntime.ts`) — weather,
  Calendar events (add/list), calendar-backed alarm requests, Spotify, open
  app/website (including specific URL paths), free DuckDuckGo web search,
  calculator, memory, MCP tools.
- **Intent router:** `src/main/intentRouter.ts` resolves common voice commands
  deterministically before the LLM is called. Supports contextual follow-ups
  (e.g. a date-only reply after "add X's birthday on Wednesday"), STT
  mishearing recovery ("added" → add, garbled alarm phrases), and parallel
  execution of independent tools in compound requests ("what's the temperature
  and add Mbappe's birthday on December 20th").
- **Electron main:** process supervision, typed IPC, tool dispatch, Echo/Android bridge.
- **React renderer:** voice orb visualizer, transcript, controls, tool timeline.
- **Voice (hybrid, offline-resilient):** with a `GRADIUM_API_KEY` and a live
  network, wake word, STT, and TTS stream through the Gradium cloud API for
  studio quality. A network-state detector (`src/pythos/network_monitor.py`)
  swaps to the fully local stack — Vosk STT + Piper or the OS system voice —
  per turn and even mid-stream when the connection dies, so voice keeps
  working offline. With no API key the local stack is simply the default.
  The active mode is announced over `voice_mode` events and shown in the HUD.
- **Python worker:** audio capture/playback and the speech pipeline (no LLM).

## Prerequisites

- **[Ollama](https://ollama.com/download)** with a Gemma 4 model pulled (the brain).
- **Node.js 20+** and **Python 3.11+**.
- **PortAudio** (for PyAudio): macOS `brew install portaudio`; Debian/Ubuntu
  `sudo apt-get install -y portaudio19-dev`.

## Setup

> **Start here:** clone the repo, then work from the `v3/` directory. See the [root README](../README.md) for full install instructions.

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

From the `v3/` directory:

```bash
# macOS / Linux
chmod +x scripts/*.sh          # first time only
./scripts/setup-venv.sh
npm install

# Windows PowerShell
.\scripts\setup-venv.ps1
npm install
```

No API key is required to run the assistant. Spoken voice works offline out of
the box (Vosk STT + Piper or OS TTS). For studio-quality cloud voice when
online, add `GRADIUM_API_KEY` — see `API_KEYS_SETUP.txt`. Web search is free
via DuckDuckGo and needs no key.

### 3. (Optional) Offline speech recognition

Speech *output* works offline out of the box (Piper when installed, otherwise
the OS voice — macOS `say`, Windows `System.Speech`, Linux `espeak-ng`). For
offline speech *input* (mic + wake word with no network/key), download the
Vosk model once:

```bash
./scripts/install-vosk-model.sh          # macOS / Linux
# .\scripts\install-vosk-model.ps1        # Windows PowerShell
```

Without it, offline sessions are typed-input + spoken-output; the HUD shows
the exact mode either way.

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

### MLX engine variant (Apple Silicon)

For higher decode throughput on M-series Macs, set **Settings → Engine
variant → MLX** (or `ollama.engineVariant: "mlx"`). Pythos then serves the
MLX build of the active model (e.g. `gemma4:12b-mlx`, `gemma4:e2b-mlx`):

```bash
ollama pull gemma4:12b-mlx   # match whichever base model you use
```

The toggle is safe everywhere: on non-Apple-Silicon hosts, or when the MLX
tag is not pulled, Pythos automatically degrades to the standard build (the
perf HUD names the model that actually served each turn).

## Intent routing

Pythos uses a two-layer tool strategy for speed and reliability:

| Layer | What runs | Examples |
|-------|-----------|----------|
| **Instant (zero LLM)** | `intentRouter.ts` matches and executes locally | Weather, time, math, Calendar add/list, alarm→Calendar, memory, open app/site, web search, clipboard, screen vision, folder listing, Spotify play, capabilities |
| **`none` tool scope** | Gemma answers with zero tools | General knowledge, history, definitions, chat |
| **`minimal` scope** | Small tool surface | Simple operational prompts |
| **`standard` scope** | MCP system + filesystem tools | File/folder queries |
| **`full` scope** | All tools including agents | Research, code, compare, multi-part requests |

Compound requests that match multiple instant tools (e.g. weather + calendar add)
run in parallel via `Promise.all` — no sequential waiting.

Voice transcripts are normalized before routing (`voiceTranscript.ts`) to fix
common STT mishearings ("set in alarm" → "set an alarm", "added" → "add").

## Calendar and alarms

macOS Calendar is the source of truth for dated items:

- **Add events:** "Add Vedans' birthday on October 30th" → Calendar event (silent, no UI pop-up)
- **List schedule:** "What do I have in the morning on Wednesday?" → reads Calendar via AppleScript
- **Alarm requests:** "Set an alarm for 5 AM" → timed Calendar event (Pythos cannot create native Clock alarms; responses say so honestly)
- **Follow-ups:** A date-only reply ("July 8th") links to the title from the previous turn

Calendar listing and creation are currently supported on macOS. Other platforms
return a clear unsupported message.

## MCP tool support

Pythos can connect to external [Model Context Protocol](https://modelcontextprotocol.io)
servers and expose their tools to the local Gemma assistant automatically.
Configure servers under the `mcp` key in `config.json`. **Default enabled:**
`system` (clipboard, stats, files, notes) and `filesystem` (home-sandboxed file
access). **Off by default:** `memory`, `sequential-thinking`, `puppeteer`,
`time`, `context7`, `github` — each has a `_comment` in config explaining why
(enabling too many MCP servers slows first-token latency and causes wrong tool
calls on local ~12B/e2b models).

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "name": "system",
        "enabled": true,
        "transport": "stdio",
        "command": "node",
        "args": ["scripts/pythos-mcp-server.mjs"]
      },
      {
        "name": "filesystem",
        "enabled": true,
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "{{PYTHOS_HOME}}"]
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
`partial_transcript`, `final_transcript`, `tts_started`, `tts_done`,
`voice_mode`, `error`.

`voice_mode` reports the live engine selection whenever it changes:

```json
{"type": "voice_mode", "payload": {"engine": "local", "online": false,
 "gradiumConfigured": true, "stt": "vosk", "tts": "piper",
 "reason": "network failure during speech recognition"}}
```

## Notes

### What runs where

| Component | Location | Offline? |
|-----------|----------|----------|
| LLM (Gemma 4) | Local Ollama | Yes |
| Screen vision | Local Ollama | Yes |
| Tool routing + execution | Local Electron main | Yes |
| Calendar events | macOS Calendar (AppleScript) | Yes |
| Web search | DuckDuckGo HTML (network needed) | No |
| Voice STT/TTS (default) | Local Vosk + Piper/OS voice | Yes |
| Voice STT/TTS (optional) | Gradium cloud | No |
| Android/Alexa remote | Thin client → desktop bridge | Client only; brain stays on desktop |

- The LLM backend is **local Gemma 4 via Ollama** — no cloud key, no data leaves
  the machine. Configure it under the `ollama` key in `config.json`.
- `GEMINI_API_KEY` is **not** used by the assistant anymore. It is only relevant
  for the optional, off-by-default experimental Pi tool bridge (`pi.enabled`).
- Web search uses **free DuckDuckGo HTML parsing** by default — no
  `PYTHOS_WEB_SEARCH_KEY` or Brave API key required. The Pi bridge extension
  (`pythos-safe-tools.ts`) uses the same path.
- Per-user settings are stored in the OS user-data directory
  (`~/Library/Application Support/Pythos/user-settings.json` on macOS), not in
  the committed `config.json`. Each user's toggles survive app restarts without
  clobbering team defaults.
- The offline ASR model is the full `vosk-model-en-us-0.22` under `Models/vosk`;
  install it with `scripts/install-vosk-model.*`. Offline TTS prefers a Piper
  install at the `models.piper*` paths in `config.json` and otherwise uses the
  OS system voice, so spoken replies never require extra setup.
