# Competitive Analysis — DeepMind Remote Track (RAISE 2026)

**Recon date:** 2026-07-04 evening (Day 1, ~6 h into hacking). Source: GitHub search for
Gemma repos created 2026-07-02→04, READMEs + commit/maturity metadata. Submissions aren't
public yet (due Jul 5 12:00), so this is *in-flight* intel — repos will grow overnight.
**Track:** "Best mobile, web, or edge application running **Gemma locally** for **offline,
privacy-first inference**." Judging: Demo 50 · Impact 25 · Creativity 15 · Pitch 10.

---

## TL;DR — where we stand

Pythos is, right now, the **only** entrant we found that combines *voice wake-word + real
multi-tool agentic actions + local vision + an offline fallback*, all on local Gemma. That
breadth is our moat. But breadth is also our risk: the judges (per past winners) reward a
**singular, load-bearing offline reason** and **real-user impact**, and two mature competitors
(**turnpilot**, **KrishiMitra**) beat us on *narrative sharpness* even though we beat them on
*capability*. **We win by keeping the capability and stealing their focus** — pick one vivid
offline-privacy persona, show a multi-step tool chain running with the Wi-Fi off, and be
scrupulously honest about what runs where.

---

## The field (on-device Gemma repos, ranked by threat)

| Repo | What | Maturity | Threat | Notes |
|---|---|---|---|---|
| [dadachi/turnpilot](https://github.com/dadachi/turnpilot) | Offline queue-ops copilot for walk-in shops; situational model → advisory → **Accept/Override** loop, Gemma 4 via Ollama | **36 commits, Ruby, DESIGN.md+STATUS.md** | 🔴 High | Best-framed repo in the field. "Deliberately **not a dashboard**." Has an "honest signal" section reasoning about data integrity. This is the one to beat on *pitch/narrative*. No voice, single domain. |
| [Waish228/KrishiMitra](https://github.com/Waish228/KrishiMitra) | Multilingual farming assistant: voice/text, image disease detection, weather/market | **27 commits, TS, 4 MB** | 🔴 High | Hits the exact **past-winner archetype** (agriculture + underserved + multilingual + multimodal). Impact-heavy. |
| [Ryukijano/pcos-edge-agent](https://github.com/Ryukijano/pcos-edge-agent) | "Personal Context OS" — context router across Chrome/Android/Pixel Watch, LiteRT-LM, FunctionGemma, hybrid cloud+local | 18 commits, **165 KB (mostly docs)** | 🟡 Med | Architecturally ambitious ("not a chatbot, a context router"), real edge stack. Over-scoped for a weekend → high demo risk. Watch the framing, not the code. |
| [Karthikeya0923/novasaur](https://github.com/Karthikeya0923/novasaur) | On-device offline kids' Q&A (dinos/space), Gemma | 18 commits, Java/Android | 🟡 Med | Real mobile-edge, narrow scope, clean "no internet required" story. |
| [SBasu007/hawkersaathi](https://github.com/SBasu007/hawkersaathi) | Multimodal Bengali-first agent for street vendors, Gemma 4 | 3 commits (thin) | 🟡 Med | Strong archetype, barely started — could surge overnight. |
| [LavnorterLav/local_ios_AI](https://github.com/LavnorterLav/local_ios_AI) | Gemma-4-E2B via **LiteRT-LM on iOS** | 1 commit | 🟢 Low-now | Purest "mobile edge" story if they ship. We are *not* mobile — worth noting. |
| [arrase/eloquent-notes](https://github.com/arrase/eloquent-notes) | Offline dictation → Obsidian, Gemma 4 (`gemma4:12b-it-qat`) via Ollama, tray daemon | Polished, **created Jul 2** | 🟢 Low | Mature but narrow, and likely predates the event (New-Work risk for *them*). Good proof our Ollama+Gemma stack is the common choice. |

### Competitors likely to self-disqualify (banned categories)
The rules ban basic-RAG, dashboards-as-main-feature, and off-track cloud LLMs. Several strong-looking repos walk into these:
- [TunaStark/second-brain](https://github.com/TunaStark/second-brain) — "local Second Brain, LangChain + Ollama + ChromaDB semantic search" = **basic RAG**. Banned.
- `galihdesta2005gd-hue/Local-Ai-Pc-Health-Monitor`, `AhamedAAHA/neuroloom` ("command center") — **dashboard as the main feature**. Banned risk.
- [TRI7AAN/VeriFasal](https://github.com/TRI7AAN/VeriFasal) — "Built with … the **Gemini API**" = **cloud**, off-track for on-device.

**Implication:** the *effective* field for this track is smaller than it looks. Being unambiguously (a) on-device, (b) not-a-dashboard, (c) not-RAG is itself a differentiator.

---

## Patterns that win this track (competitors + past winners agree)

1. **Offline/privacy is load-bearing, not a bullet point.** turnpilot: "No cloud calls." Gemma
   Vision (last cycle's 1st place): built for blind users precisely because *connectivity is
   unreliable when you need it most and images are sensitive*. The offline-ness must be *why the
   product exists*, not a feature.
2. **"Not a dashboard / not a chatbot" is stated explicitly.** turnpilot and pcos both pre-empt the
   banned-category read in their first paragraph. We should too.
3. **One flow, one operator loop.** turnpilot's whole product is advisory + Accept/Override. Winners
   scope hard.
4. **Honest engineering earns trust.** turnpilot's "honest signal" section (what data it can and
   can't trust) is exactly what Gemma Vision did (pairing Gemma with ML Kit OCR because Gemma
   hallucinated text). Judges reward transparent trade-offs over purity.
5. **Real, named user / impact.** The archetype that keeps winning: a specific underserved person
   or high-stakes workflow.

---

## Where Pythos beats the field — and where it doesn't

**We win on:**
- **Agentic depth.** Every competitor we saw does single-shot Q&A or one advisory. Pythos runs a
  *multi-tool* loop on local Gemma — Calendar events, calendar-backed alarm requests, Spotify,
  open-app, free web search, **screen vision**, persistent memory — with parallel direct-tool
  execution for compound requests and a sub-agent. Nobody else has this. **This is the headline.**
- **Local vision.** `analyzeImageWithOllama` = "what's on my screen?" answered by Gemma 4 vision
  with the screenshot never leaving the device. turnpilot/KrishiMitra/novasaur don't have a vision
  privacy beat.
- **Voice-native + wake word + hybrid online/offline voice.** A genuine hands-free assistant, not a
  tray utility or a web form.
- **Polish.** The orb UI is more finished than anything in the field.

**We're exposed on:**
- **Generic positioning.** "A private Alexa" is broader and less emotionally sharp than "shops lose
  walk-away customers" or "farmers with no signal." Impact (25%) suffers if we stay generic.
- **Edge-boundary honesty.** DeepMind Remote is "mobile/web/**edge**." Our edge device is the
  **laptop** (Gemma runs there via Ollama); the Android/Alexa node is a **thin mic/speaker client**,
  *not* on-device Gemma on the phone. If we imply "Gemma on your phone," a judge will catch it.
  Frame it correctly: "any device becomes a private front-end to your own on-device brain."
- **Not mobile.** Pure-mobile entrants (iOS LiteRT, Android) have a cleaner edge story. We counter
  with capability + the privacy/offline demo, not by pretending to be mobile.

---

## How we get to #1 — prioritized (≈17 h left)

### P0 — Sharpen the wedge (2 h, mostly writing + one demo scene)
1. **Pick ONE load-bearing persona** where offline+private is the reason it exists. Strongest options:
   - *Privacy-critical home/desk* — "the assistant that never ships your voice or screen to a
     datacenter" (leans on our vision + voice + memory, all local).
   - *Dead-zone / travel / field* — "works with the Wi-Fi off," leans on the kill-switch demo.
   Choose one, put it in the first sentence of the README and the video. Kill "general assistant."
2. **State the anti-dashboard/anti-RAG line explicitly** in the README intro (copy turnpilot's move):
   "Pythos is a voice agent that *acts* — it is not a dashboard, not a chatbot, not RAG."

### P0 — Make the demo un-loseable (3–4 h)
3. **The multi-tool offline chain** — one spoken request that fires ≥2 tools locally (e.g. "what's
   the temperature and add Mbappe's birthday on December 20th") → proves agentic depth no competitor
   has. Rehearse it.
4. **Wi-Fi kill switch on camera** — still the single best 50%-weight moment. Voice audibly degrades
   cloud→local. Nobody else will *show* offline this viscerally.
5. **On-screen HUD**: tok/s + "100% on-device" + model name (`gemma4:e2b`). Judges love visible proof.

### P0 — Repo hygiene to match the frontrunner (1.5 h — turnpilot already has this)
6. **DESIGN.md + STATUS.md + architecture diagram** (mic → openWakeWord → Gemma 4/Ollama → tools →
   voice), a **privacy table** (what runs where — and honestly mark the phone node as a client), and
   a prominent **"Built during RAISE 2026 (Jul 4–5)"** section with commit links. This is also our
   New-Work-Only insurance — do not skip.
7. **Honest-signal section** (steal turnpilot's credibility move): one paragraph on a real limitation
   and how we handle it — e.g. "E2B is the weakest Gemma at tool-calling, so we tightened tool
   descriptions and fall back to X," or the phone-is-a-client boundary.

### P1 — Impact lift (only if P0 done)
8. Add one concrete high-impact framing beat to the demo (a named user / scenario), matching the
   archetype that keeps winning this track.

### P2 — Stretch (high risk, only if far ahead)
9. **Real on-device-on-phone Gemma** via MediaPipe/LiteRT to convert the Android node from thin
   client to true mobile edge. Enormous story upgrade, enormous time risk — timebox hard or skip.

### Do NOT
- Don't out-scope turnpilot on their turf (domain ops). Play *our* game: agentic voice + local vision + offline.
- Don't add features. Six working tools > ten flaky. (Also the reason turnpilot is strong: it does one thing.)
- Don't overclaim the edge boundary. One caught overclaim in front of a DeepMind judge is fatal.

---

## Open questions / watch items
1. **Re-scan competitor repos ~Jul 5 08:00** — thin repos (hawkersaathi, local_ios_AI) may surge overnight; turnpilot's STATUS.md will show how far the leader got.
2. **Deadline timezone** (Paris vs local) — still unconfirmed; affects overnight runway.
3. Is turnpilot even in *our* track (it reads Crusoe-operator-loop but is offline-local-Gemma)? Either way it sets the narrative bar.

## Sources
- GitHub search: `gemma` repos created 2026-07-02→04 (36 results scanned); READMEs of turnpilot,
  pcos-edge-agent, hawkersaathi, eloquent-notes; repo maturity via GitHub API.
- Cross-referenced with `HACKATHON_PLAN.md` (past-winner research: Gemma 3n Impact Challenge, JetBrains judging notes).
- CV event page: https://cerebralvalley.ai/e/raise-summit-hackathon
