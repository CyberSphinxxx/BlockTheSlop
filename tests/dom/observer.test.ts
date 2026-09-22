import { describe, expect, it, vi } from 'vitest';
import { BatchingObserver } from '@/youtube/observer';
import { shouldProcess } from '@/youtube/identity';
import { discoverCards } from '@/youtube/discover';
import {
  elementFromHtml,
  RECYCLED_NODE_AFTER_HTML,
  RECYCLED_NODE_BEFORE_HTML,
} from '../fixtures/youtube';

describe('BatchingObserver', () => {
  it('batches multiple inserted nodes into one callback', async () => {
    const onBatch = vi.fn((roots: Element[]) => {
      void roots;
    });
    const observer = new BatchingObserver(
      onBatch,
      () => {},
      () => {},
    );
    observer.start();

    const container = document.body;
    for (let i = 0; i < 10; i++) {
      const div = document.createElement('div');
      div.textContent = `card ${i}`;
      container.appendChild(div);
    }

    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(onBatch).toHaveBeenCalledTimes(1);
    const roots = onBatch.mock.calls[0]?.[0] as Element[];
    expect(roots.length).toBe(10);
    observer.stop();
  });

  it('ignores text node insertions', async () => {
    const onBatch = vi.fn();
    const observer = new BatchingObserver(
      onBatch,
      () => {},
      () => {},
    );
    observer.start();
    document.body.appendChild(document.createTextNode('just text'));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(onBatch).not.toHaveBeenCalled();
    observer.stop();
  });

  it('does not rescan the whole document for every mutation', async () => {
    const onBatch = vi.fn();
    const observer = new BatchingObserver(
      onBatch,
      () => {},
      () => {},
    );
    observer.start();

    // Insert 100 elements rapidly; must produce one batch containing 100 roots,
    // not 100 separate full scans.
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 100; i++) {
      const div = document.createElement('div');
      div.className = `card-${i}`;
      fragment.appendChild(div);
    }
    document.body.appendChild(fragment);

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect((onBatch.mock.calls[0]?.[0] as Element[]).length).toBe(100);
    observer.stop();
  });

  it('survives a handler that throws', async () => {
    const onBatch = vi.fn((_roots: Element[]) => {
      throw new Error('boom');
    });
    const observer = new BatchingObserver(
      onBatch,
      () => {},
      () => {},
    );
    observer.start();
    document.body.appendChild(document.createElement('div'));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(onBatch).toHaveBeenCalled();
    // Observer still functional after the error:
    onBatch.mockImplementation((_roots: Element[]) => undefined as unknown as never);
    document.body.appendChild(document.createElement('div'));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    observer.stop();
  });
});

describe('recycled identity', () => {
  it('reprocesses a node when its identity changes', () => {
    const el = elementFromHtml(RECYCLED_NODE_BEFORE_HTML);
    expect(shouldProcess(el, 'signature-before')).toBe(true);
    expect(shouldProcess(el, 'signature-before')).toBe(false);
    expect(shouldProcess(el, 'signature-after')).toBe(true);
  });

  it('discovers cards in inserted subtrees', () => {
    const root = elementFromHtml(
      `<div>${RECYCLED_NODE_BEFORE_HTML}${RECYCLED_NODE_AFTER_HTML}</div>`,
    );
    const cards = discoverCards(root, 'home');
    expect(cards).toHaveLength(2);
  });
});
