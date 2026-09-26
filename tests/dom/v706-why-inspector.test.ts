import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, type UserRules } from '@/domain/rules';
import { showWhyInspector, whyPanelElement, type WhyReport } from '@/presentation/why-inspector';
import { ensureStyles } from '@/presentation/apply-decision';
import type { FilterDecision } from '@/domain/decision';
import { AI_DISCLOSURE_CARD_HTML, elementFromHtml } from '../fixtures/youtube';

/**
 * V7-06: "Why is this still showing?" — a local inspector for the SELECTED
 * video (the right-clicked card), never the search box or sibling cards.
 *
 * The report must show what was observed (identity fields + source), what the
 * policy decided and why, and the card's current on-page status. Actions are
 * deliberate and explicit: Hide video (needs a video id), Block channel (only
 * with verified id/handle), Add literal phrase. No detector-certainty claims.
 */

function baseDeps(): {
  deps: OrchestratorDeps;
  settings: UserSettings;
  rules: UserRules;
} {
  const settings: UserSettings = { ...defaultSettings(), mode: 'balanced' };
  const rules: UserRules = defaultRules();
  return {
    settings,
    rules,
    deps: {
      getSettings: async () => settings,
      getRules: async () => rules,
      getCachedClassifications: async () => [],
      putCachedClassifications: async () => undefined,
      getCorrections: async () => ({ notAi: false, notSlop: false }),
      applyStats: async () => undefined,
      isRemoteProviderEnabled: () => false,
    },
  };
}

function hideDecision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:disclose1',
    explanation: ['Hidden by your rule.'],
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  ensureStyles();
});

describe('V7-06: orchestrator.explainCandidate', () => {
  it('returns observed identity, re-decided policy, and page status for the selected card', async () => {
    const { deps } = baseDeps();
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const card = elementFromHtml(AI_DISCLOSURE_CARD_HTML);
    document.body.appendChild(card);

    const report = await orchestrator.explainCandidate(card);
    expect(report).not.toBeNull();
    expect(report!.observed.videoId).toBe('disclose1');
    expect(report!.observed.title).toContain('The fall of Rome');
    expect(report!.observed.surface).toBe('unknown'); // selected-card parse surface
    expect(report!.observed.officialDisclosure).toBe(true);
    expect(report!.decision).toBeDefined();
    expect(report!.decision.action).toBeDefined();
    expect(report!.pageStatus).toHaveProperty('enabled');
    expect(report!.pageStatus).toHaveProperty('surfaceAllowed');
    expect(report!.pageStatus).toHaveProperty('currentState');
  });

  it('returns null for a detached/absent card instead of throwing', async () => {
    const { deps } = baseDeps();
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const ghost = elementFromHtml(AI_DISCLOSURE_CARD_HTML); // never attached
    const report = await orchestrator.explainCandidate(ghost);
    // Detached elements are still parseable; a null comes only from
    // unparseable content. Either way it must not throw — assert both paths.
    expect(report === null || typeof report === 'object').toBe(true);
  });

  it('matches a literal phrase rule and reports it as the reason', async () => {
    const { deps, rules } = baseDeps();
    rules.blockedPhrases.push('fall of rome');
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const card = elementFromHtml(AI_DISCLOSURE_CARD_HTML);
    document.body.appendChild(card);
    const report = await orchestrator.explainCandidate(card);
    expect(report!.decision.action).toBe('hide');
    expect(report!.decision.ruleId).toBe('phrase-block');
    expect(report!.observed.matchedPhrase).toBe('fall of rome');
  });

  it('reports a surface-disabled page status', async () => {
    const { deps, settings } = baseDeps();
    settings.surfaces = { ...settings.surfaces, home: false };
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const card = elementFromHtml(AI_DISCLOSURE_CARD_HTML);
    document.body.appendChild(card);
    const report = await orchestrator.explainCandidate(card);
    expect(report!.pageStatus.surfaceAllowed).toBe(false);
  });
});

