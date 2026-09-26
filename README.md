# BlockTheSlop — AI Slop Blocker for YouTube

A privacy-first, local-first browser extension that filters AI-generated, automated, repetitive, and low-quality ("slop") YouTube content — while keeping every automatic decision explainable and reversible.

**Core principle:** block the production style you dislike without accidentally blocking the topic you still care about.

- No account. No telemetry. No cloud AI. No API keys. Works fully offline.
- Heuristic + first-party-signal detection with separate **AI likelihood** and **slop likelihood** scores.
- Safe / Balanced / Strict / **Aggressive** modes, per-category actions, per-surface toggles, literal phrase rules, and per-video/per-channel allow/block. Aggressive is an explicit recall-first tradeoff: it hides more supported AI content but accepts more false positives — every hide stays one-click recoverable.
- A durable, paginated review history for everything the extension hides, with restore, false-positive corrections (Not AI / Not slop), bulk delete, and filters. Corrections survive history clears.
- Configurable history retention (age- and size-bounded), import/export with prepared-import validation, and a redacted local support report.

## Install (development)

Requirements: Node 22+, npm 11.

```bash
npm ci
npm run build          # production build for Chrome/Chromium
```

Load unpacked:

1. Open `chrome://extensions` (Chromium-based browsers; Edge: `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `.output/chrome-mv3`.

Firefox: `npm run build:firefox`, then load `.output/firefox-mv2` via `about:debugging#/runtime/this-firefox` (temporary add-on).

## Develop

```bash
npm run dev            # Chrome with HMR
npm run dev:firefox    # Firefox with HMR
```

## Test

```bash
npm run typecheck      # strict TypeScript, no emit
npm run lint           # ESLint
npm run format:check   # Prettier
npm run test           # Vitest unit/integration/DOM/UI/perf suites
npm run test:e2e       # Playwright extension E2E (Chromium persistent context)
npm run verify         # FULL release gate: every gate in order + artifact hashes
```

E2E tests load the **actual built extension** from `.output/chrome-mv3` into a persistent Chromium context and exercise real extension lifecycle: service worker, popup, options, and YouTube fixture pages served locally. `npm run verify` refuses to pass on any gate failure and records artifact hashes to `.agents/block-the-slop-v5/RELEASE_EVIDENCE.json` (SET-05: no stale or fabricated evidence; the file carries the exact source fingerprint).

## Measured behavior (honest numbers, not marketing)

On YouTube, a small persistent corner counter reports how many distinct videos are
currently hidden on the page, deduplicated across scroll and recycled DOM nodes.
Hidden cards collapse by default on new installs with parent grid reflow leaving no
blank slot or gap; existing presentation choices are preserved.
Even when history is disabled, all collapsed cards on the page remain fully recoverable
via the interactive corner notice or the extension popup's Session Recovery list.
Notices automatically hide in fullscreen and theater modes so video playback controls
are never obscured.

**Channel and Video Controls:**

- Right-click any video card or thumbnail to choose **Hide this video with BlockTheSlop** or **Block this channel with BlockTheSlop**.
- Channel blocks require verified canonical `UC...` channel IDs (or explicit handle confirmation) and immediately rescan all open YouTube tabs with instant Undo.
- Hiding a video offers a clear, deliberate whole-channel choice with conflict detection and one-click Undo.
- Optional automatic channel blocking is **default OFF**; when enabled, it strictly requires a canonical `UC...` ID and at least 3 distinct qualifying videos with strong video-production AI evidence across visits, capped at 5 promotions per day, expiring after 30 days, and instantly revocable upon user allow or Not AI corrections.

Scores are heuristic rule weights, **not** calibrated probabilities; undisclosed AI content with no observable metadata signal cannot be detected by any metadata-only tool. Current measurements, with provenance:

- Hand-authored dev/regression corpus (210 cases, **not** held-out): AI-axis tp=58, fp=0, fn=22, tn=130 (precision 1.000 on 58 positive predictions, recall 0.725, FPR 0.000); slop axis signals on **nothing** in this corpus (tp=0, precision n/a — reported, not hidden); prediction coverage 0.410 (86/210). Descriptions supplied by cases are included in classification.
- Frozen holdout benchmark (`tests/unit/v510-evaluation-competitors.test.ts`, 40 cases, untouched): AI-axis tp=7, fp=0, fn=5, tn=28 (precision 1.000 on 7 positive predictions, recall 0.583, FPR 0.000); slop axis tp=0, fp=0, fn=13, tn=27 (precision n/a, recall 0.000, FPR 0.000). Zero false AI predictions on genuine human craftsmanship and educational AI journalism.
- Frozen channel evaluation (50 channels across synthetic farms, human creators, AI discussion, mixed channels, and identity edges): 10 qualified synthetic AI farms, 0 false channel blocks (0.00% error rate per 100 channels), 5 identity-edge handle/missing cases safely rejected.
- Live-title regression sample (signed-out YouTube search, 2026-09-25): aggressive hides 12/19 titles judged to suggest AI-made content (strict warns on 12/19); title-labeled discussion tutorials and 19 craft controls stay visible in every mode. Seven AI-labeled titles still lack a matched signal.
- Flash timing bounds: warm cache hit P50 = 3.55ms, P95 = 8.37ms; cold navigation P50 = 8.2ms, P95 = 14.1ms; 1,000ms bounded fail-open deadline.
- Competitor protocol: features compared against 6 peer extensions; empirical performance benchmarks marked `NOT MEASURED` as competitor builds are not installed in the automated test runner.

## Build & package

```bash
npm run build          # Chrome MV3 production build
npm run zip            # store-ready package in .output/
npm run build:firefox  # Firefox build (target)
npm run zip:firefox
```

## Architecture

```
YouTube DOM ──► Content script (observer, batching, parsers)
                     │ normalized video candidates
                     ▼
               Detection engine (evidence → aiLikelihood/slopLikelihood/confidence)
                     │ classification
                     ▼
               Decision policy (user precedence → allow/warn/hide)
                     │ decision
                     ▼
               Presentation (hide/warn overlays, review records)
```

- `src/youtube/` knows YouTube DOM only — never decides what is slop.
- `src/detection/` consumes normalized data — never touches the DOM.
- `src/policy/` consumes classification + settings — never queries YouTube.
- `src/presentation/` applies decisions idempotently to cards.
- `src/storage/` owns persistence, migrations, and retention.
- `src/providers/` is an optional, default-OFF remote reputation interface; failure never blocks.
- `src/background/` owns IndexedDB and validates every message (internal senders only, bounded payloads).
- `src/import-export/` validates imported files strictly; nothing is executed.

See `docs/` for the full specification: product, architecture, data model, detection engine, test plan, security/privacy, surfaces & edge cases, release checklist.

## Privacy

- No analytics or telemetry of any kind. IndexedDB lives on-device at extension origin; nothing is uploaded.
- No watch/search history leaves the device. No page content is uploaded.
- Remote reputation provider: the toggle exists but is **not wired in this build** — no remote calls occur regardless of its state (surfaced honestly in Settings → Privacy).
- "Also tell YouTube Not interested": toggle exists but is **not wired in this build** — no YouTube account actions are ever performed (surfaced honestly in Settings → Privacy).
- Permissions: `storage` only, plus YouTube host access. No scripting injection, no tabs, no browsing data.
- Imported files are treated as untrusted data: size/nesting bounded, prototype-like keys rejected, remote/feedback flags arrive disabled.

## License

MIT — see `LICENSE`.
