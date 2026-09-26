import type { FilterDecision } from '@/domain/decision';
import type { Classification } from '@/domain/classification';

/**
 * V7-06: the "Why is this still showing?" inspector.
 *
 * A local, privacy-safe explanation for the SELECTED video — never the search
 * box, sibling cards, or extension UI. The report states what was OBSERVED,
 * what the policy decided, and the card's current page status. It never claims
 * detector certainty, and absence of evidence is always described as absence.
 *
 * Actions are deliberate user expressions about THIS video only:
 * Hide video (requires a video id), Block channel (only with verified
 * canonical id or handle), Add literal phrase (a title text rule).
 */

export interface WhyReport {
  observed: {
    videoId: string | undefined;
    title: string;
    channelId: string | undefined;
    handle: string | undefined;
    displayName: string | undefined;
    /** Surface the card was parsed under ('unknown' for selected-card scope). */
    surface: string;
    isShort: boolean;
    /** Official altered/synthetic label presence (badge text, not certainty). */
    officialDisclosure: boolean;
    badges: string[];
    /** Literal phrase rule matched against the title, if any. */
    matchedPhrase: string | undefined;
  };
  decision: FilterDecision;
  classification: Classification | undefined;
  corrections: { notAi: boolean; notSlop: boolean };
  pageStatus: {
    enabled: boolean;
    surfaceAllowed: boolean;
    /** data-bts-state of the card on this page, when hidden/warned. */
    currentState: string | null;
  };
}

export interface WhyInspectorActions {
  onHideVideo(): void;
  onBlockChannel(): void;
  onAddPhrase(phrase: string): void;
  onClose(): void;
}

const PANEL_ID = 'bts-why-inspector';

export function whyPanelElement(): HTMLElement | null {
  return document.getElementById(PANEL_ID);
}

function closeExisting(): void {
  whyPanelElement()?.remove();
}

