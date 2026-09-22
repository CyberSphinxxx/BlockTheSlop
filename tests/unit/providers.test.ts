import { afterEach, describe, expect, it, vi } from 'vitest';
import { disabledProvider } from '@/providers/reputation-provider';
import { HttpReputationProvider } from '@/providers/http-provider';

describe('disabledProvider (default)', () => {
  it('always returns unknown and never blocks', async () => {
    expect(await disabledProvider.getVideoReputation('abc')).toBeNull();
    expect(await disabledProvider.getChannelReputation('UC1')).toBeNull();
  });
});

describe('HttpReputationProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function provider(overrides: Record<string, unknown> = {}): HttpReputationProvider {
    return new HttpReputationProvider({
      endpoint: 'https://reputation.example',
      timeoutMs: 200,
      ...overrides,
    });
  }

  it('parses a valid video reputation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              reputation: { aiLikelihood: 0.9, slopLikelihood: 0.2, sampleSize: 12 },
            }),
            {
              status: 200,
            },
          ),
      ),
    );
    const result = await provider().getVideoReputation('v1');
    expect(result?.aiLikelihood).toBe(0.9);
    expect(result?.sampleSize).toBe(12);
  });

  it('treats malformed responses as unknown, not block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>garbage</html>', { status: 200 })),
    );
    const result = await provider().getVideoReputation('v1');
    expect(result).toBeNull();
  });

  it('treats HTTP 500 as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const result = await provider().getVideoReputation('v1');
    expect(result).toBeNull();
  });

  it('times out long responses to unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const result = await provider({ timeoutMs: 50 }).getVideoReputation('v1');
    expect(result).toBeNull();
  });

  it('caches responses with TTL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ reputation: { aiLikelihood: 0.5, slopLikelihood: 0.5, sampleSize: 3 } }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const p = provider();
    await p.getVideoReputation('v1');
    await p.getVideoReputation('v1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit after repeated failures and stops calling the network', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = provider({ failureThreshold: 2 });
    await p.getVideoReputation('a');
    await p.getVideoReputation('b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Circuit is now open: no further network calls.
    await p.getVideoReputation('c');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await p.healthCheck()).toBe('down');
  });

  it('never sends cookies or credentials', async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response(
          JSON.stringify({ reputation: { aiLikelihood: 0, slopLikelihood: 0, sampleSize: 0 } }),
          {
            status: 200,
          },
        );
      }),
    );
    await provider().getVideoReputation('v1');
    expect(capturedInit?.credentials).toBe('omit');
  });

  it('clamps out-of-range likelihood values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ reputation: { aiLikelihood: 42, slopLikelihood: -7, sampleSize: 1 } }),
            {
              status: 200,
            },
          ),
      ),
    );
    const result = await provider().getVideoReputation('v1');
    expect(result?.aiLikelihood).toBe(1);
    expect(result?.slopLikelihood).toBe(0);
  });
});
