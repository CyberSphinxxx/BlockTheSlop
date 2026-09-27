# BlockTheSlop — Privacy Policy

**Effective date:** 2026-09-27 · **Applies to:** BlockTheSlop 1.0.0 (Chrome MV3 / Firefox MV2)

BlockTheSlop is local-first software: it inspects YouTube pages on your device
to filter AI-generated, automated, repetitive, and low-quality ("slop")
videos, and it keeps every piece of data it needs on your device. This policy
explains exactly what the extension reads, what it stores, where each data
class lives, what never leaves your device, and how you can delete it.

## What the extension does on YouTube pages

When you open youtube.com, the extension's content script reads the visible
metadata of video cards on the page — titles, descriptions, channel names and
IDs, badge text (including YouTube's own "Altered or synthetic content"
disclosure), and aria labels. This inspection happens entirely in your
browser: the page content is analyzed locally to decide whether to hide or
label a card according to your settings.

**No page content is uploaded anywhere.** Nothing you watch or search for is
sent to the extension's developer or to any third party by this extension.

## What is stored, and where

Everything the extension stores lives in your browser profile, either in
`chrome.storage.local` (extension origin) or in IndexedDB at the extension
origin. Nothing is transmitted off the device.

| Data                                                                       | Purpose                                                            | Where                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Settings (modes, categories, surfaces, display options)                    | Remember your filtering choices                                    | `chrome.storage.local`       |
| Video/channel rules (allow/block, phrase rules)                            | Your explicit decisions, re-applied everywhere                     | `chrome.storage.local`       |
| Onboarding state, incl. the optional "where did you hear about us?" answer | Setup flow; the discovery answer is stored **only** on this device | `chrome.storage.local`       |
| Review history of hidden/warned videos                                     | Let you review and restore hides                                   | IndexedDB (extension origin) |
| Corrections ("Not AI" / "Not slop")                                        | Stop the filter from repeating a false positive                    | IndexedDB (extension origin) |
| Detection cache                                                            | Avoid re-evaluating the same card repeatedly                       | IndexedDB                    |
| Local statistics (daily, distinct-video counters)                          | The "filtered" numbers you see                                     | IndexedDB                    |
| Miss-review diagnostics (optional "why did this pass?" marks)              | Show why the filter missed a video you marked                      | IndexedDB                    |

## What never leaves your device

- No telemetry, analytics, or crash reporting of any kind.
- No accounts, no sign-in, no cloud AI: all classification is heuristic and
  runs locally.
- No content uploads: page text, video metadata, watch history, and search
  history are never transmitted by this extension.
- The extension bundle performs no requests to any remote server. The only
  network-shaped calls inside the bundle retrieve the extension's own packaged
  interface resources from its own `chrome-extension://` origin.

Two controls in Settings are visibly disabled and marked "Not available in
this build": a remote reputation provider and "Also tell YouTube Not
interested." Neither is wired in this build; enabling them is impossible, and
no code path sends data anywhere or performs YouTube account actions.

## Permissions, and why each exists

- **Storage** — keeps your settings, rules, onboarding state, corrections,
  history, and statistics on your device.
- **Context menus** — adds the right-click entries "Hide this video with
  BlockTheSlop", "Block this channel with BlockTheSlop", and "Why is this
  still showing?" on YouTube video cards.
- **YouTube host access (`*://*.youtube.com/*`)** — the content script runs on
  youtube.com pages, where filtering happens. It requests no other host,
  injects nothing into other sites, and performs no remote calls.

## Your data, and the controls that delete it

Each data class has its own control (DATA-08: no all-or-nothing wipe that
would surprise you):

- **Reset all settings** (Settings page, confirm dialog): returns _settings_
  to factory defaults. Your allow/block rules are **kept**.
- **Clear all review history** (Review page): deletes the review-history
  records in IndexedDB. Your "Not AI / Not slop" **corrections are kept** by
  design (they protect you from repeat false positives) and survive history
  clears.
- **Delete corrections** (Settings → data controls): removes the stored
  corrections separately.
- **Clear detection cache** and **reset statistics**: separate controls for
  those IndexedDB stores.
- **Uninstalling the extension** removes its `chrome.storage.local` and
  IndexedDB data with the browser profile's normal extension cleanup.
- **Import/export** is user-initiated: exporting downloads a JSON file
  containing your settings, rules, review-history records, and local
  statistics; importing validates that file strictly (bounded size/nesting,
  prototype-like keys rejected, remote/feedback flags arrive disabled) and
  shows a preview before anything is applied. Corrections, cache, and
  onboarding answers are **not** part of the export.

## Session recovery

Hidden cards are recoverable two ways: the durable **review history** (when
history is enabled) and the **session recovery** list (on-page corner notice
and the popup's Session list). Session recovery is intentionally
session-scoped: it lives in memory for the current page view, so navigating
away or reloading the page resets it, and every card renders visible again.
Capacity is bounded (100 cards); when the store is full, the oldest hidden
card is revealed rather than silently losing its recovery route.

## Known exceptions (stated plainly)

- If you export data and share that file, its contents are of course no
  longer private once you share the file itself.
- The extension cannot see or affect anything outside youtube.com pages in
  your browser (other sites, other apps, or OS-level data).
- Counts and history derive from what the extension observed while enabled;
  if filtering is disabled or the profile is fresh, no data about that period
  exists anywhere.

## Changes to this policy

Material changes will be reflected in the extension's release notes for the
version that ships them, and the effective date above will be updated.

---

Verification note (internal, 2026-09-27): the claims above were checked
against the implementation and the production Chrome bundle for 1.0.0 —
control names/effects from `src/entrypoints/options/App.tsx` and
`src/background/index.ts` (DATA-08 per-class clears); storage locations from
`src/storage/` (CorrectionStore/HistoryStore/cache/stats in IndexedDB via
StorageService; settings/rules/onboarding in storage.local); export contents
from `src/import-export/schema.ts buildExport()`; bundle scan shows no
fetch/XHR/WebSocket/sendBeacon targets outside the extension's own origin,
and `src/providers/http-provider.ts` is not imported by any entrypoint.
