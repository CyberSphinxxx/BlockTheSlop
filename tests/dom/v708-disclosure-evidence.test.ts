import { describe, expect, it } from 'vitest';
import { extractOfficialDisclosure } from '@/youtube/parse/common';
import { parseShortsShelfCard } from '@/youtube/parse/shorts';
import { parseCardElement } from '@/youtube/parse/card';
import { classifyCandidate } from '@/detection/engine';
import type { DetectionContext } from '@/domain/evidence';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';

/**
 * V7-08: stronger locally available YouTube evidence — DOM-scoped, no new
 * permissions, no network. YouTube renders the official altered/synthetic
 * disclosure in the viewer's UI language; the parser must recognize the
 * documented variants across locales (case/diacritics-insensitive), fall back
 * to the lockup's aria-label, and reach Shorts shelf cards. Disclosure text
 * is rendered via textContent everywhere (XSS contract).
 */

describe('V7-08: official disclosure extraction (DOM source, bounded)', () => {
  it('recognizes localized disclosure labels (es/fr/de/ja)', () => {
    const cases: Array<[string, string]> = [
      ['es', 'Contenido alterado o sintético'],
      ['fr', 'Contenu modifié ou synthétique'],
      ['de', 'Verändertes oder synthetisches Material'],
      ['ja', '変更または合成コンテンツ'],
    ];
    for (const [, label] of cases) {
      const root = document.createElement('div');
      root.innerHTML = `<div class="badges"><span class="badge">${label}</span></div>`;
      const result = extractOfficialDisclosure(root, ['.badges .badge']);
      expect(result, `locale label: ${label}`).toBeDefined();
      expect(result?.present).toBe(true);
    }
  });

  it('still matches the English labels (no regression)', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="badges"><span class="badge">Altered or synthetic content</span></div>';
    const result = extractOfficialDisclosure(root, ['.badges .badge']);
    expect(result?.present).toBe(true);
  });

  it('falls back to the lockup aria-label when no badge element exists', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<a href="/watch?v=abc12345" aria-label="Rome retold — Contenido alterado o sintético by Past Reimagined"></a>';
    const result = extractOfficialDisclosure(root, ['.does-not-exist']);
    expect(result?.present).toBe(true);
    expect(result?.text).toContain('Contenido alterado o sintético');
  });

  it('does not treat unrelated badges or ordinary text as disclosure', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="badges"><span class="badge">4K</span></div><span>Synthwave mix 1984</span>';
    expect(extractOfficialDisclosure(root, ['.badges .badge'])).toBeUndefined();
  });

  it('shorts shelf cards carry official disclosure evidence (badge and aria paths)', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <ytm-shorts-lockup-view-model>
        <a href="/shorts/shelfvid09" aria-label="Short by Quick Bites"></a>
        <span class="title">Short</span>
        <span class="badge-shape-wiz__text">Contenido alterado o sintético</span>
      </ytm-shorts-lockup-view-model>`;
    const card = root.querySelector('ytm-shorts-lockup-view-model')!;
    const candidate = parseShortsShelfCard(card, 'shorts-shelf', 1_700_000_000_000);
    expect(candidate.officialDisclosure?.present).toBe(true);
  });

  it('long-form lockup keeps disclosure through aria-label fallback', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <yt-lockup-view-model>
        <a id="video-title-link" href="/watch?v=aria1111" aria-label="Rome retold (Altered or synthetic content)"></a>
      </yt-lockup-view-model>`;
    const card = root.querySelector('yt-lockup-view-model')!;
    const candidate = parseCardElement(card, 'home', 1_700_000_000_000);
    expect(candidate.officialDisclosure?.present).toBe(true);
  });
});

describe('V7-08: disclosure evidence reaches the classifier (DOM fallback intact)', () => {
  it('localized disclosure contributes to the AI dimension like the English label', async () => {
    const candidate: NormalizedVideoCandidate = {
      videoId: 'loc00000000000000',
      title: 'Rome retold',
      channel: { channelId: 'UCX00000000000000000' },
      surface: 'home' as Surface,
      cardKind: 'video',
      badges: ['Contenido alterado o sintético'],
      ariaLabels: [],
      metadataText: [],
      officialDisclosure: { present: true, text: 'Contenido alterado o sintético' },
      isShort: false,
      observedAt: 1_700_000_000_000,
    };
    const context: DetectionContext = { locale: 'es', enabledRulePacks: { fil: true } };
    const classification = await classifyCandidate(candidate, context);
    expect(classification.aiLikelihood).toBeGreaterThan(0.4);
  });
});
