# Pythos — Battle Plan for #1, Google DeepMind Remote Track (RAISE 2026)

**Track:** "The Edge / On-Device Track: Best mobile, web, or edge application running **Gemma locally** for **offline, privacy-first inference**."
**Deadline:** Sunday July 5, 12:00 PM (⚠️ verify timezone — if that's Paris time, it's ~5:00 AM CDT for a remote US team).
**Judging:** Demo **50%** · Impact 25% · Creativity 15% · Pitch 10%. Remote judges see only: 1-minute video, project description, GitHub repo.

---

## Executive Summary

Pythos today is a strong voice assistant with the **wrong brain for this track**: cloud Gemini for inference and cloud Gradium for voice. The track is judged on *Gemma running locally* — a cloud-LLM submission loses to any working on-device Gemma project, regardless of polish.

The research says the fix is not just feasible in the remaining hours, it is *the proven winning narrative*: the 2nd-place Gemma 3n Impact Challenge project ("Vite Vere Offline") was **explicitly built on the Gemini API first, then moved to Gemma to work offline** — Google's own blog celebrates that arc. Ollama's `gemma4` models ship with native **tool calling**, **vision**, and 128K–256K context; your repo's git history already contains an Ollama client (`ollamaFallback.ts`, `ollamaRuntime.ts`) and the original config shipped `gemma4:e2b`. The pivot is largely a *restoration*, not a rebuild.

The winning shape: **"Pythos — the voice assistant whose brain never leaves your machine."** Wake word local (openWakeWord), reasoning + tool calling local (Gemma 4 via Ollama), screen understanding local (Gemma 4 vision), memory local. The demo's money shot: **turn Wi-Fi off mid-conversation and keep talking to it.** Cloud Gradium voice becomes an *optional enhancement* that gracefully degrades to a local voice stack (Vosk/Piper — both already in your git history) when offline.

---

## Key Research Findings

