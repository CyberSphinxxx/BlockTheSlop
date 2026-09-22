# BlockTheSlop — AI Slop Blocker for YouTube

A privacy-first, local-first browser extension that filters AI-generated, automated, repetitive, and low-quality ("slop") YouTube content — while keeping every automatic decision explainable and reversible.

**Core principle:** block the production style you dislike without accidentally blocking the topic you still care about.

- No account. No telemetry. No cloud AI. No API keys. Works fully offline.
- Heuristic + first-party-signal detection with separate **AI likelihood** and **slop likelihood** scores.
- Safe / Balanced / Strict modes, per-category actions, per-surface toggles, literal phrase rules, and per-video/per-channel allow/block.
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

E2E tests load the **actual built extension** from `.output/chrome-mv3` into a persistent Chromium context and exercise real extension lifecycle: service worker, popup, options, and YouTube fixture pages served locally. `npm run verify` refuses to pass on any gate failure and records artifact hashes to `.agents/block-the-slop-v2/RELEASE_EVIDENCE.json` (SET-05: no stale or fabricated evidence).

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
