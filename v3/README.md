# Pythos v3

Pythos v3 is a dev-first rebuild of v2 with a Python audio worker, Electron/React desktop UI, and Pi RPC tools/skills.

## Architecture

- Python worker: Vosk ASR, Piper TTS, model path validation, JSONL protocol.
- Electron main: process supervision, typed IPC, Pi RPC bridge.
- React renderer: modern voice orb visualizer, transcript, controls, and tool timeline.
- Pi project hooks: safe local tools in `.pi/extensions` and skills in `.pi/skills`.
- Speech: wake-word detection, STT, and TTS all run through the Gradium cloud API; legacy Vosk/Piper assets in `v3/Models` are kept only for backward compatibility. The LLM runs on the Google AI Studio (Gemini) API.

## Setup

```powershell
cd C:\Helper-Base\v3
.\scripts\setup-venv.ps1
npm install
.\scripts\install-pi-models.ps1
```

Install Pi separately if `pi` is not already on PATH:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## Gemini API key

Pythos uses the Google AI Studio (Gemini) API for language and vision. Create a key at
https://aistudio.google.com/apikey, then add it to `v3/.env`:

```powershell
cd C:\Helper-Base\v3
Copy-Item .env.example .env -Force
Add-Content .env "GEMINI_API_KEY=your_key_here"
```

The same `GEMINI_API_KEY` is used by both the direct Gemini client and the Pi bridge.

## MCP tool support

Pythos can connect to external [Model Context Protocol](https://modelcontextprotocol.io) servers and
expose their tools to the Gemini assistant automatically. Configure servers under the `mcp` key in
`config.json`:

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
- `transport` is `stdio` (spawns `command`/`args`, optional `env`/`cwd`) or `http` (streamable HTTP `url`, optional `headers`).
- Individual servers can be disabled with `"enabled": false`.

On startup (and after saving settings) Pythos connects to each enabled server, discovers its tools, and
adds them to Gemini's function-calling toolset. Connection state is available in the main process via the
`mcp:getStatus` IPC channel and `mcp:status` events. Servers that fail to connect are skipped and logged
without blocking the rest of the app.

## Run

```powershell
cd C:\Helper-Base\v3
npm run dev
```

## Android Remote over Tailscale

A native Android client lives at `android/pythos-remote`. It connects to this desktop bridge over Tailscale and sends prompts back to the PC, so local commands such as `open excel` still execute on Windows.

Use this server URL in the phone app:

```text
http://<pc-tailscale-ip-or-magicdns-name>:9000
```

The phone sends heartbeat events and appears as an orbiting node in the desktop orb while connected.

## Alexa / Echo Remote

The same bridge also accepts Alexa/Echo clients on port `9000`.

- Realtime websocket: `ws://<pc-tailscale-ip-or-magicdns-name>:9000/echo`
- Audio prompt upload: `http://<pc-tailscale-ip-or-magicdns-name>:9000/api/audio/request`
- Text prompt: `http://<pc-tailscale-ip-or-magicdns-name>:9000/api/text/request`

Alexa/Echo clients can include `deviceId`, `sessionId`, and `deviceName` as query params or request fields. If an Echo websocket connects without identity fields, it is registered as `echo-node` and shown as `Alexa` in the desktop orbit.

## Test

```powershell
cd C:\Helper-Base\v3
.\scripts\test.ps1
```

## Worker Protocol

Commands are JSONL objects sent to stdin:

- `start_listening`
- `stop_listening`
- `speak`
- `stop_speaking`
- `shutdown`

Events are JSONL objects emitted to stdout:

- `state`
- `audio_level`
- `partial_transcript`
- `final_transcript`
- `tts_started`
- `tts_done`
- `error`

## Notes

- `config.json` defaults to low-resource hotkey-style operation.
- The default ASR model is the full `vosk-model-en-us-0.22` under `Models/vosk` for better recognition tolerance. It loads slower than the small model.
- `scripts/install-vosk-model.ps1` can reinstall the full Vosk model if it is missing. The smaller `vosk-model-small-en-us-0.15` model remains available as a faster fallback.
- The Google AI Studio (Gemini) API is the LLM backend; set `GEMINI_API_KEY` in `v3/.env`.
- The Pi bridge starts `pi --mode rpc --no-session --model gemini/gemini-2.5-flash`.
- Pi custom models are included at `.pi/models.json` (a `gemini` provider pointing at Google's OpenAI-compatible endpoint); `scripts/install-pi-models.ps1` copies that file to `~/.pi/agent/models.json`.
