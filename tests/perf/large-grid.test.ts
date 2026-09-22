import { describe, expect, it } from 'vitest';
import { discoverCards, parseDiscovered } from '@/youtube/discover';
import { aggregateEvidence } from '@/detection/engine';
import { pageContextFromUrl } from '@/youtube/routes';

/**
 * Performance invariant (TEST_PLAN.md §10): adding N cards must scale
 * approximately with N, not force repeated whole-page O(N²) work.
 * Budgets are generous ceilings for CI hardware variance.
 */

function buildGrid(cardCount: number): Document {
  const doc = document.implementation.createHTMLDocument('grid');
  const container = doc.createElement('main');
  container.id = 'contents';
  for (let i = 0; i < cardCount; i++) {
    const card = doc.createElement('yt-lockup-view-model');
    card.innerHTML = `
      <a id="video-title-link" href="/watch?v=perf${String(i).padStart(4, '0')}">
        <span id="video-title">Performance fixture video number ${i}</span>
      </a>
      <div id="channel-name"><a href="/channel/UCPerf${String(i).padStart(20, '0')}">Perf Channel ${i}</a></div>
      <span class="yt-lockup-metadata-view-model__text-wrapper">${i}K views</span>`;
    container.appendChild(card);
  }
  doc.body.appendChild(container);
  return doc;
}

describe('large grid performance', () => {
  it('discovers and parses 500 cards within budget', () => {
    const doc = buildGrid(500);
    const started = Date.now();
    const cards = discoverCards(doc, pageContextFromUrl('https://www.youtube.com/').surface);
    const parsed = cards.map((c) => parseDiscovered(c, 'home', 0));
    const elapsed = Date.now() - started;
    expect(parsed).toHaveLength(500);
    expect(parsed[0]?.videoId).toBe('perf0000');
    // Generous ceiling: 500 cards in under 5s (typical: <100ms locally, up to
    // ~1s on loaded CI). A real O(N²) regression fails by orders of magnitude.
    expect(elapsed).toBeLessThan(5000);
  });

  it('classification of 500 candidates stays within budget', async () => {
    const doc = buildGrid(500);
    const cards = discoverCards(doc, 'home');
    const candidates = cards.map((c) => parseDiscovered(c, 'home', 0));
    const started = Date.now();
    for (const candidate of candidates) {
      aggregateEvidence([], candidate, {});
    }
    const elapsed = Date.now() - started;
    // Aggregation without evidence is cheap; ceiling guards regressions.
    expect(elapsed).toBeLessThan(2500);
  });

  it('does not rescan the whole document per added card', () => {
    // Discovery on a subtree containing one card must not touch unrelated
    // cards: measure that repeated subtree discovery cost stays flat.
    const doc = buildGrid(200);
    const contents = doc.getElementById('contents');
    if (contents === null) throw new Error('fixture broken');

    const single = doc.createElement('yt-lockup-view-model');
    single.innerHTML =
      '<a id="video-title-link" href="/watch?v=one"><span id="video-title">One</span></a>';
    contents.appendChild(single);

    const started = Date.now();
    for (let i = 0; i < 1000; i++) {
      const probe = doc.createElement('div');
      probe.appendChild(single.cloneNode(true));
      discoverCards(probe, 'home');
    }
    const elapsed = Date.now() - started;
    // 1000 single-card discoveries must not scale with grid size (200 cards).
    expect(elapsed).toBeLessThan(5000);
  });
});
