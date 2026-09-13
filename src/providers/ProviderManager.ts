import { ProviderError } from '../core/errors';
import { logger } from '../core/logger';
import type { Album, Artist, Playlist, Song } from '../core/types';
import type { MusicProvider } from './types';
import { ProviderHealthManager } from './health';

interface Registered {
  provider: MusicProvider;
  enabled: boolean;
}

/**
 * ProviderManager fans search out to all enabled providers with per-provider
 * timeout + graceful fallback. Never throws for aggregate search — returns
 * partial results and records which providers failed.
 */
export class ProviderManager {
  private registry = new Map<string, Registered>();
  readonly requestTimeoutMs: number;
  private readonly health: ProviderHealthManager;

  constructor(requestTimeoutMs = 15000, health?: ProviderHealthManager) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.health = health ?? new ProviderHealthManager();
  }

  /** Eligibility/health view (availability, latency, last errors). */
  healthManager(): ProviderHealthManager {
    return this.health;
  }

  register(provider: MusicProvider, enabled = true) {
    this.registry.set(provider.id, { provider, enabled });
  }

  setEnabled(id: string, enabled: boolean) {
    const r = this.registry.get(id);
    if (r) r.enabled = enabled;
  }

  list(): { id: string; name: string; enabled: boolean; capabilities: MusicProvider['capabilities'] }[] {
    return [...this.registry.values()].map((r) => ({
      id: r.provider.id,
      name: r.provider.name,
      enabled: r.enabled,
      capabilities: r.provider.capabilities,
    }));
  }

  enabledProviders(): MusicProvider[] {
    return [...this.registry.values()].filter((r) => r.enabled).map((r) => r.provider);
  }

  get(id: string): MusicProvider | undefined {
    return this.registry.get(id)?.provider;
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('TIMEOUT', `Provider timed out: ${label}`)), this.requestTimeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  async searchAll(
    query: string,
    kind: 'songs' | 'artists' | 'albums' | 'playlists',
    signal?: AbortSignal,
  ): Promise<{ items: (Song | Artist | Album | Playlist)[]; failures: string[] }> {
    const q = query.trim();
    if (!q) return { items: [], failures: [] };
    const failures: string[] = [];
    const eligible = this.enabledProviders().filter((p) => p.capabilities.supportsSearch);
    // Providers currently marked down stay listed as failures (partial-result
    // notice) without being hammered — they recover automatically via
    // cooldown, and any success resets them immediately.
    const attempted: MusicProvider[] = [];
    const pending: Promise<unknown>[] = [];
    for (const p of eligible) {
      if (!this.health.isAvailable(p.id)) {
        failures.push(p.id);
        logger.warn('providers', `SEARCH skipped (unhealthy): ${p.id}:${kind}`);
        continue;
      }
      attempted.push(p);
      // Search diagnostics (§4): per-provider START / SUCCESS / FAILURE with
      // elapsed time and normalized error category. No queries-as-secrets
      // concern (query text is user input, never credentials), but payloads
      // and URLs are never logged.
      const started = Date.now();
      logger.debug('providers', `SEARCH START ${p.id}:${kind}`);
      const call =
        kind === 'songs' ? p.searchSongs(q, signal)
        : kind === 'artists' ? (p.capabilities.supportsArtists ? p.searchArtists(q, signal) : Promise.resolve([]))
        : kind === 'albums' ? (p.capabilities.supportsAlbums ? p.searchAlbums(q, signal) : Promise.resolve([]))
        : p.searchPlaylists(q, signal);
      pending.push(
        this.withTimeout(call as Promise<unknown[]>, `${p.id}:${kind}`).then(
          (items) => {
            const n = Array.isArray(items) ? items.length : 0;
            logger.info('providers', `SEARCH SUCCESS ${p.id}:${kind} (${n} items, ${Date.now() - started}ms)`);
            this.health.recordSuccess(p.id, 0);
            return items;
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            const code = err instanceof ProviderError ? err.code : ((err as Error)?.name === 'AbortError' ? 'ABORTED' : 'NETWORK');
            logger.warn('providers', `SEARCH FAILURE ${p.id}:${kind} (${code}, ${Date.now() - started}ms)`, msg.slice(0, 200));
            const rateLimited = err instanceof ProviderError && err.code === 'RATE_LIMIT';
            this.health.recordFailure(p.id, msg, rateLimited ? { rateLimited: true } : undefined);
            throw err;
          },
        ),
      );
    }
    const settled = await Promise.allSettled(pending);
    const items: (Song | Artist | Album | Playlist)[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') items.push(...(r.value as unknown[] as typeof items));
      else {
        failures.push(attempted[i]?.id ?? 'unknown');
        logger.warn('providers', `search failed (${attempted[i]?.id})`, String(r.reason));
      }
    });
    return { items, failures };
  }
}

let singleton: ProviderManager | null = null;
export function getProviderManager(): ProviderManager {
  if (!singleton) singleton = new ProviderManager(15000);
  return singleton;
}
