# TASKS — BlockTheSlop

Generated from the build kit. The coding agent owns this ledger.

Statuses: `[ ]` not started · `[-]` in progress · `[x]` verified · `[!]` blocked

Verification: `npm run lint` · `npm run typecheck` · `npm run test` (135) · `npm run test:e2e` (15) · `npm run build` · `npm run build:firefox` · `npm run zip` — all green at last run.

## Phase 0 — Bootstrap

- [x] Initialize WXT + React + TypeScript project
- [x] Configure pnpm (pinned; npm lockfile in this env)
- [x] Configure strict TypeScript
- [x] Configure Tailwind (v4, prefixed namespace)
- [x] Configure ESLint/Prettier
- [x] Configure Vitest + RTL
- [x] Configure Playwright extension E2E
- [x] Configure CI (.github/workflows/ci.yml)
- [x] Extension install smoke passes (E2E-01/02)

## Phase 1 — Domain model & storage

- [x] Domain types (video, evidence, classification, decision, settings, rules, review)
- [x] Default settings + schema validation (privacy-safe defaults)
- [x] Storage layer with deterministic migrations
- [x] Import/export schema + hardening
- [x] Unit tests: defaults, round-trip, migration, invalid data

## Phase 2 — YouTube observation & parsing

- [x] Centralized selectors (multi-selector per concept)
- [x] Route/surface detection + SPA navigation tracking
- [x] Mutation batcher + candidate discovery (root-is-card, ancestor-walk, subtree)
- [x] Parser adapters: card, shorts shelf/feed, common disclosure extraction
- [x] Identity extraction + recycled-node handling (epoch-based)
- [x] Fixture tests: missing fields, Unicode, Shorts, malformed

## Phase 3 — Detection engine

- [x] Official disclosure detector (strong AI evidence, never implies slop)
- [x] Creator self-disclosure rules
- [x] Title/description rules (en + fil), word-boundary safe
- [x] AI-discussion context (opposing evidence) detector
- [x] Content-farm heuristics (never high-confidence alone)
- [x] Channel reputation adapter (capped confidence)
- [x] Aggregation: independent ai/slop, confidence, diversity, contradictions
- [x] Explanations for every warn/hide
- [x] Versioning (CLASSIFIER_VERSION, RULES_VERSION)

## Phase 4 — Decision policy

- [x] 9-step documented precedence
- [x] Safe/Balanced/Strict thresholds (constants)
- [x] Per-category actions
- [x] Exhaustive precedence + boundary tests

## Phase 5 — Presentation

- [x] Hide (collapse/placeholder), warn overlay, restore — idempotent
- [x] Show once / allow video / allow channel actions
- [x] Cleanup; namespaced CSS; textContent-only rendering

## Phase 6 — Popup

- [x] Enable toggle, mode selector, stats, quick category controls, links
- [x] RTL tests: persistence, labels, error state

## Phase 7 — Options / Review UI

- [x] All 9 sections; review actions incl. Not AI/Not slop, confirmations
- [x] RTL tests: import validation, reset confirmation, review actions

## Phase 8 — Remaining surfaces

- [x] Shorts feed + shelves, playlists, history, watch-later route map
- [x] Home/Search/Watch sidebar/Subscriptions covered by E2E-03/04/11/12/13
- [!] End-screen + autoplay guard — TARGET items; documented as post-v1

## Phase 9 — Providers

- [x] ReputationProvider contract + disabled provider (default OFF)
- [x] HTTP provider: timeout, abort, validation, TTL cache, circuit breaker
- [x] Failure ⇒ unknown, never block; tests

## Phase 10 — Performance

- [x] Batched observer (100 inserts = 1 batch), no full-rescan
- [x] Large-grid perf test (500 cards), bounded caches

## Phase 11 — Accessibility

- [x] Labels, focus, keyboard, sr-only hints, reduced-motion CSS
- [x] Popup keyboard test (RTL), role-based queries throughout

## Phase 12 — Cross-browser

- [x] Chrome build (primary)
- [x] Firefox build (target) — exit 0

## Phase 13 — Release hardening

- [x] Full gate: format, lint, typecheck, test, test:e2e, build, zip — green
- [x] Manifest inspected: MV3, `storage` + YouTube host only, no scripting/alarms/tabs
- [x] Hygiene: 0 TODO/FIXME, 0 raw console, 0 any, 1 scoped eslint-disable (logger)

## Phase 14 — Release checklist

- [x] All REQUIRED items in RELEASE_CHECKLIST.md verified (see mapping below)
- [!] Live-YouTube TARGET smoke items — not runnable in this sandbox (no network);
  deterministic E2E-01..15 on real Chromium + unpacked extension substitute