function row(label: string, value: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'bts-why-row';
  const dt = document.createElement('span');
  dt.className = 'bts-why-label';
  dt.textContent = label;
  const dd = document.createElement('span');
  dd.className = 'bts-why-value';
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bts-button';
  btn.textContent = label;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function sectionTitle(text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'bts-why-section';
  div.textContent = text;
  return div;
}

/**
 * Render the inspector panel for the report. Replaces any existing panel
 * (one inspector at a time). All content is set via textContent — never
 * innerHTML with page-derived strings (XSS contract).
 */
export function showWhyInspector(report: WhyReport, actions: WhyInspectorActions): void {
  closeExisting();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'bts-why-inspector';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Why is this still showing?');

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'bts-why-header';
  const title = document.createElement('div');
  title.className = 'bts-why-title';
  title.textContent = 'Why is this still showing?';
  const close = button('✕', () => actions.onClose());
  close.className = 'bts-why-inspector-close';
  close.setAttribute('aria-label', 'Close inspector');
  header.append(title, close);
  panel.appendChild(header);

  const videoTitle = document.createElement('div');
  videoTitle.className = 'bts-why-video-title';
  videoTitle.textContent = report.observed.title || report.observed.videoId || '(untitled)';
  panel.appendChild(videoTitle);

  // ---- Status line (most important first) ----
  const status = document.createElement('div');
  status.className = 'bts-why-status';
  if (!report.pageStatus.enabled) {
    status.textContent = 'Filtering is paused, so nothing on this page is hidden.';
  } else if (!report.pageStatus.surfaceAllowed) {
    status.textContent = 'Filtering is OFF for this surface, so the card stays visible.';
  } else if (report.pageStatus.currentState === 'hidden') {
    status.textContent = 'This card is currently HIDDEN on the page.';
  } else if (report.pageStatus.currentState === 'warn') {
    status.textContent = 'This card is currently marked with a warning on the page.';
  } else {
    status.textContent =
      'This card is currently VISIBLE: the policy below did not hide or warn it.';
  }
  panel.appendChild(status);

  // ---- Observed (evidence as observed — never certainty) ----
  panel.appendChild(sectionTitle('Observed (from this card only)'));
  const observed = document.createElement('div');
  observed.className = 'bts-why-observed';
  observed.appendChild(row('Video ID', report.observed.videoId ?? '(not detected)'));
  observed.appendChild(row('Channel', report.observed.displayName ?? '(not detected)'));
  if (report.observed.channelId !== undefined) {
    observed.appendChild(row('Channel ID', report.observed.channelId));
  }
  if (report.observed.handle !== undefined) {
    observed.appendChild(row('Handle', `@${report.observed.handle}`));
  }
  observed.appendChild(
    row(
      'Official disclosure',
      report.observed.officialDisclosure
        ? 'Present (YouTube altered/synthetic label)'
        : 'Not present (absence is NOT evidence of human authorship)',
    ),
  );
  if (report.observed.badges.length > 0) {
    observed.appendChild(row('Badges', report.observed.badges.join(', ')));
  }
  if (report.observed.matchedPhrase !== undefined) {
    observed.appendChild(row('Matched phrase rule', `“${report.observed.matchedPhrase}”`));
  }
  panel.appendChild(observed);

  // ---- Policy decision ----
  panel.appendChild(sectionTitle('Policy decision'));
  const policy = document.createElement('div');
  policy.className = 'bts-why-policy';
  for (const line of report.decision.explanation.length > 0
    ? report.decision.explanation
    : ['No rule matched and no automatic evidence was sufficient to act.']) {
    const lineEl = document.createElement('div');
    lineEl.className = 'bts-why-line';
    lineEl.textContent = line;
    policy.appendChild(lineEl);
  }
  policy.appendChild(
    row('Decision', `${report.decision.action} (reason: ${report.decision.reason})`),
  );
  if (report.decision.ruleId !== undefined) {
    policy.appendChild(row('Rule', report.decision.ruleId));
  }
  if (report.corrections.notAi || report.corrections.notSlop) {
    policy.appendChild(
      row(
        'Your corrections',
        [report.corrections.notAi ? 'Not AI' : null, report.corrections.notSlop ? 'Not slop' : null]
          .filter(Boolean)
          .join(', '),
      ),
    );
  }
  panel.appendChild(policy);

  // ---- Deliberate actions ----
  panel.appendChild(sectionTitle('Actions'));
  const actionsEl = document.createElement('div');
  actionsEl.className = 'bts-why-actions';

  if (report.observed.videoId !== undefined) {
    actionsEl.appendChild(button('Hide this video', () => actions.onHideVideo()));
  }
  if (report.observed.channelId !== undefined || report.observed.handle !== undefined) {
    const identity =
      report.observed.channelId !== undefined
        ? `by ID ${report.observed.channelId}`
        : `by handle @${report.observed.handle}`;
    const blockBtn = button(`Block channel (${identity})`, () => actions.onBlockChannel());
    actionsEl.appendChild(blockBtn);
  }
  if (report.observed.title.length > 0) {
    const phraseWrap = document.createElement('div');
    phraseWrap.className = 'bts-why-phrase';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bts-why-phrase-input';
    input.setAttribute('data-bts-phrase-input', '');
    input.placeholder = 'Literal phrase from the title';
    input.value = report.observed.matchedPhrase ?? report.observed.title;
    const addBtn = button('Add phrase rule', () => {
      const phrase = input.value.trim();
      if (phrase.length > 0) actions.onAddPhrase(phrase);
    });
    phraseWrap.append(input, addBtn);
    actionsEl.appendChild(phraseWrap);
  }

  panel.appendChild(actionsEl);

  const footnote = document.createElement('div');
  footnote.className = 'bts-why-footnote';
  footnote.textContent =
    'Detection reads visible card text only. It cannot see inside the video, and it never claims certainty.';
  panel.appendChild(footnote);

  document.body.appendChild(panel);

  document.addEventListener('keydown', function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    document.removeEventListener('keydown', onKeyDown);
    actions.onClose();
  });
}

/** Remove the inspector if present. */
export function hideWhyInspector(): void {
  closeExisting();
}
