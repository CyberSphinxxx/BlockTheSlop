# V7-12 — Competitor and user-limit review (primary-source refresh)

Date: 2026-09-26. Method: primary sources only — vendor repositories (README/feature docs) and store listings. Nothing was executed; every competitor runtime comparison is NOT MEASURED. No code, branding, or list data was copied. The only competitor-derived behavior in V7 is the V7-11 **import preview**, which reads files the USER exported locally and maps user data, not code (license review below).

## What changed since the V6-14 review (docs/v6-competitor-review.md, 2026-09-25)

- **BlockTube** (github.com/amitbl/blocktube) — now directly reviewed because V7-11 imports its export format. GPLv3. WebExtension (Chrome+Firefox) blocking by video title / channel name / channel ID / video ID / keywords / raw regex; context-menu blocking; blocked-video page behavior options; filtering before DOM render. Architectural contrast: BlockTheSlop deliberately has NO regex rules (user input can never execute or blow up the matcher — CFG-05) and no name-based channel rules (names are not verified identities).
- **FilterTube** (github.com/varshneydevansh/FilterTube) — now directly reviewed. Keyword filters with partial/whole-word modes (V7-09's whole-word phrase rules match this concept); channels by name/@handle/UCID with background handle-enrichment queues; profiles/PINs, device sync ("Nanah" relay), duration/upload-date/ALL-CAPS content filters, comment filtering, Shorts hiding, Android builds. Its changelog documents a **BlockTube migration JSON** flow, independently cross-confirming the BlockTube export shape used by V7-11. Architectural contrast: FilterTube ships optional relay/network sync components; BlockTheSlop remains zero-network by construction.
- **SlopMute 0.18.6** (CWS listing, re-checked 2026-09-26) — no change observed vs the V6-14 review: 3 named modes, optional post-install feedback with explicit consent, visible-signal detection only. Still closed-source; runtime NOT MEASURED.
- **SlopBlock 1.0.0** (GitHub, re-checked 2026-09-26) — no change vs V6-14: crowdsourced report/trust model with a Supabase backend + CDN caching; anonymous reporting. Runtime and report quality NOT MEASURED; the model is fundamentally different (community truth vs local evidence).
- **DeSlop** (GitHub, re-checked 2026-09-26) — no change vs V6-14: GitHub-fetched community blocklist of channels (GPLv3); explicitly fetches a remote list at runtime. BlockTheSlop never fetches remote lists (kit: "Never silently enable remote lists").

## Feature-only comparison (no runtime claims)

| Capability                              | BlockTube           | FilterTube                     | SlopBlock         | DeSlop                       | BlockTheSlop V7                                                     |
| --------------------------------------- | ------------------- | ------------------------------ | ----------------- | ---------------------------- | ------------------------------------------------------------------- |
| Detection basis                         | User rules only     | User rules only                | Community reports | Community blocklist          | Local visible-text evidence + user rules                            |
| AI-production vs slop axes              | N/A                 | N/A                            | Single "AI" label | Mixed (promo/teach channels) | Separate axes, separate corrections                                 |
| Explainability of a hidden/passed video | Rule list           | Rule list                      | Trust aggregates  | List membership              | Why-inspector (V7-06) + per-decision explanation lines              |
| Miss diagnostics                        | None documented     | Import reports (rules)         | None documented   | None                         | Bounded local miss-review queue (V7-07), no auto-training           |
| Rule safety                             | Raw regex supported | Partial/whole-word             | N/A               | Curated list                 | Literal/whole-word only, safe preview (V7-09), no regex             |
| Import from competitors                 | N/A                 | BlockTube migration JSON       | N/A               | N/A                          | BlockTube/FilterTube local-file preview with apply/rollback (V7-11) |
| Recovery of hidden videos               | None documented     | None documented                | Warnings only     | None                         | Session restore + durable review with identity validation (V7-04)   |
| Network at runtime                      | None documented     | Optional relay/sync components | Backend + CDN     | GitHub blocklist fetch       | None by default; storage+contextMenus+youtube.com only              |
| Shorts shelf collapse                   | N/A                 | Shorts hiding toggle           | N/A               | Feed only                    | Attribute-driven collapse, no boxes/no gaps (V7-02/03)              |

All competitor cells are from primary-source documentation; "None documented" means the feature is not described in the reviewed source, not that it does not exist.

## Measured / NOT MEASURED

| Check                                                                               | Status                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| BlockTube/FilterTube format mapping (V7-11) against documented shapes               | MEASURED (unit tests on representative documented fields; real user exports may still vary — the importer rejects rather than guesses) |
| BlockTube repo README/license, FilterTube repo, SlopBlock repo, DeSlop repo re-read | MEASURED (2026-09-26, links above)                                                                                                     |
| SlopMute CWS listing re-read                                                        | MEASURED (listing text 2026-09-26; V6-14 recorded 2026-09-25)                                                                          |
| Any competitor runtime behavior, latency, or accuracy                               | NOT MEASURED (no competitor executed in this environment)                                                                              |
| Detector accuracy vs competitors on matched videos                                  | NOT MEASURED (needs a shared labeled corpus; the V7-10 frozen sets are BlockTheSlop-only)                                              |
| FilterTube "Nanah" sync / profiles / PIN runtime                                    | NOT MEASURED (documentation only)                                                                                                      |
| SlopBlock trust-system effectiveness                                                | NOT MEASURED                                                                                                                           |

## User-facing limits (unchanged and re-affirmed)

- Visible-text evidence only: no frames, audio, or transcripts are ever read; disclosed-limitation copy in onboarding/popup/why-inspector.
- Heuristic scores, not calibrated probabilities; no "perfect detector" claims anywhere (V7-10 floors, not ceilings).
- Metadata absence (no disclosure badge) is _unknown_, never evidence of human authorship.
- Community/competitor lists are data, not ground truth; importing maps user-chosen rules and nothing else.

## License check for V7-11 (the only competitor-derived surface)

- BlockTube: GPLv3. The importer READS a JSON file the user exported; no BlockTube code, assets, or branding is copied, and no GPL code is linked or derived. Mapping user data between tools is not a derivative work; the mapping logic in `src/domain/competitor-import.ts` is original and clean-room relative to BlockTube's implementation (written from the public README's documented feature list, not its source).
- FilterTube: public repository reviewed for format only; same clean-room basis (README/changelog feature descriptions). No code copied.
- DeSlop/SlopBlock/SlopMute: no interaction with V7 features; no reuse.

## Concrete improvements adopted in V7 (each backed by tests)

1. **Whole-word phrase rules with safe preview** (FilterTube parity on match modes, without regex): `tests/unit/v709-rule-preview.test.ts`, `tests/unit/v709-rule-scale.test.ts`.
2. **Competitor import preview with explicit apply/rollback** (FilterTube-style migration, done fail-safe): `tests/unit/v711-competitor-import.test.ts`, `tests/ui/v711-competitor-import-ui.test.tsx`.
3. **Miss diagnostics as a first-class tab** (beyond any competitor's rule lists): `tests/unit/v707-miss-review.test.ts`, `tests/ui/v707-miss-review-ui.test.tsx`.
4. **Why-inspector for passed videos** (explains non-hides, which no reviewed competitor documents): `tests/dom/v706-why-inspector.test.ts`.

## Claims discipline

No superiority claims are made in product copy. The comparison table above is a documentation-level feature matrix. Every NOT MEASURED row stays NOT MEASURED until someone runs the rivals under a recorded protocol; this release does not.
