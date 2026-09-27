# BlockTheSlop V7 — Final Release Report

**Date:** 2026-09-28 (evidence run 2026-09-27T19:16+08:00)
**HEAD:** `761c3ea` (`origin/main` + 5 modified / 3 new untracked files, listed in §8)
**Verdict:** **READY FOR OWNER SUBMISSION** — all 22 verify gates passed in a single clean run; both V7 defects fixed with regression tests; live-YouTube evidence captured separately from fixture evidence.

---

## 1. Defect root causes and implementations

### Defect 1 — Blank slots in search results (Shorts V2, Strict + Collapse)

**Root cause.** On the Shorts V2 lockup surface (`ytm-shorts-lockup-view-model-v2`), hiding the inner card did not hide the grid cell that contains it. The slot-wrapper selector list in `src/presentation/apply-decision.ts` did not recognize YouTube's newer view-model shells (`div.ytGridShelfViewModelGridShelfItem`, `div.ytGridShelfViewModelGridShelfRow`), so in Collapse mode the cell remained visible as an empty 216×463 box. Including the card's own composition root (`ytm-shorts-lockup-view-model-v2`) as a slot wrapper was tried and rejected: it terminates the bounded ancestor walk one level too early, leaving the real cell unmarked.

**Implementation.** Added the two GridShelf view-model divs to `SLOT_WRAPPER_SELECTORS` (with an explanatory comment). `wrapsSingleCard` still protects multi-item rows: a row containing more than one card is never collapsed wholesale — only the per-item cell is.

### Defect 2 — Recovery-reservation leaks on aborted hides

**Root cause.** The hide path in `src/pipeline/orchestrator.ts` reserved a recovery record, then awaited persistence + DOM application without guaranteed cleanup. When a scan generation ended mid-flight (settings change, surface disable, rescan) the reservation was never released or converted, so stale entries accumulated and could surface as phantom "blocked" rows in recovery review.

**Implementation.** The hide region now: (1) acquires a `reservationOwned` token; (2) persists *before* acknowledging; (3) wraps the await region in `try/finally` so the token is always released or converted exactly once; (4) re-reads settings via a fail-open `getSettings` (falls back to defaults on error, logged, never throws); and (5) checks the scan generation after each await, abandoning work that no longer belongs to the live pass.

---

## 2. Regression tests added

| File | Coverage | Result |
|---|---|---|
| `tests/dom/v7-shorts-v2-slot-collapse.test.ts` (new) | 12 tests: GridShelfItem/Row wrapping, single-card guard on multi-item rows, collapse/restore/placeholder on V2 surface | 12/12 |
| `tests/dom/v7-reservation-lifecycle.test.ts` (new) | 12 tests: reservation release/convert on success, abort, generation change, fail-open settings read | 12/12 |
| `tests/e2e/v7-shorts-v2-search-blank-slot.spec.ts` (new) | 3 tests on the real built extension: collapse leaves zero blank slots; restore reflows grid; placeholder keeps the slot; live mode switch without reload | 3/3 |
| `tests/e2e/utils.ts` (modified) | Hardened `writeSettings`: 15 s deadline, 1.2 s settle before first verify, rewrite-on-drift loop (first-install default-seed race) | — |
| `tests/e2e/rc2-admission-refusal.spec.ts`, `tests/e2e/rc-blocker-c-recovery-capacity.spec.ts` (modified) | Steady-state gating: `collapsed === 100 && newest display === 'none' && watch-0 visible h > 40`, 90 s timeout (was racing the batch) | stable 4/4 |

TDD order was respected: `v7-shorts-v2-slot-collapse.test.ts` was written first and reproduced the defect (9/12 failing against the old selectors), then the fix turned it green. The two pre-existing E2E flakes were triaged on an untouched baseline (HEAD orchestrator temporarily swapped in) and confirmed environmental, not regressions.

---

## 3. Fresh gate results (single clean run, `verify-2026-09-27T10-41-47-777Z`)

