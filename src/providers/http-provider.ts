import type { CommunityFeedback } from '@/domain/feedback';
import { logger } from '@/shared/logger';
import type {
  ChannelReputation,
  ProviderHealth,
  ReputationProvider,
  VideoReputation,
} from './reputation-provider';

/**
 * HTTPS reputation provider.
 *
 * Security requirements (SECURITY_PRIVACY.md §3):
 * - HTTPS only; requests carry the minimum identifiers and never cookies or
 *   credentials (`credentials: 'omit'`).
 * - Hard timeout via AbortController.
 * - Strict response schema validation — malformed data is treated as unknown.
 * - Failure returns null (unknown), never a block decision.
 * - Responses are data only; nothing is ever executed.
 */
export interface HttpProviderOptions {
  endpoint: string;
  timeoutMs: number;
  /** Cache TTL in ms (default 24h). */
  cacheTtlMs?: number;
  /** Consecutive failures before the circuit opens (default 3). */
  failureThreshold?: number;
  /** Circuit open duration in ms (default 60s). */
  circuitResetMs?: number;
}

const MAX_LIKELIHOOD = 1;
const MAX_SAMPLE = 1_000_000;

function clampUnit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_LIKELIHOOD, Math.max(0, value));
}

function parseVideoReputation(raw: unknown): VideoReputation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const ai = clampUnit(record['aiLikelihood']);
  const slop = clampUnit(record['slopLikelihood']);
  if (ai === null || slop === null) return null;
  const sampleSize =
    typeof record['sampleSize'] === 'number' && Number.isFinite(record['sampleSize'])
      ? Math.min(MAX_SAMPLE, Math.max(0, Math.floor(record['sampleSize'])))
      : 0;
  return { aiLikelihood: ai, slopLikelihood: slop, sampleSize };
}

function parseChannelReputation(raw: unknown): ChannelReputation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const prior = clampUnit(record['aiPrior']);
  if (prior === null) return null;
  const sampleSize =
    typeof record['sampleSize'] === 'number' && Number.isFinite(record['sampleSize'])
      ? Math.min(MAX_SAMPLE, Math.max(0, Math.floor(record['sampleSize'])))
      : 0;
  return { aiPrior: prior, sampleSize };
}

interface CacheEntry<T> {
  value: T | null;
  cachedAt: number;
}

export class HttpReputationProvider implements ReputationProvider {
  private readonly videoCache = new Map<string, CacheEntry<VideoReputation>>();
  private readonly channelCache = new Map<string, CacheEntry<ChannelReputation>>();
  private failures = 0;
  private circuitOpenUntil = 0;
  private readonly cacheTtlMs: number;
  private readonly failureThreshold: number;
  private readonly circuitResetMs: number;

  constructor(private readonly options: HttpProviderOptions) {
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.circuitResetMs = options.circuitResetMs ?? 60_000;
  }

  private circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.circuitOpenUntil = Date.now() + this.circuitResetMs;
      this.failures = 0;
      logger.warn('reputation provider circuit opened');
    }
  }

  private async fetchJson(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.options.endpoint}${path}`, {
      signal,
      credentials: 'omit',
      mode: 'cors',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    return response.json();
  }

  private async withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    if (this.circuitOpen()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const result = await work(controller.signal);
      this.failures = 0;
      return result;
    } catch {
      this.recordFailure();
      return null; // unknown — never block on provider failure
    } finally {
      clearTimeout(timer);
    }
  }

  async getVideoReputation(videoId: string): Promise<VideoReputation | null> {
    const cached = this.videoCache.get(videoId);
    if (cached !== undefined && Date.now() - cached.cachedAt <= this.cacheTtlMs) {
      return cached.value;
    }
    const value = await this.withTimeout(async (signal) => {
      const raw = await this.fetchJson(`/video/${encodeURIComponent(videoId)}`, signal);
      return parseVideoReputation((raw as Record<string, unknown>)?.['reputation'] ?? raw);
    });
    this.videoCache.set(videoId, { value, cachedAt: Date.now() });
    return value;
  }

  async getChannelReputation(channelId: string): Promise<ChannelReputation | null> {
    const cached = this.channelCache.get(channelId);
    if (cached !== undefined && Date.now() - cached.cachedAt <= this.cacheTtlMs) {
      return cached.value;
    }
    const value = await this.withTimeout(async (signal) => {
      const raw = await this.fetchJson(`/channel/${encodeURIComponent(channelId)}`, signal);
      return parseChannelReputation((raw as Record<string, unknown>)?.['reputation'] ?? raw);
    });
    this.channelCache.set(channelId, { value, cachedAt: Date.now() });
    return value;
  }

  async submitFeedback(feedback: CommunityFeedback): Promise<void> {
    await this.withTimeout(async (signal) => {
      await fetch(`${this.options.endpoint}/feedback`, {
        method: 'POST',
        signal,
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedback),
      });
      return true;
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (this.circuitOpen()) return 'down';
    if (this.failures > 0) return 'degraded';
    const result = await this.withTimeout(async (signal) => {
      await this.fetchJson('/health', signal);
      return true;
    });
    return result === null ? 'down' : 'healthy';
  }
}
