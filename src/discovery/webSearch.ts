// Live Web Discovery — provider-neutral web search abstraction.
//
// searchWeb(query) returns only safely-obtainable public/indexed page info.
// Strict timeout, abort, rate limiting, result limits, short-lived cache.
// No arbitrary server-side requests: every candidate URL passes the SSRF
// guard before it is returned.

import { logger } from '../core/logger';
import { scrubDiscoveryUrl, validateDiscoveryUrl } from './ssrfGuard';
import type { WebDiscoveryResult } from './types';

export interface WebSearchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly displayName: string;
  search(query: string, opts: WebSearchOptions): Promise<WebDiscoveryResult[]>;
}

/**
 * Pluggable web-search backend (§12). Minimal contract: query in,
 * public-page hits out. No scraping of search-engine HTML, no CAPTCHA /
 * auth / rate-limit bypass — a backend that cannot serve honestly must
 * throw (recorded as a failure) or return [].
 *
 * Environment: VITE_WEB_DISCOVERY_URL (alias VITE_WEB_SEARCH_URL),
 * GET {base}?q=... → { results: [{url,title,snippet,domain}...] }.
 * With no backend configured, discovery reports honest unavailable —
 * catalog APIs are never relabeled as broad web search.
 */
export interface WebSearchAdapter {
  readonly id: string;
  readonly displayName: string;
  search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/** Result shape for pluggable adapters (§12). */
export interface WebSearchResult {
  url: string;
  title?: string;
  snippet?: string;
  domain?: string;
}

const registry = new Map<string, WebSearchProvider>();

export function registerWebSearchProvider(p: WebSearchProvider): void {
  registry.set(p.id, p);
}

/** Register a minimal §12 adapter (wrapped onto the shared execution path). */
export function registerWebSearchAdapter(a: WebSearchAdapter): void {
  registry.set(a.id, {
    id: a.id,
    displayName: a.displayName,
    search: async (query, opts) => {
      const hits = await a.search(query, opts.signal);
      return (Array.isArray(hits) ? hits : []).map((h) => ({
        url: h.url,
        title: h.title,
        artist: undefined,
        album: undefined,
        durationMs: undefined,
        artwork: undefined,
        site: h.domain,
        provider: a.id,
        providerId: undefined,
        sourceType: 'web' as const,
        discoveredAt: Date.now(),
        origin: 'web' as const,
      }));
    },
  });
}

export function listWebSearchProviders(): WebSearchProvider[] {
  return [...registry.values()];
}

export function clearWebSearchProviders(): void {
  registry.clear();
}

// --- rate limiting (token bucket per provider, in-memory) ---

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_PER_WINDOW = 6;
const rateMarks = new Map<string, number[]>();

function rateLimited(id: string): boolean {
  const now = Date.now();
  const marks = (rateMarks.get(id) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  rateMarks.set(id, marks);
  return marks.length >= RATE_MAX_PER_WINDOW;
}

function markRequest(id: string): void {
  const marks = rateMarks.get(id) ?? [];
  marks.push(Date.now());
  rateMarks.set(id, marks);
}

export function __resetWebSearchRateLimitsForTests(): void {
  rateMarks.clear();
}

// --- short-lived search cache (2 min, bounded) ---

interface SearchCacheEntry {
  at: number;
  results: WebDiscoveryResult[];
}

const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const searchCache = new Map<string, SearchCacheEntry>();

function cacheKey(providerId: string, query: string): string {
  return `${providerId}:${query.trim().toLowerCase().slice(0, 200)}`;
}

export function __clearWebSearchCacheForTests(): void {
  searchCache.clear();
}

function readSearchCache(providerId: string, query: string): WebDiscoveryResult[] | null {
  const e = searchCache.get(cacheKey(providerId, query));
  if (!e) return null;
  if (Date.now() - e.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey(providerId, query));
    return null;
  }
  return e.results;
}

function writeSearchCache(providerId: string, query: string, results: WebDiscoveryResult[]): void {
  if (searchCache.size > 100) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) searchCache.delete(oldest);
  }
  searchCache.set(cacheKey(providerId, query), { at: Date.now(), results });
}

// --- sanitization ---

const MAX_RESULTS_TOTAL = 12;

function sanitizeResult(r: WebDiscoveryResult): WebDiscoveryResult | null {
  if (!r || typeof r.url !== 'string') return null;
  const verdict = validateDiscoveryUrl(r.url);
  if (!verdict.ok) {
    logger.debug('discovery', `search result rejected (${verdict.reason})`, scrubDiscoveryUrl(r.url));
    return null;
  }
  return {
    url: verdict.url!,
    title: typeof r.title === 'string' ? r.title.slice(0, 300) : undefined,
    artist: typeof r.artist === 'string' ? r.artist.slice(0, 300) : undefined,
    album: typeof r.album === 'string' ? r.album.slice(0, 300) : undefined,
    durationMs:
      typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs > 0
        ? Math.round(r.durationMs)
        : undefined,
    artwork: typeof r.artwork === 'string' ? r.artwork.slice(0, 2048) : undefined,
    site: typeof r.site === 'string' ? r.site.slice(0, 120) : undefined,
    provider: typeof r.provider === 'string' ? r.provider.slice(0, 120) : undefined,
    providerId: typeof r.providerId === 'string' ? r.providerId.slice(0, 120) : undefined,
    sourceType: 'web',
    origin: r.origin === 'web' ? 'web' : 'catalog',
    discoveredAt: typeof r.discoveredAt === 'number' ? r.discoveredAt : Date.now(),
  };
}

/**
 * Fan out a query across registered web-search providers with full
 * isolation. Never throws — returns sanitized results + failure ids.
 * Each provider gets its own timeout; the overall call is bounded by
 * `timeoutMs` (default 6s) so web discovery never blocks provider search.
 */