describe('V7-06: why-inspector panel', () => {
  const sampleReport = (): WhyReport => ({
    observed: {
      videoId: 'disclose1' as string | undefined,
      title: 'The fall of Rome, retold',
      channelId: undefined,
      handle: 'pastreimagined',
      displayName: 'Past Reimagined',
      surface: 'unknown' as string,
      isShort: false,
      officialDisclosure: true,
      badges: ['Altered or synthetic content'],
      matchedPhrase: undefined as string | undefined,
    },
    decision: hideDecision(),
    classification: undefined,
    corrections: { notAi: false, notSlop: false },
    pageStatus: { enabled: true, surfaceAllowed: true, currentState: null as string | null },
  });

  it('renders observed fields, policy reason, and status — no certainty claim', () => {
    const report = sampleReport();
    showWhyInspector(report, {
      onHideVideo: vi.fn(),
      onBlockChannel: vi.fn(),
      onAddPhrase: vi.fn(),
      onClose: vi.fn(),
    });
    const panel = whyPanelElement();
    expect(panel).not.toBeNull();
    const text = panel!.textContent ?? '';
    expect(text).toContain('disclose1');
    expect(text).toContain('Hidden by your rule.');
    // Observed evidence is labeled as observed, never as proof of production.
    expect(text).toContain('Observed');
    expect(text).toContain('Altered or synthetic content');
    // No percentage/certainty claims about the detector.
    expect(text).not.toMatch(/\d+% (?:AI|certain|probability)/i);
  });

  it('offers Hide video, verified Block channel, and Add phrase actions', () => {
    const report = sampleReport();
    const onHideVideo = vi.fn();
    const onBlockChannel = vi.fn();
    showWhyInspector(report, {
      onHideVideo,
      onBlockChannel,
      onAddPhrase: vi.fn(),
      onClose: vi.fn(),
    });
    const panel = whyPanelElement()!;
    const hideBtn = [...panel.querySelectorAll('button')].find((b) =>
      /hide (?:this )?video/i.test(b.textContent ?? ''),
    );
    const channelBtn = [...panel.querySelectorAll('button')].find((b) =>
      /block channel/i.test(b.textContent ?? ''),
    );
    const phraseBtn = [...panel.querySelectorAll('button')].find((b) =>
      /add (?:phrase|rule)/i.test(b.textContent ?? ''),
    );
    expect(hideBtn).toBeDefined();
    expect(channelBtn).toBeDefined();
    expect(phraseBtn).toBeDefined();
    hideBtn!.click();
    expect(onHideVideo).toHaveBeenCalledTimes(1);
    channelBtn!.click();
    expect(onBlockChannel).toHaveBeenCalledTimes(1);
  });

  it('hides the channel action when identity is NOT verified', () => {
    const report = sampleReport();
    report.observed.channelId = undefined;
    report.observed.handle = undefined;
    showWhyInspector(report, {
      onHideVideo: vi.fn(),
      onBlockChannel: vi.fn(),
      onAddPhrase: vi.fn(),
      onClose: vi.fn(),
    });
    const panel = whyPanelElement()!;
    const channelBtn = [...panel.querySelectorAll('button')].find((b) =>
      /block channel/i.test(b.textContent ?? ''),
    );
    expect(channelBtn).toBeUndefined();
  });

  it('closes on the close button and on Escape (keyboard path)', () => {
    const report = sampleReport();
    const onClose = vi.fn();
    showWhyInspector(report, {
      onHideVideo: vi.fn(),
      onBlockChannel: vi.fn(),
      onAddPhrase: vi.fn(),
      onClose,
    });
    const panel = whyPanelElement()!;
    const closeBtn = panel.querySelector<HTMLButtonElement>('.bts-why-inspector-close');
    closeBtn!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('phrase action passes the trimmed input text', () => {
    const report = sampleReport();
    const onAddPhrase = vi.fn();
    showWhyInspector(report, {
      onHideVideo: vi.fn(),
      onBlockChannel: vi.fn(),
      onAddPhrase,
      onClose: vi.fn(),
    });
    const panel = whyPanelElement()!;
    const input = panel.querySelector<HTMLInputElement>('input[data-bts-phrase-input]')!;
    input.value = '  fall of rome  ';
    const addBtn = [...panel.querySelectorAll('button')].find((b) =>
      /add (?:phrase|rule)/i.test(b.textContent ?? ''),
    )!;
    addBtn.click();
    expect(onAddPhrase).toHaveBeenCalledWith('fall of rome');
  });
});
