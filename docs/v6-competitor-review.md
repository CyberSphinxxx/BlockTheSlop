# V6-14 — Competitor and usability review (primary sources)

Date: 2026-09-25. Method: primary sources only (Chrome Web Store listing, vendor product pages, GitHub repositories). Screenshots were treated as visual references only. No competitor artifact was executed; all runtime comparisons are therefore NOT MEASURED. No code, branding, or layout was copied; no license permits inference of internal algorithms from listings. License check performed for both open-source projects before considering any reuse (no reuse was needed — see conclusion).

## Matched workflows (guidance per REQUIREMENTS.md UX sequence)

| Workflow                       | SlopMute 0.18.6 (CWS, 2026-09-18)                                                                        | SlopBlock 1.0.0 (GitHub, 2025-11-03)                        | DeSlop (GitHub, accessed 2026-09-25)             | BlockTheSlop V6 (this release)                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guided setup                   | Post-install setup flow; optional "How did you hear about SlopMute?" with explicit "Send answer" consent | None documented (README documents features, not onboarding) | None                                             | First-install-only onboarding (E2E-verified: opens once on `install` only), welcome/privacy, optional local-only discovery question, atomic Apply/Skip/Ready        |
| Protection modes               | 3 named modes (Clean up my feed / No AI slop / Absolutely no AI) — the third folds about-AI into a mode  | Community trust threshold; auto-hide option                 | Global on/off of blocklist                       | Low/Balanced/High → real safe/balanced/strict; about-AI kept as a separate per-category opt-in (never silently bundled into a mode); Aggressive stays advanced-only |
| About-AI handling              | Optionally hides videos discussing AI                                                                    | N/A (reports AI-generated only)                             | Channels that "promote or teach" AI also blocked | Separate `ai-discussion` category, default allow, explicit opt-in card                                                                                              |
| Detection basis                | Visible signals only; explicitly no frames/audio/transcripts                                             | Community reports (crowdsourced)                            | Channel blocklist (community-maintained)         | Visible-text evidence only, with the same explicit limitation copy in onboarding and popup                                                                          |
| Review/restore                 | Private review list, restore, show-once, allow channel                                                   | Warning icons; optional hide                                | None documented                                  | Session recovery (popup + on-page chip) + durable Review tab with undo; every automatic hide has a recovery record or fails open                                    |
| Stats                          | Not documented on the listing                                                                            | Report/trust aggregates (server-side)                       | None                                             | Local day-bucketed outcomes: distinct IDs vs events per local day, 90-day bound, honest empty/off/error states                                                      |
| Permissions surface (declared) | YouTube access; feedback endpoint ("Personal communications" disclosure)                                 | Network to its Supabase backend + CDN                       | Network fetch of the blocklist from GitHub       | storage + contextMenus + youtube.com host only; zero network at runtime by default; no account                                                                      |

## Measured / NOT MEASURED

| Check                                                   | Status                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SlopMute listing claims, permission scope, version/date | MEASURED (read from CWS listing 2026-09-25)                                                                                    |
| SlopBlock architecture/license                          | MEASURED (read from GitHub README 2026-09-25)                                                                                  |
| DeSlop architecture/license                             | MEASURED (read from GitHub README 2026-09-25)                                                                                  |
| Detector accuracy vs any competitor                     | NOT MEASURED (requires matched labeled videos and identical mode settings; V5-10 holdout protocol is the vehicle if later run) |
| Cold/warm popup latency vs competitors                  | NOT MEASURED (no competitor runtime)                                                                                           |
| SlopMute setup flow runtime behavior                    | NOT MEASURED (extension not installed; listing text only)                                                                      |
| SlopBlock/DeSlop runtime behavior                       | NOT MEASURED (not executed)                                                                                                    |

## License check

- SlopBlock (github.com/lydonator/slopblock): repository inspected; no reuse performed. Any future reuse would require compliance with its LICENSE terms as published at that time.
- DeSlop (github.com/NikoboiNFTB/DeSlop): README states GNU GPL v3. Blocklist DATA is content, not code; BlockTheSlop did not and will not import the list file wholesale without review of its licensing statement. No reuse performed.
- SlopMute: closed product; nothing copied. Its listing text informed only neutral, factual workflow comparisons above.

## Concrete improvements adopted in V6 (each backed by tests)

1. **Setup completion vs settings separation** (SlopMute-style post-install setup without its "send feedback" network step): our discovery answer is stored local-only and validated as an enum; there is no send path at all — `tests/unit/v607-onboarding-messages.test.ts`, `tests/ui/v603-onboarding-ui.test.tsx`.
2. **Explicit modes that map to real thresholds** rather than marketing labels: `SENSITIVITY_TO_MODE` is unit-tested to map onto the existing safe/balanced/strict policies and to exclude aggressive — `tests/unit/v603-onboarding-choices.test.ts`.
3. **About-AI as a separate opt-in** instead of a bundled "strictest mode": asserted in the card matrix and the patch builder — `tests/unit/v603-onboarding-choices.test.ts`.
4. **Honest counters** (distinct IDs vs events, explicit collection-off note) instead of lifetime counters labeled "Today" — `tests/ui/v608-popup-status.test.tsx`, `tests/unit/v611-daily-stats.test.ts`.
5. **Chip placement as an accessibility feature** (four corners + off) — `tests/dom/v610-indicator-position.test.ts`, `tests/e2e/v610-indicator.spec.ts`.

## Claims discipline

No superiority claims are made anywhere in product copy. BlockTheSlop shares SlopMute's core limitation (visible-text-only detection; cannot see frames/audio/transcripts) and states it in onboarding, popup, and the statistics page.
