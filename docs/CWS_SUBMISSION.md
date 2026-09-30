# BlockTheSlop: Chrome Web Store Submission Package

Version 1.0.0 · prepared 2026-09-27 · artifact: `.output/block-the-slop-1.0.0-chrome.zip`
(hash recorded in `.agents/block-the-slop-v7/RELEASE_EVIDENCE.json`)

Nothing here has been submitted or published. Dashboard/account actions the
owner must complete are listed at the end.

## Store listing copy

### Name (≤75 chars; manifest limit)

`BlockTheSlop: AI Slop Blocker for YouTube` (41 characters)

### Short description (≤132 chars; mirrors manifest)

`Filter AI-generated and repetitive YouTube videos locally. Every auto-hide is explainable, recoverable, and yours to undo.` (122 characters)

### Single-purpose statement

BlockTheSlop has one purpose: hiding or labeling AI-generated and low-quality
("slop") YouTube videos according to the user's own rules, with every automatic
hide kept explainable and reversible. It does nothing else on any page.

### Detailed description

BlockTheSlop filters AI-generated, automated, repetitive, and low-quality
("slop") videos from YouTube — while keeping every automatic decision
explainable and reversible.

- Heuristic detection with separate **AI likelihood** and **slop likelihood**
  scores. YouTube's own "Altered or synthetic content" disclosure is treated as
  a strong signal.
- Safe / Balanced / Strict / Aggressive modes (default: **Balanced**),
  per-category actions, and per-surface toggles (home, search, subscriptions,
  watch sidebar, Shorts shelf, and more). Onboarding can select Safe,
  Balanced, or Strict from your answers.
- Per-video and per-channel allow/block, plus literal phrase rules.
- Gap-free Collapse or Placeholder display for hidden videos; a compact corner
  counter shows how many distinct videos are currently hidden.
- Right-click any card to hide the video or block the channel (with instant
  Undo and conflict detection).
- Durable, paginated review history with restore, "Not AI"/"Not slop"
  corrections, bulk delete, and filters; corrections survive history clears.
- Every automatic hide stays recoverable: Review history when history is on,
  and the on-page Session Recovery notice plus the popup's Session Recovery
  list when history is off. Session recovery is intentionally session-scoped
  (in-memory for the current page view; navigation or reload resets it) and
  capacity-bounded — the oldest hidden card is revealed rather than silently
  losing its route.
- Fully local: no account, no telemetry, no cloud AI, no API keys, works
  offline. Data never leaves your device. See our privacy policy (below).

Scores are heuristic signals, not certainties: undisclosed AI content with no
observable signal cannot be detected by any metadata-only tool, and Aggressive
mode intentionally accepts more false positives in exchange for recall — every
hide is one click to undo.

### Permission justifications

(Enter these in the dashboard under the item's permission justifications
fields; keep each under the field's character budget.)

| Permission                            | Justification                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                             | Stores the user's settings, video/channel rules, corrections, review history, detection cache, and local statistics on the device. Required for the extension to remember anything between page views.                   |
| `contextMenus`                        | Powers the right-click menu entries "Hide this video with BlockTheSlop" / "Block this channel with BlockTheSlop" / "Why is this still showing?" on YouTube video cards — core, shipped user-facing features.             |
| Host permission `*://*.youtube.com/*` | The content script must run on youtube.com pages to inspect video card metadata and apply the user's filtering. The extension requests no other host, injects no scripts into other sites, and performs no remote calls. |

### Privacy disclosures (Privacy practices tab — field-specific guidance)

Complete the dashboard's Privacy practices tab as follows. Sources (verified
2026-09-27):

- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq —
  extensions must disclose user-data handling **even when everything is
  processed and stored locally on the device** (FAQ #3 and #14), and "handle"
  includes collecting web browsing activity / website content (FAQ #2 and #4).
- https://developer.chrome.com/docs/webstore/program-policies/limited-use —
  Limited Use requirements.
- https://developer.chrome.com/docs/webstore/registeritem/#privacy-tab —
  where the fields appear in the dashboard.

**Does this item handle user data?** — **Yes.** Per the FAQ, reading website
content (video titles/descriptions on youtube.com) and storing it locally
counts as handling, even without transmission. Do NOT answer "No" — that
would misstate local processing.

**Privacy policy URL** — paste the URL where the owner hosts
`docs/PRIVACY_POLICY.md` (owner action; do not invent a URL).

**Data categories disclosed** — check the categories the item collects:

- **Website content** (titles/descriptions/badges of youtube.com cards,
  read on-device to decide filtering) — collected: yes; stored locally: yes;
  transmitted off-device: no.
- **Web browsing activity** (youtube.com URLs/page context the content script
  runs on) — collected: yes, limited strictly to the single user-facing
  filtering feature; transmitted off-device: no.
- All other categories (personal information, financial/payment, health,
  authentication, personal communications, user-generated content):
  **not collected.**

**Certifications** — certify all of the following (accurate for this build):

- Data is not sold to or shared with third parties, except with the owner's
  consent or for legal reasons. ✔
- Data is not used for purposes unrelated to the single purpose, including
  advertising, creditworthiness, or lending. ✔
- Data is not collected or used for any purpose other than the disclosed
  user-facing feature. ✔

**Compliance note:** no user data leaves the device at all, so the secure
transmission requirement (FAQ #8–9) is not triggered; local storage is at the
extension origin, per FAQ #14 disclosure obligations are met by the hosted
privacy policy plus the in-product descriptions.

### Reviewer test instructions

1. Load `.output/chrome-mv3` unpacked (or install the zip build) and open
   https://www.youtube.com signed out.
2. The extension adds a corner notice when videos are hidden. With default
   **Balanced** settings, cards matching heuristic AI/slop signals collapse
   with no blank gap; the corner counter shows the number of distinct hidden
   videos.
3. Click the corner counter to open Session Recovery: "Restore" reveals one
   card, "Restore all" reveals everything for this page session. A restored
   card stays visible (it is not immediately re-hidden).
4. Open the popup: the Session list mirrors the on-page recovery rows; the
   status chip reports the current surface and hidden count. "Options" opens
   the full settings page.
5. In Options, toggle a category (e.g. AI-generated) and note cards update on
   the next pass without reload; switch display mode between Collapse and
   Placeholder; disable History and repeat steps 2–4 — recovery still works
   via the popup/on-page list.
6. Right-click a video card: use "Hide this video with BlockTheSlop", then
   Undo. Right-click a channel avatar: "Block this channel…" requires a
   canonical channel and offers Undo.
7. Use "Review history" to restore or mark false positives ("Not AI"); the
   corrected video stays visible on subsequent pages.
8. Disable filtering in the popup: all hidden cards reappear immediately;
   re-enabling re-applies your rules.

### Detector limitations and false-positive recovery

- Detection is heuristic and evidence-based (title/description text, badges,
  channel signals, YouTube's own disclosure label). It is not, and is not
  presented as, an AI-content oracle; undisclosed AI videos without observable
  signals will not be detected.
- Any hidden video can be restored in one click (placeholder "Reveal once",
  Session Recovery, or Review history) and permanently allowed per video or
  channel; "Not AI" / "Not slop" corrections prevent repeats.
- Aggressive mode trades precision for recall by design.

### Supported YouTube surfaces

Home, search results, subscriptions, watch-page sidebar and compact cards,
channel pages, playlists, history, watch later, Shorts shelf, and the Shorts
feed. Unknown or redesigned layouts fail open: cards are left visible rather
than mis-filtered.

### Version and release notes

- **1.0.0 (2026-09-27):** first store release candidate. Category- and
  surface-based filtering, phrase rules, per-video/channel rules, review
  history with corrections and retention, session recovery with identity
  validation, context-menu blocking, import/export with preview validation,
  and local-only statistics. Firefox build ships from the same source with an
  MV2 manifest.

### Support contact

The repository README is the support channel for this project; no external
support email or website is published in this build. (Owner: add a verified
contact before submission if desired — see outstanding actions.)

## Listing assets (owner to prepare/upload)

- **Store icon (128×128 PNG, required):** the extension already ships
  `icon/128.png` — reusable for the dashboard upload.
- **Small promo tile (440×280, required):** not yet produced.
- **Marquee (1400×560, optional):** not yet produced.
- **Screenshots (1280×800, required):** take REAL screenshots of the built
  extension on youtube.com (signed out is fine). Do not present local fixture
  pages as real YouTube results. Suggested shots: a filtered home grid with
  the corner counter visible; Session Recovery panel open with a Restore
  hover; the popup with the Session list; the Options "Modes" section;
  the right-click context menu on a video card.
- Promotional images should follow the store guidelines (no competitor
  branding, no YouTube brand marks beyond nominative screen content).

## Owner actions required before submission (dashboard / credentials)

1. Register/verify the CWS developer account and pay the one-time fee, if not
   already done (owner-only).
2. Choose the published developer identity and a support contact (email or
   site). None is invented in this package; the listing currently points at
   the repository only.
3. Host the privacy policy at a public URL and paste that URL into the
   dashboard's Privacy practices tab (content: `docs/PRIVACY_POLICY.md`).
   Complete the data-usage disclosures per the field-specific "Privacy
   disclosures" section above — note the item handles website content
   locally, which must be disclosed even though nothing is transmitted.
4. Produce and upload the 440×280 promo tile (required) and optionally the
   1400×560 marquee; take and upload real 1280×800 screenshots.
5. Upload `.output/block-the-slop-1.0.0-chrome.zip` to a new draft item, fill
   the listing from this document, and submit for review. (Deliberately NOT
   done by automation.)
6. Optional: decide whether the Firefox build is distributed separately
   (AMO) or held; it is built and smoke-verified but has no AMO listing prep.