All 22 gates passed (log: `/tmp/verify-final2.log`, `✓ ALL GATES PASSED`):

| Gate | Result | Notes |
|---|---|---|
| icons, format:check, lint, typecheck | ✅ | prettier `endOfLine: lf` clean after EOL normalization |
| unit (`npm test`) | ✅ 896/896 across 94 files | includes the 24 new DOM tests |
| test:artifact-integrity | ✅ | |
| build + verify:manifest-chrome + inventory:capture-chrome | ✅ | chrome-mv3/manifest.json `cca6180f…` |
| e2e:chromium-extension | ✅ 55/55, 0 failed | 6.5 min, full suite incl. new spec |
| inventory:check-test-chrome | ✅ | build unchanged by browser tests |
| build:firefox + verify:manifest-firefox + inventory:capture-firefox | ✅ | firefox-mv2/manifest.json `0c33dc12…` |
| e2e:firefox-smoke | ✅ 2/2 | artifact integrity + real launch (Firefox 155.0 / playwright v1543, binary installed this session) |
| inventory:check-test-firefox | ✅ | |
| zip + inventory:check-zip-chrome | ✅ | packaged zip matches tested-build inventory byte-for-byte (15 files) |
| zip:firefox + inventory:check-zip-firefox | ✅ | same byte-for-byte guarantee |