export async function searchWeb(
  query: string,
  opts: WebSearchOptions = {},
): Promise<{ results: WebDiscoveryResult[]; failures: string[] }> {
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return { results: [], failures: [] };
  const providers = listWebSearchProviders();
  if (providers.length === 0) return { results: [], failures: [] };
  const limit = Math.min(opts.limit ?? MAX_RESULTS_TOTAL, MAX_RESULTS_TOTAL);
  const timeoutMs = opts.timeoutMs ?? 6000;

  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      // Caller-aborted (stale search): silent empty, never a failure.
      if (opts.signal?.aborted) return [] as WebDiscoveryResult[];
      const cached = readSearchCache(p.id, q);
      if (cached) return cached;
      if (rateLimited(p.id)) {
        logger.warn('discovery', `web search rate-limited (${p.id})`);
        throw new Error('rate-limited');
      }
      markRequest(p.id);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      // Honest timeouts: OUR budget firing (caller still alive) is a
      // provider failure, not an empty success — adapters swallow aborts
      // into [], which previously hid slow backends as "no results".
      let gateTimer: ReturnType<typeof setTimeout> | undefined;
      const gate = new Promise<never>((_, reject) => {
        gateTimer = setTimeout(() => reject(new Error(`web-search-timeout (${p.id})`)), timeoutMs);
      });
      try {
        const raw = await Promise.race([
          p.search(q, { ...opts, signal: controller.signal, timeoutMs, limit }),
          gate,
        ]);
        const clean = (Array.isArray(raw) ? raw : [])
          .map(sanitizeResult)
          .filter((r): r is WebDiscoveryResult => r !== null)
          .slice(0, limit);
        writeSearchCache(p.id, q, clean);
        return clean;
      } catch (e) {
        // Caller moved on (stale search): stay silent.
        if (opts.signal?.aborted) return [] as WebDiscoveryResult[];
        throw e;
      } finally {
        if (gateTimer) clearTimeout(gateTimer);
        controller.abort();
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }),
  );

  const results: WebDiscoveryResult[] = [];
  const failures: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') results.push(...r.value);
    else failures.push(providers[i]?.id ?? 'unknown');
  });
  // De-dupe by URL, keep first occurrence.
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
  return { results: deduped.slice(0, limit), failures };
}

// --- built-in providers ---

/**
 * Configured JSON web-search backend. Reads VITE_WEB_DISCOVERY_URL
 * (alias VITE_WEB_SEARCH_URL; GET {base}?q=... → { results: [...] }).
 * When unset, the provider is inert (returns []) — KNOX search works
 * normally without it. Never sends anything except the trimmed query
 * string. Origin for its hits is genuine 'web' (operator backend).
 */
export class ConfiguredJsonSearchProvider implements WebSearchProvider {
  readonly id = 'configured-json';
  readonly displayName = 'Configured web search';

  private baseUrl(): string | null {
    try {
      const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
      const raw = (env?.VITE_WEB_DISCOVERY_URL ?? env?.VITE_WEB_SEARCH_URL ?? '').trim();
      if (!raw) return null;
      const verdict = validateDiscoveryUrl(raw);
      return verdict.ok ? verdict.url! : null;
    } catch {
      return null;
    }
  }

  async search(query: string, opts: WebSearchOptions = {}): Promise<WebDiscoveryResult[]> {
    const base = this.baseUrl();
    if (!base) return [];
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
    try {
      const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
      const verdict = validateDiscoveryUrl(url);
      if (!verdict.ok) return [];
      const res = await doFetch(verdict.url!, { signal: controller.signal });
      if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
      const data = (await res.json()) as { results?: WebDiscoveryResult[] };
      if (!Array.isArray(data?.results)) return [];
      return data.results.slice(0, opts.limit ?? MAX_RESULTS_TOTAL);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return [];
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

let builtinRegistered = false;
/**
 * Register the built-in search backends once.
 *
 * Three providers, in order:
 *  1. `local-desktop` — ALWAYS active, no configuration needed. Desktop
 *     shell: local KNOX API discovery service; browser/PWA: direct public
 *     metadata lookup (MusicBrainz, no key). This is the production path —
 *     Web Discovery never depends solely on VITE_WEB_DISCOVERY_URL.
 *  2. `itunes` — ALWAYS active, no configuration needed. Genuine public
 *     web catalog via the compliant iTunes Search API (no key, no auth,
 *     no scraping): returns real public music.apple.com pages.
 *  3. `configured-json` — optional operator-configured JSON backend
 *     (VITE_WEB_DISCOVERY_URL). Inert (returns []) when unset.
 */
export function registerBuiltinWebSearch(): void {
  if (builtinRegistered && registry.size > 0) return;
  builtinRegistered = true;
  if (!registry.has('local-desktop')) {
    registerWebSearchProvider({
      id: 'local-desktop',
      displayName: 'Local discovery service',
      search: async (query, opts) => {
        const { localDesktopDiscoverySearch } = await import('./localDiscoveryService');
        return localDesktopDiscoverySearch(query, opts);
      },
    });
  }
  if (!registry.has('itunes')) {
    registerWebSearchProvider({
      id: 'itunes',
      displayName: 'Apple Music catalog',
      search: async (query, opts) => {
        const { itunesDiscoverySearch } = await import('./itunesSearch');
        return itunesDiscoverySearch(query, opts);
      },
    });
  }
  if (!registry.has('configured-json')) registerWebSearchProvider(new ConfiguredJsonSearchProvider());
}

export function __resetBuiltinWebSearchForTests(): void {
  builtinRegistered = false;
}
