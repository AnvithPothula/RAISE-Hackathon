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

### P0 — Offline mode + kill switch ⚠️ partial
| # | Task | Status |
|---|------|--------|
| 8 | Vosk STT + Piper TTS offline fallback | ⏳ Not wired — voice still Gradium-only; **typed chat + Gemma brain work offline** |
| 9 | UI badge "● All inference on-device" + mode indicator | ✅ Demo HUD in `App.tsx` |
| 10 | Wi-Fi-off rehearsal | 🎬 Ready to demo typed prompts offline |

### P0 — Compliance & repo ✅
| # | Task | Status |
|---|------|--------|
| 11 | "Built during RAISE 2026" README section | ✅ |
| 12 | README rewrite (architecture, 3-step run, privacy) | ✅ |
| 13 | No secrets in git | ✅ `.env.example`, `API_KEYS_SETUP.txt` |

### P1 — Demo-strengtheners ✅
| # | Task | Status |
|---|------|--------|
| 14 | Perf HUD (tok/s, TTFT) | ✅ `ModelStats` → demo HUD |
| 15 | Android/Echo remote demo beat | ✅ Bridge exists, orb nodes in UI |
| 16 | Persistent local memory beat | ✅ `update_user_memory` tool |

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

### P2 — Still deferred
| # | Task | Status |
|---|------|--------|
| 17 | Native audio-in to Gemma E4B | ⏳ |
| 18 | MLX variant A/B | ⏳ |
| 19 | Landing page | ⏳ |

### Bonus track angles
- **Cursor track synergy:** Cursor agent delegation + local Gemma brain = "private voice assistant that can also ship code via Cursor when online."
- **Gradium partner:** Studio voice online; brain never leaves machine.
- **Cloudflare/Netlify:** Not primary — edge story is Ollama on laptop/phone bridge.

---

## Demo script updates (use new features)

| t | Beat |
|---|---|
| 18–30 s | **Tool call:** alarm + screen vision + **"research the best…"** → `deep_research` loops locally then answers |
| 30–42 s | **Kill Wi-Fi.** Typed: "what time is it?" + memory recall. HUD shows **● All inference on-device** + tok/s |
| 42–52 s | Show **MCP Connectors** panel (system/filesystem/memory connected). Echo/Android node if time |

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
