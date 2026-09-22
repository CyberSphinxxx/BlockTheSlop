/**
 * Namespaced presentation CSS. All selectors are prefixed with [data-bts-*]
 * or .bts-* and never target YouTube classes, so unrelated UI is untouched.
 *
 * Delivery contract (R03): this constant is imported and injected verbatim by
 * `ensureStyles()` in apply-decision.ts. The built content-script bundle must
 * contain these rules (asserted by tests/e2e/css-presence.spec.ts).
 */
export const PRESENTATION_CSS = `
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
  background: rgba(120, 120, 120, 0.14);
  color: inherit;
  font: 500 13px/1.4 "Roboto", "Segoe UI", sans-serif;
}
.bts-placeholder:hover { background: rgba(120, 120, 120, 0.22); }
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

/* ---- Warn overlay (content stays usable) ---- */
.bts-overlay {
  all: unset;
  box-sizing: border-box;
  position: absolute;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 12px;
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.15) 0%, rgba(0, 0, 0, 0.75) 100%);
  color: #fff;
  font: 500 13px/1.4 "Roboto", "Segoe UI", sans-serif;
  pointer-events: auto;
}
.bts-overlay .bts-overlay-headline { font-weight: 700; }
.bts-overlay .bts-overlay-reasons {
  margin: 0;
  padding: 0 0 0 16px;
  list-style: disc;
  max-height: 40%;
  overflow: hidden;
}
.bts-overlay .bts-overlay-actions,
.bts-overlay .bts-why-details { display: block; }
.bts-overlay .bts-why-details {
  color: #fff;
  font-weight: 400;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ---- Shared controls ---- */
.bts-button {
  all: unset;
  box-sizing: border-box;
  padding: 6px 10px;
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
.bts-overlay .bts-button { background: rgba(255, 255, 255, 0.18); }

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
   [data-bts-state="hidden"][data-bts-collapse] is set instead of the
   placeholder styles when display mode = collapse. */
[data-bts-state="hidden"][data-bts-collapse] {
  display: none !important;
}

/* ---- Compact density (CFG-10): smaller placeholders, applied via a class
   on the page root by the content script when settings.density = compact. */
.bts-root-compact .bts-placeholder {
  min-height: 28px;
  padding: 2px 8px;
  font: 500 11px/1.3 "Roboto", "Segoe UI", sans-serif;
  gap: 2px;
}
.bts-root-compact .bts-button { padding: 2px 6px; }

@media (prefers-reduced-motion: reduce) {
  .bts-overlay, .bts-placeholder, .bts-button {
    transition: none !important;
    animation: none !important;
  }
}
`;