1. **Gemma-local is non-negotiable and the pivot is cheap.** Ollama `gemma4` tags: `vision · tools · thinking · audio`; models: `e2b` 7.2 GB/128K, `e4b` 9.6 GB/128K, `12b` 7.6 GB/**256K** — all trivially fit the 24 GB M4 demo machine. Native function calling and system-prompt support are headline Gemma 4 features. ([ollama.com/library/gemma4](https://ollama.com/library/gemma4), [ai.google.dev/gemma/docs/core](https://ai.google.dev/gemma/docs/core))
2. **Speed is a solved problem on this hardware.** Google's LiteRT benchmarks: Gemma 4 E2B on a MacBook Pro M4 = **901 tok/s prefill / 42 tok/s decode on CPU, 7,835 / 160 tok/s on GPU**, TTFT 0.1–1.1 s. Human speech is ~4–5 tok/s — anything above ~15 tok/s feels instant through TTS. ([developers.google.com/edge/litert-lm/models/gemma-4](https://developers.google.com/edge/litert-lm/models/gemma-4))
3. **Tool-calling ability scales sharply with size** (Tau2 agentic benchmark: E2B 24.5%, E4B 42.2%, larger models much higher). For a *tool-calling* assistant, default to **`gemma4:12b`** (7.6 GB, 256K ctx, dense) on the demo machine and keep `gemma4:e2b` as the documented low-resource mode — the app already has a `lowResourceMode` flag. ([ollama.com/library/gemma4](https://ollama.com/library/gemma4))
4. **What wins Google's own on-device judging:** the Gemma 3n Impact Challenge winners were all (a) singular-focus, (b) offline/privacy as the *load-bearing reason the product works*, (c) real-user grounded, (d) honest hybrid engineering — 1st place ("Gemma Vision") openly paired Gemma with ML Kit OCR because Gemma hallucinated text, and told a "50 s → 5 s" latency-fix story. Judges reward transparent engineering trade-offs, not purity. ([blog.google — winners](https://blog.google/innovation-and-ai/technology/developers-tools/developers-changing-lives-with-gemma-3n/), [Gemma Vision writeup](https://www.kaggle.com/competitions/google-gemma-3n-hackathon/writeups/gemma-vision))
5. **The 2nd-place arc is literally your arc:** "Originally developed using the Gemini API, this project leveraged Gemma 3n to make the digital companion work offline." Tell that story explicitly. ([blog.google](https://blog.google/innovation-and-ai/technology/developers-tools/developers-changing-lives-with-gemma-3n/))
6. **Demo ≥ everything (50%).** Judge consensus: start with the problem, show one flow working within ~90 s, scope down ("if the demo is too long, cut features"), be direct about what works and what doesn't, pre-empt every stall. ([JetBrains judging-table notes](https://blog.jetbrains.com/ai/2026/06/how-to-win-a-hackathon-notes-from-the-judging-table/))
7. **Video mechanics matter:** script it yourself with timed beats; show the real product running (no slide decks); upload to YouTube early, mark **"Not made for kids"**, check it's not private; leave 2–3 h buffer for record/edit/upload. ([Devpost demo-video guide](https://info.devpost.com/blog/6-tips-for-making-a-hackathon-demo-video))
8. **Gemma 4 QAT exists if you need smaller/faster:** official Q4_0 GGUF checkpoints for llama.cpp/Ollama/LM Studio; E2B mobile footprint down to ~1 GB text-only. Useful for the pitch ("runs on a 8 GB laptop too"), not needed on the M4. ([blog.google QAT](https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/))
9. **Gemma 4 function-calling format is documented and parseable** (`<|tool_call>call:name{...}` wire format with a reference regex parser) — but via Ollama you get structured `tool_calls` JSON for free; only drop to raw parsing if Ollama's layer misbehaves. ([ai.google.dev function-calling guide](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4))
10. **E2B/E4B accept native audio input** (~300 M audio encoder; CoVoST/FLEURS benchmarked). Speech → Gemma directly, no STT model, is a *stretch* wow-factor — treat as P2 because Ollama's audio-input path is unproven for us. ([ollama.com/library/gemma4](https://ollama.com/library/gemma4))

---

## The Strategy

### One sentence
**"We de-clouded the voice assistant: Alexa-class capability — wake word, conversation, tools, screen understanding, memory — with Gemma 4 running entirely on your own machine, so it keeps working when the internet doesn't and your voice never leaves the room."**

### Why this wins each criterion
- **Impact (25%):** Everyone owns a cloud speaker that ships their household audio to a datacenter. A drop-in private alternative (plus the Android/Alexa remote node = "turn any old phone into a private smart speaker") is a real product wedge. Privacy + offline resilience is exactly the story Google's edge team promotes.
- **Demo (50%):** One rehearsed flow with a mid-demo **Wi-Fi kill switch** — the single "oh, this is possible now" moment the JetBrains judges describe.
- **Creativity (15%):** Local screen-understanding ("what's on my screen?" answered by Gemma 4 vision without the screenshot leaving the device) + hybrid voice that audibly degrades from studio-quality cloud TTS to local TTS when offline — you can *hear* the offline transition, which is memorable.
- **Pitch (10%):** The Gemini→Gemma migration story, told honestly, mirrors the 2nd-place Gemma 3n winner.

### Banned-category check
Voice-first agentic assistant: not RAG, not a dashboard, not Streamlit, none of the banned archetypes. ✅

---

## Execution Plan

Team of 2 (Anvith + Griffin). Times are aggressive but real. **P0 = must ship. P1 = ship if on schedule. P2 = only if ahead.**

### P0 — Gemma on-device brain (est. 4–5 h, highest risk first)
1. `brew install ollama && ollama pull gemma4:12b && ollama pull gemma4:e2b` (~15 GB; start the pull **now**, it's the long pole).
2. Add `gemmaClient.ts` beside `geminiClient.ts` (or restore/modernize `ollamaFallback.ts` from git history): POST `http://localhost:11434/api/chat` with `tools:` = the existing `FUNCTION_DECLARATIONS`, stream on, `temperature 1.0 / top_p 0.95 / top_k 64` (Gemma 4 recommended sampling), thinking off for latency.
3. Route `main.ts` LLM calls to Gemma; keep the tool-execution loop (`runNamedLocalTool`) untouched — it's transport-agnostic.
4. Point `inspect_screen` at Ollama with `images:[base64]` → **local screen understanding**.
5. Auto-start `ollama serve` from Electron if not running (the old `ollamaRuntime.ts` did this — restore it).
6. Update `config.json`: model `gemma4:12b`, `lowResourceMode` → `gemma4:e2b`.
7. Verify each existing tool (weather, alarm, Spotify, open app, memory) fires correctly from voice → Gemma → tool → spoken answer. Fix prompt/schema drift — expect 12B to need at most light system-prompt nudges.

### P0 — Offline mode + kill switch (est. 2–3 h)
8. Resurrect Vosk STT + Piper TTS from git history (commit `4cd88d7`-era files, install scripts already exist) behind a **network-state detector**: online → Gradium voice; offline → local voice. Gemma path never changes.
9. UI badge: **"● All inference on-device"** plus mode indicator ("Voice: Gradium (online)" / "Voice: Local (offline)"). Judges must *see* the claim.
10. Rehearse the Wi-Fi-off transition until it's boringly reliable. Cache a weather/tool failure gracefully offline (tools that need网 should say so, not hang).

### P0 — Compliance & repo (est. 1.5 h — do not skip, this is a disqualification lever)
11. **"New Work Only" transparency:** the rules disqualify anything where judges can't identify event-built work. The repo has a pre-event-looking "Base" commit. Add a prominent README section — **"Built during RAISE 2026 (July 4–5)"** — listing exactly what was created at the event (Gradium streaming voice integration, cross-platform/mac support, Gemma 4 on-device migration, offline mode, Alexa/Android remote bridge work, SSL fix), with commit links. Say it in the video too ("this weekend we…"). Honesty here is cheap; ambiguity is fatal.
12. README rewrite for judges: hero GIF, 3-step run (`ollama pull gemma4:12b` → `npm install` → `npm run dev`), architecture diagram (mic → openWakeWord → Gemma 4 (Ollama, local) → tools → TTS), privacy table (what runs where), Gemma-4-specific features used (function calling, vision, 256K ctx, system role). Repo must be **public**.
13. `.env.example` + API_KEYS_SETUP.txt already handle keys — confirm no secrets in git (`git log -p | grep -i key` spot-check).

### P1 — Demo-strengtheners (est. 2 h)
14. On-screen perf HUD during demo: tokens/sec + TTFT from Ollama's response metrics (`eval_count/eval_duration`) — judges love visible numbers; `showPerformanceStats` flag already exists.
15. Android remote / Echo node demo beat: "any old phone becomes a private smart speaker" (the bridge already exists; show one round-trip).
16. Persistent local memory beat: "remember that my girlfriend's birthday is March 3rd" → restart app offline → recall. Memory + privacy in one beat.

### P2 — Only if ahead of schedule
17. Native audio-in to Gemma E4B (skip STT entirely) — wow factor, unproven via Ollama; timebox 1 h of investigation max.
18. MLX variant (`gemma4:12b-mlx`) A/B for tok/s bragging rights.
19. Landing page (Gemma Vision had one; nice-to-have, not judged directly).

### Cut list (explicitly do NOT spend time on)
- Fine-tuning anything. No time, no need.
- UI redesign beyond demo badges/HUD. The orb UI is already demo-ready.

---

## Shipped Status (updated July 4, 2026 — event day)

### Demo-day reliability fixes (from live dev-run log) ✅
Real failures caught running `npm run dev` and fixed:

| Symptom in log | Root cause | Fix |
|----------------|-----------|-----|
| "Open up Chrome." → Gemma said *"I can't open apps"* | Direct matcher missed the filler word "up"; then a 48-tool prompt made the 12B model hallucinate it was a file agent | Matcher now handles "open up/my/a X", "pull up X"; system prompt is cross-platform + explicitly affirms `open_app` |
| "What's in my Downloads?" → `ENOENT .../v3/Downloads` | npx filesystem MCP was rooted at the repo | Disabled filesystem+memory MCP by default; the local `system` MCP server's home-sandboxed `list_directory` handles it correctly |
| **TTFT 20–26s** per prompt | No `keep_alive` (model reloaded each turn) + 48 tools inflating prompt eval | `keep_alive: 30m` + startup warm-up (`warmUpModel`); MCP trimmed 48→25 tools. **Measured TTFT 20s → 1.7s, tok/s 11 → 17** |
| System prompt said "Windows voice assistant" on a Mac | Stale copy | Rewritten cross-platform, adds `run_code`/`deep_research`, anti-"I can't" steer |

### Second dev-run: quick-reply chips "don't work", still slow ✅
Root cause was **latency + turn staleness**: on this (bandwidth-limited) Mac, `gemma4:12b` runs ~6–9 tok/s with 20s+ TTFT, so clicking multiple chips (or talking) made each new turn cancel the previous one (`stale gemma response ignored`) before it returned. Only instant direct-tool matches (e.g. "open messages") completed. Fixes:

| Chip / command | Before | After |
|----------------|--------|-------|
| "What can you do?" | 20s LLM call, often cancelled | **Instant** canned capability summary (`capabilities`, no model) |
| "Open my calendar" | worked (direct) | still direct `open_app` |
| "Play something relaxing" | LLM, slow | **Instant** direct `control_spotify` play (new generic "play X" matcher) |
| "Turn on do not disturb" | **no tool existed** → refusal | new `set_do_not_disturb` tool (mac Shortcut / win focus-assist / linux gsettings) + instant direct matcher |
| "Summarize my clipboard" | LLM | still LLM (needs clipboard read+summarize); faster via warm-up + smaller model |

Speed work: `warmUpModel` now pre-evaluates the real system-prompt + tool prefix at startup (caches the KV so first-token is fast, not just weight-load); system MCP trimmed 11→8 tools (dropped duplicate `get_datetime`, risky `write_text_file`, `read_text_file`). Pulling `gemma4:e2b`/`e4b` for a 3–5× speedup — switch via **Settings → Low resource mode** (uses `gemma4:e2b`) once the pull finishes. Tests: 51 pass, typecheck clean.

### Third pass: only ship features that work with zero user setup ✅
Rule applied: every quick-reply chip under the input must be something `gemma4:12b` can actually do on the demo machine with **no extra user steps**. Audited each:

| Chip | Feature | Works no-setup? |
|------|---------|-----------------|
| "What can you do?" | `capabilities` (instant, local) | ✅ |
| "What's on my screen?" | local Gemma 4 vision via direct `screen` matcher (one on-device vision call, no tool-selection round trip) | ✅ (macOS asks for Screen Recording permission once — an OS gate for *any* screen feature, one click, not a workaround) |
| "Open my calendar" | direct `open_app` (instant) | ✅ |
| "Summarize my clipboard" | clipboard read + local summary | ✅ |
| "Play something relaxing" | direct `control_spotify` play | ✅ (graceful "log in" prompt if Spotify not authed) |

**Removed "Turn on do not disturb" entirely.** macOS 26.5 has no reliable no-setup way to toggle Focus/DND: the legacy `defaults`+`killall` method is dead, the `shortcuts` CLI can't create a shortcut programmatically, and UI automation needs Accessibility permission. Per the "don't list features that aren't possible" rule, the DND tool, declaration, matcher, and chip were all deleted rather than shipping a shortcut-dependent stub. Replaced with the on-device **screen vision** chip — the single most on-theme feature for this track (local multimodal Gemma). Tests: 51 pass, both TS projects typecheck clean.

### Fourth pass: MCP tool-overload postmortem (from a live demo log) ✅
A teammate had enabled **5 MCP servers** (`system`, `sequential-thinking`, `puppeteer`, `time`, `context7`) and left the model on `gemma4:12b`. The live log showed the classic overload failure mode:

- "why do we celebrate 4th of July" → model called `sequential-thinking`, then `context7` with the nonsense query *"how to change icon color on hover"*, then `time` → **timed out after ~4.5 min**. A general-knowledge question needs zero tools.
- "Summarize my clipboard" → model hallucinated *"I don't have clipboard access"* instead of calling the clipboard tool.

Fixes:

| Fix | Detail |
|-----|--------|
| **Disabled the overload servers** | `sequential-thinking` (Gemma has native adaptive thinking), `puppeteer` (~7 irrelevant browser tools), `time` (duplicate of built-in `get_time`), `context7` (code-docs, irrelevant). Left enabled + documented in `config.json` with reasons. Only `system` stays on. |
| **Default to fast `e2b`** | `lowResourceMode: true`. Benchmarked: **e2b 0.54s TTFT / 48 tok/s vs 12b 1.07s / 11.6 tok/s.** Toggle off in Settings for 12b quality. |
| **Reliable clipboard** | New local `clipboard` read tool (pbpaste/PowerShell/xclip) + direct matcher → "What's on my clipboard?" reads instantly, no model round-trip. Chip renamed from "Summarize my clipboard". |
| **Answer general questions directly** | System-prompt rule: for facts/history/explanations the model knows, answer directly and never call an unrelated tool. **Verified live:** "why do we celebrate 4th of July" → `tools=[none]`, correct answer, no timeout. |

Lesson (reinforces the plan's "few working tools beat many flaky ones"): on a local ~12B/e2b model, every extra MCP tool schema both slows first-token latency and raises the odds of a wrong/irrelevant tool call. Keep the default tool surface tight; enable extra connectors only for a specific scripted demo beat. Tests: 62 pass, typecheck clean.

### Per-user settings (no more shared-config clobbering) ✅
Root of the previous regression: the app saved settings by rewriting the committed `config.json`, so one teammate enabling 5 MCP servers (or toggling the model) changed it for **everyone** and showed up in git. Now:

- `config.json` is **shared, read-only defaults** — the app never writes it.
- Each user's changes are saved as a **delta** in their own OS user-data dir (`~/Library/Application Support/Pythos/user-settings.json` on macOS, `%APPDATA%\Pythos\...` on Windows, `~/.config/Pythos/...` on Linux; override with `PYTHOS_SETTINGS_PATH`).
- `readConfig` deep-merges the user delta over defaults, so unchanged fields still track team defaults and each user's prefs survive quitting the app.

Implemented in `config.ts` (`deepMerge`/`deepDiff`, `userSettingsPath`); 4 new tests assert the delta-only write and that `config.json` is never modified. Tests: 66 pass, typecheck clean.

### Fifth pass: intent routing merged + hackathon-tuned ✅
Merged `Intent-based` into `main` and optimized for demo reliability:

| Layer | Behavior |
|-------|----------|
| **Instant (zero LLM)** | Weather, time, math, alarms, memory, open app/site, web search, clipboard, screen vision, folder listing, Spotify play, capabilities — routed by `intentRouter.ts` before Gemma is called |
| **`none` tool scope** | General-knowledge questions (history, definitions, chat) get **zero tools** — fastest TTFT, no tool spirals. Verified: "why do we celebrate 4th of July" → `tools:none` |
| **`minimal` scope** | Simple operational prompts that still need inference but not heavy agents |
| **`standard` scope** | File/folder/screen/system queries — MCP `system` tools only, no heavy agents |
| **`full` scope** | Research, code, compare, long multi-part requests — all tools including `deep_research`, `run_code`, vision |

Other fixes: contextual Spotify follow-ups no longer skipped when a direct match exists; fallback path uses intent scope; demo HUD shows `tools:none/minimal/…` beside tok/s. Tests: **77 pass**.

### Sixth pass: offline voice fallback, live voice-mode HUD, MLX variant ✅
Closed the last P0 gap and both remaining stretch-capable items. The money-shot demo (kill Wi-Fi mid-conversation and **keep talking**) now works end-to-end:

| Layer | What shipped |
|-------|--------------|
| **Network-state detector** | `src/pythos/network_monitor.py` — dependency-free cached TCP probe (Gradium host + anycast DNS fallbacks, ~1 s timeout, 3 s TTL) plus `is_network_error()` classification that walks exception chains, so only genuine transport failures trigger fallback (an auth rejection still surfaces as a real error) |
| **Offline STT** | `src/pythos/local_voice.py` — Vosk engine restored/modernized from the pre-Gradium git history (`4cd88d7`): streaming partials, silence/ASR timeouts, wake word matched on live transcripts (same policy as the Gradium path, no extra wake model needed), plus a push-mode variant for the Echo bridge |
| **Offline TTS** | Defensive chain: **Piper** when the configured executable+voice exist (tolerates the committed Windows-era `piper.exe` path on mac/Linux) → **OS system voice** (`say` / `System.Speech` / `espeak-ng`) so spoken replies need zero setup on every OS. Verified on the demo Mac: `say` fallback writes a playable 22.05 kHz WAV |
| **Per-turn + mid-stream swap** | `SpeechListener` and the new `HybridSpeaker` consult a shared `VoiceModeReporter` before every turn and re-probe after any mid-stream network error — a Gradium socket dying mid-utterance falls back to the local engine for that same turn instead of erroring. Gemma brain path completely untouched |
| **No API key = local voice** | `GRADIUM_API_KEY` missing is no longer a startup error: the worker simply announces local voice mode (zero-setup rule) |
| **Demo HUD** | New `voice_mode` worker event → `main.ts` cache (+ `voice:getMode` IPC for late-loading renderers) → HUD badges: **● All inference on-device**, live **Voice: Gradium (cloud) / Local (offline) / text only**, and the perf line now shows **tok/s + TTFT + tokens + model** (task 14 finally renders TTFT). Browser offline events flip the badge instantly while the next probe confirms |
| **Echo/Android offline parity** | `echo_tools.py` and `echo_realtime_worker.py` select engines exactly like the desktop pipeline (Gradium ↔ Vosk push transcriber ↔ local synth), with engine names surfaced in bridge events |
| **MLX engine variant (P2 #18)** | `ollama.engineVariant` (`standard`/`mlx`) + Settings toggle. `src/shared/modelVariant.ts` gates MLX to Apple Silicon and produces the fallback candidate order (`gemma4:e2b-mlx → gemma4:e2b → gemma4:12b → gemma4:12b-mlx`), so enabling the toggle without pulling the MLX tag can never break inference; warm-up now primes the model that will actually serve |

Also fixed while in there: restored the `formatMacOpenFailure` export (its tests were silently broken at HEAD) and repaired a stale `config.test.ts` that used think-level values for `ollama.think`. Tests: **127 TS + 37 Python pass** (was 124/3-broken + 7); both TS projects typecheck clean; production build green.

### P0 — Gemma on-device brain ✅
| # | Task | Status |
|---|------|--------|
| 1 | `ollama pull gemma4:12b` (+ e2b for low-resource) | ✅ Scripts: `scripts/install-ollama-models.*` |
| 2 | Local Ollama client with tools + Gemma 4 sampling | ✅ `src/main/ollamaClient.ts` |
| 3 | Route all LLM paths to Gemma | ✅ `main.ts` → `generateWithOllama` |
| 4 | Local screen vision via Ollama `images:` | ✅ `analyzeImageWithOllama` |
| 5 | Auto-start `ollama serve` from Electron | ✅ `src/main/ollamaRuntime.ts` |
| 6 | `config.json`: `gemma4:12b`, low-resource → `gemma4:e2b` | ✅ |
| 7 | Tool verification (weather, alarm, Spotify, etc.) | ✅ 40 TS tests passing |

### P0 — Offline mode + kill switch ✅
| # | Task | Status |
|---|------|--------|
| 8 | Vosk STT + Piper TTS offline fallback | ✅ Wired behind a network-state detector (`network_monitor.py`); per-turn **and mid-stream** engine swap; TTS chain Piper → OS system voice so speech output needs zero setup; Gemma brain path untouched |
| 9 | UI badge "● All inference on-device" + mode indicator | ✅ Demo HUD in `App.tsx`: on-device badge + live "Voice: Gradium (cloud) / Local (offline)" driven by worker `voice_mode` events |
| 10 | Wi-Fi-off rehearsal | 🎬 Ready end-to-end: voice **and** typed prompts survive the kill switch; HUD flips live; TTS audibly switches to the local voice |

### P0 — Compliance & repo ✅
| # | Task | Status |
|---|------|--------|
| 11 | "Built during RAISE 2026" README section | ✅ |
| 12 | README rewrite (architecture, 3-step run, privacy) | ✅ |
| 13 | No secrets in git | ✅ `.env.example`, `API_KEYS_SETUP.txt` |

### P1 — Demo-strengtheners ✅
| # | Task | Status |
|---|------|--------|
| 14 | Perf HUD (tok/s, TTFT) | ✅ `ModelStats` → demo HUD; now renders **tok/s + TTFT + token count + model** from Ollama's `eval_count`/`eval_duration`/`prompt_eval_duration` (TTFT was computed but never displayed before) |
| 15 | Android/Echo remote demo beat | ✅ Bridge round-trip verified against the intent-routing layer; Echo STT/TTS now share the same offline fallback (Vosk push transcriber + local synth), so the remote node survives Wi-Fi loss too |
| 16 | Persistent local memory beat | ✅ `update_user_memory` tool; recall verified fully offline: "remember …" routes instantly (no model), memory file survives restart, recall questions run tool-free with memory injected into local Gemma context — tests cover the exact demo beat |

### Agentic enhancements (event-built, beyond original cut list) ✅
Shipped because they strengthen **Demo (50%)** and **Creativity (15%)** without violating the banned-category check:

| Feature | What it does | Where |
|---------|--------------|-------|
| **Adaptive thinking** | Auto-detects task complexity; enables Gemma `think:` for research/code/math, fast path for weather/alarms | `decideThinking()` in `ollamaClient.ts`; setting: `ollama.think` = auto/on/off |
| **Deep research loop** | Self-looping agent: search → reflect → search again → synthesize with sources | `deep_research` tool + `runDeepResearch()` |
| **Local code execution** | Runs Python/JS on-device with 20s timeout | `run_code` tool |
| **Cursor delegation** | Large coding tasks → Cursor agent CLI when installed (`delegate_coding_task`) | `localTools.ts`; env: `PYTHOS_CURSOR_WORKSPACE` |
| **MCP connectors** | pythos-system (clipboard, stats, files, notes), filesystem, memory | `config.json` mcp.servers; status panel in UI |
| **Sub-agent** | Bounded multi-tool loop for complex tasks | `run_sub_agent` → `runLocalSubAgent()` |

Brain stays **100% local Gemma**. MCP file tools and web_search are optional online enhancements layered on top — same honest hybrid story as Gemma Vision winners.

### P2 — Stretch
| # | Task | Status |
|---|------|--------|
| 17 | Native audio-in to Gemma E4B | ⏳ Deferred (Ollama audio-input path unproven; 1 h timebox stands) |
| 18 | MLX variant A/B | ✅ `ollama.engineVariant` setting + Settings → Engine variant toggle; clean abstraction in `src/shared/modelVariant.ts` (host gating + graceful candidate fallback); HUD names the model that actually served, so the A/B readout is live tok/s |
| 19 | Landing page | ⏳ Deferred (not judged directly) |

### Bonus track angles
- **Cursor track synergy:** Cursor agent delegation + local Gemma brain = "private voice assistant that can also ship code via Cursor when online."
- **Gradium partner:** Studio voice online; brain never leaves machine.
- **Cloudflare/Netlify:** Not primary — edge story is Ollama on laptop/phone bridge.

---

## Demo script updates (use new features)

| t | Beat |
|---|---|
| 18–30 s | **Tool call:** alarm + screen vision + **"research the best…"** → `deep_research` loops locally then answers |
| 30–42 s | **Kill Wi-Fi.** Keep **talking** — the reply voice audibly switches to the local engine and the HUD flips to **Voice: Local (offline)** beside **● All inference on-device** + tok/s/TTFT. Memory recall beat ("when is my girlfriend's birthday?") lands here |
| 42–52 s | Show **MCP Connectors** panel (system/filesystem/memory connected). Echo/Android node if time — it survives the same Wi-Fi kill |

---

## The 60-Second Video (script skeleton — record by T-3h)

| t | Beat |
|---|---|
| 0–8 s | Problem: "Every 'Hey-whatever' speaker streams your home audio to a datacenter. And dies when the Wi-Fi does." (shot: Echo + Wi-Fi icon) |
| 8–18 s | "Pythos runs the entire assistant on-device — Gemma 4 on my laptop." Wake word → ask → spoken answer. HUD shows tok/s + "all inference on-device." |
| 18–30 s | Tool call: "Set an alarm for 7" + "What's on my screen?" → Gemma 4 vision answers locally. |
| 30–42 s | **Kill the Wi-Fi on camera.** Ask again. It answers (voice audibly switches to local TTS). "The brain never left the machine." |
| 42–52 s | Old Android phone / Echo node round-trip: "any device becomes a private smart speaker." Memory recall beat if it fits. |
| 52–60 s | "Built this weekend on Gemma 4 — 12B, function calling, vision, 256K context, fully offline. Pythos." (repo URL on screen) |

Mechanics: OBS screen+face recording, best mic on the team, script read by one voice, YouTube unlisted → **Not made for kids**, link tested in incognito. Submission form filled at T-2h, not T-5min.

---

## Contrarian Views & Risks

- **"Keep Gradium, judges won't care."** Wrong for *this* track — the track title contains "running Gemma locally / offline / privacy-first." But the inverse over-correction (ripping Gradium out entirely) also loses: hybrid-with-honest-fallback is both the better product and the Gemma-Vision-style engineering story. Keep Gradium as the online voice; brand it as such. (It's also a RAISE partner — no downside.)
- **12B too slow on base M4?** Possible (dense 12B Q4 on ~120 GB/s bandwidth may land ~10–15 tok/s). Mitigation: it still outpaces speech; if TTFT feels laggy in rehearsal, drop to `gemma4:e4b` — Tau2 42% is adequate for your six well-described tools. Decide by benchmark, not vibes (task 14's HUD tells you).
- **Tool-call reliability on small models.** E2B is weak at agentic calls (Tau2 24.5%) — that's why 12B/E4B is the default and E2B is only the documented low-resource mode. If a tool misfires in rehearsal, tighten that tool's description (the function-calling guide stresses precise schemas/docstrings).
- **Deadline timezone.** If 12:00 PM is Paris, US-remote runway is ~5 h shorter than it feels. **Verify tonight in Discord.** Plan above assumes the worse case.
- **Disqualification via "New Work Only."** Handled by task 11; do not skip it.
- **Ollama audio-input for E2B/E4B** may not work at all — that's why it's P2 with a 1 h timebox.

## Open Questions
1. Submission deadline timezone (Paris vs. local) — ask in Discord now.
2. Does the submission form cap video at 1 min hard, or "short ~1 min"? Script assumes 60 s.
3. Whose machine records the demo (M4/24 GB is the known-good target)?

## Sources
- https://ollama.com/library/gemma4 — sizes, tools/vision/audio tags, benchmarks, sampling params
- https://ai.google.dev/gemma/docs/core — Gemma 4 overview, memory table, QAT routing
- https://developers.google.com/edge/litert-lm/models/gemma-4 — M4 tok/s benchmarks, MTP
- https://blog.google/innovation-and-ai/technology/developers-tools/quantization-aware-training-gemma-4/ — QAT sizes (E2B <1 GB)
- https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4 — function-calling format + parser
- https://blog.google/innovation-and-ai/technology/developers-tools/developers-changing-lives-with-gemma-3n/ — winner profiles incl. Gemini→Gemma 2nd place
- https://www.kaggle.com/competitions/google-gemma-3n-hackathon/writeups/gemma-vision — 1st-place writeup (hybrid engineering, latency story, real user)
- https://blog.jetbrains.com/ai/2026/06/how-to-win-a-hackathon-notes-from-the-judging-table/ — judge consensus (problem-first, one flow, 90 s)
- https://info.devpost.com/blog/6-tips-for-making-a-hackathon-demo-video — video mechanics
- https://unsloth.ai/docs/models/gemma-4 · https://huggingface.co/collections/google/gemma-4-qat-q4-0 · https://github.com/moonshine-ai/moonshine — supporting references

## Rerun Inputs
workflow: firecrawl-deep-research
topic: Winning the Google DeepMind Remote (Edge/On-Device Gemma) track at RAISE 2026 with an Electron+Python voice assistant
depth: thorough
output: markdown