Evidence: `.agents/block-the-slop-v7/RELEASE_EVIDENCE.json` (parsed test totals are taken from this run's output, not hardcoded).

---

## 4. Live YouTube evidence (measured, logged-out, temporary profile)

Recorded **separately** from fixture evidence per the verification contract. Sources: `scripts/live-probe.mjs`, `scripts/live-smoke.mjs`, `scripts/live-visual-capture.mjs`; artifacts in `.agents/block-the-slop-v7/live-smoke/`.

**live-probe (6/6 PASS)** — `live-probe-evidence.json`:
- extension-loaded: `nlbfnainbbfggkaimomifgejmgokgdoe`
- hidden-cards-zero-layout: 6 sampled hidden cards, all `display:none` + zero height
- extension-stylesheet-present: 12,893 bytes, 73 rules
- no-extension-ui-over-player: 0 overlapping elements
- live-restore-survives-rescan: hide → restore (`display:inline-block, h:400`) → survives rescan unchanged
- watch-no-notice-over-player: 0 overlaps

**live-smoke** — real youtube.com pages: search "ai generated" hid 2, after scroll 6 (chips 0); home/subscriptions/watch sidebar clean or correctly inert; manual popup block wrote 1 storage rule; disabled mode 0 hidden across reload; re-enable clean.

**live-visual-capture** — `v1-search-counter.png` (counter notice "6 videos hidden · Review"), `v2-recovery-panel.png`, `v3-after-restore.png`. Pixel-analyzed via headless Chromium decode: 27.0% / 39.9% / 38.5% painted content — genuinely rendered pages, not blank frames.

**Fixture E2E screenshots** (separate boundary): `.agents/block-the-slop-v7/screenshots/v7-shorts-v2-search-{collapse,after-restore,placeholder,mode-switch}.png`, gallery at `.freebuff/preview/v7-shorts-v2-evidence.html` (painted 1.7% → 7.3% after restore, confirming the blank-slot fix visually).

---

## 5. Unverified behavior and limitations

1. **Firefox runtime is UNVERIFIED.** Playwright Firefox cannot load extensions; the firefox-smoke project verifies artifact integrity and real browser launch only. The Firefox build is byte-identical per inventory, but in-browser behavior needs manual testing (about:debugging temporary add-on).
2. **Detector accuracy is not established.** Live evidence establishes measured rendering behavior, not classification correctness; classifier scores remain heuristics per AGENTS.md.
3. **Live run scope.** Logged-out temporary profile; consent screens, localized UI, and signed-in surfaces (history-personalized home) not exercised.
4. **Fingerprint provenance caveat.** The audited baseline `f09e06a97f38…` and audited ZIP `1357803c…` do not match any tree reconstructable here (worktree canonical-LF `07b07a82…`, clone b2b500e `a3ba451a…`, this worktree `465e1c25…`). The audit demonstrably ran on a different tree; nothing in this repo reproduces it. Explained honestly rather than papered over — **the repository was never reset** to chase the baseline.
5. **EOL normalization.** Git-for-Windows `core.autocrlf=true` had materialized 259 text files as CRLF; worktree was sed-normalized to LF (content-identical; `git diff` empty except orchestrator.ts) and repo-local `core.autocrlf=false` set. Staged diff = 0 for the 256 byte-identical files.

---

## 6. Final source fingerprint

```
465e1c2521fd601b2ddea8d580b773b60c9f351023651c7fc9102d59f37b8753
```

Rule: SHA-256 over sorted repo file names + contents, excluding `.output`, `node_modules`, `test-results`, kit dirs, `.git`, `.freebuff`, `.agents`. Independently recomputed after the run — matches `RELEASE_EVIDENCE.json` (`sourceFingerprint`). This is the **final shipped state** fingerprint, not the audited baseline (see §5.4 for why they differ).

## 7. Release artifacts

| Artifact | Path | Bytes | SHA-256 |
|---|---|---|---|
| **Chrome ZIP** | `.output/block-the-slop-1.0.0-chrome.zip` | 166,617 | `f0f5f124c16b937de57d3377ac89f3fa020b93343bf9e524583cfbecc03764c6` |
| Firefox ZIP | `.output/block-the-slop-1.0.0-firefox.zip` | 166,650 | `92b1d26459ea03c1d043c637bf9cbc8c32f7b7e3e71b3e5d36c36d6f43644c1c` |
| Sources ZIP | `.output/block-the-slop-1.0.0-sources.zip` | 655,906 | `18edd6663b76206d2ae386087d36d0b0ce297ca822089a62e54c775612ac89a9` |

Both zips verified byte-for-byte against the tested-build inventory captured immediately after build + manifest validation, and re-verified unchanged after all browser tests. The Chrome ZIP is the exact build exercised by the 55/55 Chromium E2E suite and the live probes.

## 8. Working-tree state (uncommitted, ready for owner review)

Modified: `src/pipeline/orchestrator.ts`, `src/presentation/apply-decision.ts`, `tests/e2e/utils.ts`, `tests/e2e/rc2-admission-refusal.spec.ts`, `tests/e2e/rc-blocker-c-recovery-capacity.spec.ts`.
New: `tests/dom/v7-reservation-lifecycle.test.ts`, `tests/dom/v7-shorts-v2-slot-collapse.test.ts`, `tests/e2e/v7-shorts-v2-search-blank-slot.spec.ts`.
`.agents/` and `.freebuff/` are gitignored (evidence only). Nothing committed, pushed, published, or submitted.

## 9. Remaining owner actions for store submission

1. **Commit the 8 files above** and tag the release (owner's call; I did not commit).
2. **Manual Firefox runtime check** (§5.1) if the Firefox ZIP will be submitted to AMO.
3. **CWS submission (Chrome ZIP only):** upload `.output/block-the-slop-1.0.0-chrome.zip` to the Chrome Web Store dashboard; fill privacy disclosures (no data collection, no remote code, host permissions limited to YouTube surfaces); attach the sources ZIP if requested.
4. **Re-hash on receipt:** verify the uploaded artifact against the SHA-256 in §7 before publishing.
5. **Post-publish smoke:** install from the store listing and repeat `scripts/live-probe.mjs` expectations manually (extension loads, hides render at zero size, restore works).

## Verdict

**READY FOR OWNER SUBMISSION.** Both V7 defects are fixed, regression-tested, and covered by a full 22-gate clean pass plus live-YouTube measured evidence. This verdict attests implementation quality and verification completeness — it does not promise Chrome Web Store approval.
