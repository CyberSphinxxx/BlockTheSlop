/**
 * Namespaced presentation CSS. All selectors are prefixed with [data-bts-*]
 * or .bts-* and never target YouTube classes, so unrelated UI is untouched.
 *
 * Delivery contract (R03): this constant is imported and injected verbatim by
 * `ensureStyles()` in apply-decision.ts. The built content-script bundle must
 * contain these rules (asserted by tests/e2e/css-presence.spec.ts).
 */
export const PRESENTATION_CSS = `
.bts-activity-notice {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  max-width: min(240px, calc(100vw - 32px)); padding: 6px 10px;
  border-radius: 999px; background: rgba(32,43,61,.92); color: #fff;
  box-shadow: 0 2px 10px rgba(0,0,0,.2);
  font: 500 11px/1.3 "Roboto", "Segoe UI", sans-serif;
  pointer-events: auto;
  cursor: pointer;
}
/* ---- V6-10: optional positions (default bottom-right above). Insets are
   sized to keep clear of YouTube's own chrome: header (~56px), player
   controls/progress bar (~24-60px), and corner overlays. ---- */
.bts-activity-notice.bts-activity-pos-top-left { top: 68px; left: 16px; right: auto; bottom: auto; }
.bts-activity-notice.bts-activity-pos-top-right { top: 68px; right: 16px; bottom: auto; }
.bts-activity-notice.bts-activity-pos-bottom-left { bottom: 72px; left: 16px; right: auto; }
.bts-activity-notice.bts-activity-pos-bottom-right { bottom: 16px; right: 16px; }
@media (max-width: 640px) {
  .bts-activity-notice.bts-activity-pos-top-left,
  .bts-activity-notice.bts-activity-pos-top-right { top: 60px; }
}
/* ---- Theme (N15/CFG-10) ----
   Extension-owned surfaces recolor via CSS custom properties. The content
   script sets data-bts-theme on <html> from settings; 'system' keeps the
   attribute absent so the host page's own scheme applies. */
:root { --bts-bg: rgba(120,120,120,0.14); --bts-fg: currentColor; }
[data-bts-theme="dark"] {
  --bts-bg: rgba(32,32,36,0.92);
  --bts-fg: #f1f1f1;
}
[data-bts-theme="light"] {
  --bts-bg: rgba(255,255,255,0.94);
  --bts-fg: #0f0f0f;
}

/* ---- Hide with placeholder (default) ----
   Suppress ALL card children (native thumbnail/title/metadata) while keeping
   the card's own layout slot, then reveal only the extension placeholder. */
[data-bts-state="hidden"] > :not(.bts-placeholder):not(.bts-overlay):not(.bts-status) {
  display: none !important;
  visibility: hidden !important;
}
[data-bts-state="hidden"] {
  visibility: visible !important;
}
[data-bts-state="hidden"] .bts-placeholder {
  display: flex !important;
  visibility: visible !important;
}

/* Placeholder surface */
.bts-placeholder {
  all: unset;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  width: 100%;
  min-height: 48px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bts-bg);
  color: var(--bts-fg);
  font: 500 13px/1.4 "Roboto", "Segoe UI", sans-serif;
}
.bts-placeholder:hover { background: var(--bts-bg); filter: brightness(1.12); }
.bts-placeholder .bts-placeholder-title { font-weight: 600; }
.bts-placeholder .bts-placeholder-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bts-placeholder .bts-why-details {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-left: 3px solid currentColor;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---- Warn marker (N16): compact, in-flow, OUTSIDE the hover-preview hit area.
   The marker is a sibling AFTER the thumbnail anchor — it never overlaps the
   video preview, native badges, or the navigation anchor. YouTube's hover
   preview therefore cannot cover it, and no pointer-events layer blocks
   native clicks. */
.bts-warn-marker {
  all: unset;
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--bts-bg);
  color: var(--bts-fg);
  font: 500 13px/1.4 "Roboto", "Segoe UI", sans-serif;
  pointer-events: auto;
}
.bts-warn-marker .bts-warn-chip {
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.bts-warn-marker .bts-overlay-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bts-warn-marker .bts-why-details {
  flex-basis: 100%;
  color: var(--bts-fg);
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---- Shared controls (N16: stable hit targets ≥24px at 100% zoom) ---- */
.bts-button {
  all: unset;
  box-sizing: border-box;
  min-height: 24px;
  min-width: 24px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.bts-button:hover { background: rgba(255, 255, 255, 0.28); }
.bts-button:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 1px;
  background: rgba(255, 255, 255, 0.28);
}
.bts-warn-marker .bts-button { background: rgba(0, 0, 0, 0.08); border-color: rgba(0, 0, 0, 0.2); }
[data-bts-theme="dark"] .bts-warn-marker .bts-button {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.3);
}

/* Accessible status text: never color-only */
.bts-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---- Collapse mode: remove the card's layout slot entirely ----
   [data-bts-collapse] is set on the card itself (which IS the grid cell on
   Shorts shelves / lists); [data-bts-slot="collapse"] is set by the
   presentation layer on the card's OUTER layout wrapper when the wrapper is
   the real grid cell (e.g. a ytd-rich-item-renderer around one yt-lockup).
   V7-02: the old fixed wrapper rules are gone — a generic rich-item :has()
   rule also matched the ONE rich-item that wraps an entire Shorts shelf,
   hiding the whole shelf (visible Shorts included) when a single Short was
   hidden. Slot wrappers
   are now resolved per-card in apply-decision.ts (bounded ancestor walk,
   never detaching any node) and marked with data-bts-slot, so Shorts
   lockups, legacy grids and modern lockups all collapse without gaps. */
[data-bts-collapse],
[data-bts-slot="collapse"] {
  display: none !important;
}
/* V7-02: named Shorts cell rules — the Shorts shelf card and the Shorts
   feed/reel item collapse directly; their wrappers are slot-marked when
   (and only when) they wrap exactly one card. */
ytm-shorts-lockup-view-model[data-bts-collapse],
ytd-reel-item-renderer[data-bts-collapse] {
  display: none !important;
}

/* ---- Session recovery interactive panel ---- */
.bts-activity-notice {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  max-width: min(280px, calc(100vw - 32px)); padding: 6px 12px;
  border-radius: 999px; background: rgba(32,43,61,.94); color: #fff;
  box-shadow: 0 2px 10px rgba(0,0,0,.25);
  font: 500 12px/1.3 "Roboto", "Segoe UI", sans-serif;
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  display: flex; align-items: center; gap: 6px;
}
.bts-activity-notice:hover { background: rgba(40,55,80,.98); }
.bts-activity-panel {
  position: fixed; right: 16px; bottom: 52px; z-index: 2147483646;
  width: 320px; max-width: calc(100vw - 32px); max-height: 380px;
  overflow-y: auto; padding: 12px; border-radius: 12px;
  background: rgba(28,32,40,0.96); color: #f1f1f1;
  box-shadow: 0 4px 20px rgba(0,0,0,.4);
  font: 400 12px/1.4 "Roboto", "Segoe UI", sans-serif;
  backdrop-filter: blur(8px);
}
.bts-activity-panel-header {
  display: flex; justify-content: space-between; align-items: center;
  font-weight: 600; font-size: 13px; margin-bottom: 8px;
}
.bts-activity-panel-close {
  background: none; border: none; color: inherit; cursor: pointer;
  font-size: 14px; padding: 2px 6px; border-radius: 4px;
}
.bts-activity-panel-close:hover { background: rgba(255,255,255,0.15); }
.bts-activity-item {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.08);
}
.bts-activity-item:last-child { border-bottom: none; }
.bts-activity-item-info { flex: 1; min-width: 0; }
.bts-activity-item-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bts-activity-item-sub { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- Deliberate Manual Mark -> Channel Choice (V5-07) ---- */
.bts-channel-choice-notice {
  position: fixed; right: 16px; bottom: 56px; z-index: 2147483647;
  max-width: min(380px, calc(100vw - 32px));
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(28, 32, 40, 0.96);
  color: #fff;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  font: 400 13px/1.4 "Roboto", "Segoe UI", sans-serif;
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bts-channel-choice-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: 14px;
}
.bts-channel-choice-header span {
  color: #3ea6ff;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bts-channel-choice-body {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
}
.bts-channel-choice-channel {
  font-weight: 600;
  color: #fff;
}
.bts-channel-choice-handle {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  margin-left: 4px;
}
.bts-channel-choice-scope {
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.65);
  background: rgba(255, 255, 255, 0.05);
  padding: 6px 8px;
  border-radius: 6px;
}
.bts-channel-choice-conflict {
  font-size: 11px;
  line-height: 1.35;
  color: #ffcc00;
  background: rgba(255, 204, 0, 0.1);
  padding: 6px 8px;
  border-radius: 6px;
  border-left: 3px solid #ffcc00;
}
.bts-channel-choice-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.bts-button-danger {
  background: rgba(220, 38, 38, 0.8) !important;
  border-color: rgba(220, 38, 38, 0.9) !important;
  color: #fff !important;
}
.bts-button-danger:hover {
  background: rgba(220, 38, 38, 1) !important;
}

/* ---- V7-06: "Why is this still showing?" inspector panel ---- */
.bts-why-inspector {
  position: fixed; right: 16px; top: 68px; z-index: 2147483647;
  width: 360px; max-width: calc(100vw - 32px); max-height: min(560px, calc(100vh - 96px));
  overflow-y: auto; padding: 14px 16px; border-radius: 12px;
  background: rgba(28, 32, 40, 0.97); color: #f1f1f1;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  font: 400 12px/1.45 "Roboto", "Segoe UI", sans-serif;
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.bts-why-header { display: flex; justify-content: space-between; align-items: center; }
.bts-why-title { font-weight: 600; font-size: 14px; }
.bts-why-inspector-close {
  background: none; border: none; color: inherit; cursor: pointer;
  font-size: 14px; padding: 2px 6px; border-radius: 4px;
}
.bts-why-inspector-close:hover { background: rgba(255, 255, 255, 0.15); }
.bts-why-video-title { font-weight: 600; font-size: 13px; margin: 8px 0 4px; }
.bts-why-status {
  margin: 6px 0; padding: 6px 8px; border-radius: 6px;
  background: rgba(255, 255, 255, 0.06); font-weight: 500;
}
.bts-why-section {
  margin: 10px 0 4px; font-weight: 600; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75;
}
.bts-why-observed, .bts-why-policy { display: flex; flex-direction: column; gap: 2px; }
.bts-why-row { display: flex; gap: 8px; }
.bts-why-label { flex: 0 0 auto; opacity: 0.65; min-width: 118px; }
.bts-why-value { overflow-wrap: anywhere; }
.bts-why-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.bts-why-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.bts-why-phrase { display: flex; gap: 6px; }
.bts-why-phrase-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  padding: 4px 8px; border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.08); color: inherit; font: inherit;
}
.bts-why-footnote { margin-top: 10px; opacity: 0.6; font-size: 11px; }

/* ---- Compact density (CFG-10): smaller placeholders, applied via a class
   on the page root by the content script when settings.density = compact. */
.bts-root-compact .bts-placeholder {
  min-height: 28px;
  padding: 2px 8px;
  font: 500 11px/1.3 "Roboto", "Segoe UI", sans-serif;
  gap: 2px;
}
.bts-root-compact .bts-warn-marker { padding: 2px 6px; font: 500 11px/1.3 "Roboto", "Segoe UI", sans-serif; }
.bts-root-compact .bts-button { padding: 2px 6px; min-height: 20px; }

/* Never overlay native video controls during fullscreen or theater playback (V5-09) */
ytd-watch-flexy[fullscreen] .bts-activity-notice,
ytd-watch-flexy[fullscreen] .bts-activity-panel,
ytd-watch-flexy[fullscreen] .bts-channel-choice-notice,
:fullscreen .bts-activity-notice,
:fullscreen .bts-activity-panel,
:fullscreen .bts-channel-choice-notice {
  display: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .bts-overlay,
  .bts-placeholder,
  .bts-button,
  .bts-activity-notice,
  .bts-activity-panel,
  .bts-channel-choice-notice,
  .bts-channel-block-btn {
    transition: none !important;
    animation: none !important;
  }
}
`;
