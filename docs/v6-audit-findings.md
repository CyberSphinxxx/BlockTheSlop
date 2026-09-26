# V6 post-ship audit — findings and fixes (2026-09-26)

Scope: all V6-added code plus its integration points with V5. Each finding lists evidence, severity, and disposition. All CRITICAL/HIGH/MEDIUM findings are fixed in this pass with tests; LOW ones are noted with rationale.

## CRITICAL

### A1. `Set` objects do not survive `browser.runtime.sendMessage` — distinct counts showed `undefined`, not 0

- **Evidence:** `DailyStatsState` (src/domain/stats-daily.ts) stores `distinctHidden`/`distinctWarned` as `Set<string>`. The background handler `'stats:dailyGet'` returned the in-memory state directly over the extension message channel, which JSON-serializes a `Set` to `{}`. Consumers read `.size` (popup App.tsx:287, StatsTab totals) → `undefined` → popup would literally render "undefined distinct videos hidden" and the stats page totals become NaN.
- **Why tests missed it:** fake `Backend`s in vitest return real `Set`s in-process; only the REAL transport drops them. The loaded-extension E2E asserted chip behavior and onboarding settings, not daily counters rendered through messaging.
- **Fix:** background returns `serializeDailyStats(...)` (sets→arrays); `RuntimeBackend.getDailyStats` rehydrates via `rollForwardDay`; `rollForwardDay` additionally tolerates in-memory `Set`s (defense for wrapped fakes). Test: JSON round-trip (`JSON.parse(JSON.stringify(state))`) must render identical counts.

### A2. Read-modify-write race in `DailyStatsStore.record` silently DROPS counts

- **Evidence:** `record()` does `await this.load()` … `await this.save()`. Two tabs reporting different videos in the same tick both load the same base state; the second save overwrites the first → a real hide is lost forever (dedup prevents double-counts but not lost updates).
- **Fix:** instance-level promise-chain mutex inside the store (single background worker = single store instance). Test: 2 concurrent records of different videos → both counted (deterministically fails pre-fix).

### A3. "Restored by you" column could never increment — placebo data

- **Evidence:** `mergeDelta` supports `'restore'`, but NO code path ever records it (only hide/warn are emitted). The stats page showed a permanently-zero tile/column — exactly the "fake zero" the kit forbids.
- **Fix:** wire real restore events: content-script session recovery (`session:restore`) and background review restore (`history:restore`, looks up the summary's videoId) now record daily `restore` outcomes fire-and-forget. Validator outcome enum extended.

## HIGH

### H1. Future-dated `observedAt` can poison/evict all real stats

- **Evidence:** `stats:dailyRecord` accepted any finite `observedAt`. `pruneDays` keeps the 90 NEWEST keys — 90 future-dated keys would evict every real day (storage poisoning via a buggy/hostile content script).
- **Fix:** store clamps absurd timestamps (outside `[now − retention, now + 1 day]`) to now. Test: year-3000 timestamp lands in today's bucket.

### H2. Stats page "collection off" state was hardcoded `false` — the honest state could never render

- **Evidence:** `const collectionOff = false; // daily outcomes are only recorded when enabled upstream` (StatsTab.tsx:124). V6-12 requires an explicit collection-off state; the dead constant made it unreachable.
- **Fix:** StatsTab reads `collectLocalStats` from real settings and renders the note.

### H3. Range totals double-counted distinct IDs across days

- **Evidence:** `totals.distinctHidden += bucket.distinctHidden.size` per day — a video hidden on 3 of 7 days counted 3× in the 7-day "Distinct hidden" tile, contradicting "distinct".
- **Fix:** multi-day tiles use the UNION of identity sets; per-day rows keep per-day distinct counts; sightings stay event totals.

## MEDIUM

### M1. `applyPrefs` runs on every `getSettings()` — hot-path DOM writes

- getSettings is called per processing batch; each call re-wrote theme attributes, toggled chip classes, and scheduled a rAF. Fix: memoize the last-applied pref key; apply only on change.

### M2. Stale onboarding draft persisted after completion

- The draft `localStorage` blob survived Apply/Skip forever. Fix: remove it on successful finish.

### M3. Popup "statistics off" note depended on the content script's report

- If the content script wasn't loaded (no status), the note never rendered even though the popup itself has the authoritative `settings.collectLocalStats`. Fix: source it from settings; also derive "paused" from settings.enabled.

## LOW (noted, not changed)

- L1. Popup open across local midnight shows the mount-time day label — popup lifetime is seconds; acceptable.
- L2. `mergeDelta.currentDay` reflects the last recorded event, not wall-clock today — informational field only; UI derives days independently.
- L3. `expect(mkdirSync).toBeDefined()` in the visual spec is a vestigial assertion — harmless.
- L4. `RuntimeBackend.saveSettings` writes merged settings without re-validating — pre-V6 behavior, patches originate from validated optimistic state.

---

## Verification of fixes (2026-09-26)

- New regression tests: `tests/storage/v6-audit-fixes.test.ts` (A1 JSON round-trip, A2 concurrency no-lost-update + dedup-under-concurrency, H1 clamp, A3 restore recording) — 6/6 pass. `tests/ui/v612-stats-page.test.tsx` +4 (H3 union tile, H2 collection-off from real settings + no-note-when-on) — 8/8. `tests/ui/v608-popup-status.test.tsx` +1 (M3 settings-sourced note) — 8/8.
- New E2E closing the A1 coverage gap: `tests/e2e/v6-audit-stats-wire.spec.ts` — drives REAL background records via runtime messaging, opens the REAL popup, asserts "2 distinct videos hidden" through the actual JSON transport (dedup: 3 records → 2 distinct). Passes on the loaded extension.
- Full gates re-run post-fixes: ALL 11 exit 0 — unit 671/671 (69 files), E2E chromium 41/41 (incl. the new wire test), firefox smoke 2/2, builds + zips ✓.
- Final fingerprint: `e7e68a1dae1fca1d8e4acca9769767ba099c2adb902fa9142d9626f3bfd1166d` — matches RELEASE_EVIDENCE.json exactly.
