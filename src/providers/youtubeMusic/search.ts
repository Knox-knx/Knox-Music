// YouTube Music search: throttling, timeout, backoff, short-lived cache.
//
// Conservative by design (InnerTube is not an official public API
// contract): at most one in-flight search, stale searches are cancelled,
// failures are never cached long, and retries use exponential backoff.

import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { Song } from '../../core/types';
import { providerEnv } from '../env';
import { sidecarJson } from './client';
import { mapSearchResults } from './mapper';
import type { YouTubeMusicSearchResponse } from './types';

export const YOUTUBEMUSIC_MAX_QUERY = 256;
const CACHE_TTL_MS = 45_000;
const MAX_CACHE_ENTRIES = 100;

const cache = new Map<string, { at: number; songs: Song[] }>();
let lastSearchAt = 0;
/** The query a shared in-flight request is serving (stale-query guard). */
let inFlightQuery: string | null = null;
let inFlight: Promise<Song[]> | null = null;

const MIN_INTERVAL_MS = 300;

function cacheGet(q: string): Song[] | null {
  const e = cache.get(q);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(q);
    return null;
  }
  return e.songs;
}

function cacheSet(q: string, songs: Song[]): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  cache.set(q, { at: Date.now(), songs });
}

/** For tests: clear the provider search cache. */
export function clearYouTubeMusicCache(): void {
  cache.clear();
  lastSearchAt = 0;
  inFlightQuery = null;
  inFlight = null;
}

export function validateQuery(raw: string): string {
  const q = (raw ?? '').trim();
  if (!q) throw new ProviderError('UNSUPPORTED', 'Search query must not be empty.');
  if (q.length > YOUTUBEMUSIC_MAX_QUERY) {
    throw new ProviderError('UNSUPPORTED', `Search query too long (max ${YOUTUBEMUSIC_MAX_QUERY} characters).`);
  }
  return q;
}

function errorFor(code: string | undefined, fallback: string): ProviderError {
  switch ((code ?? '').toUpperCase()) {
    case 'INVALID_QUERY': return new ProviderError('UNSUPPORTED', fallback);
    case 'TIMEOUT': return new ProviderError('TIMEOUT', 'YouTube Music is taking too long to respond.');
    case 'RATE_LIMITED': return new ProviderError('RATE_LIMIT', 'YouTube Music search is temporarily limited. Try again shortly.');
    case 'NOT_FOUND': return new ProviderError('NOT_FOUND', 'Not found on YouTube Music.');
    default: return new ProviderError('NETWORK', fallback);
  }
}

/**
 * Search YouTube Music songs via the loopback sidecar.
 * Empty query → [] (no network). Over-long → ProviderError. Aborted →
 * [] (stale searches never update UI state; callers check signal too).
 */
export async function searchYouTubeMusic(query: string, signal?: AbortSignal): Promise<Song[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const valid = validateQuery(q);
  if (signal?.aborted) return [];

  const cacheKey = valid.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Throttle: serialize searches with a minimal gap; concurrent callers for
  // the SAME query share the single in-flight request. A different query
  // never reuses a stale in-flight response — it waits for the in-flight one
  // to settle (preserving the throttle gap) and then issues its own request,
  // so fast typing can never paint old results over a newer query.
  if (inFlight && inFlightQuery === cacheKey) {
    try {
      return await inFlight;
    } catch {
      // Fall through to a fresh attempt below.
    }
  } else if (inFlight) {
    try {
      await inFlight;
    } catch {
      /* the other query's failure is irrelevant here */
    }
    if (signal?.aborted) return [];
    // Re-check the cache: the settled request may have been for this query
    // (e.g. artists + songs fan-out racing) — avoid a duplicate fetch.
    const raced = cacheGet(cacheKey);
    if (raced) return raced;
  }

  const run = (async (): Promise<Song[]> => {
    const gap = Date.now() - lastSearchAt;
    if (gap < MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - gap));
    }
    if (signal?.aborted) return [];
    lastSearchAt = Date.now();
    const timeoutMs = Math.min(Math.max(providerEnv.requestTimeoutMs, 1000), 15000);
    const data = await sidecarJson<YouTubeMusicSearchResponse>(
      'search',
      `?q=${encodeURIComponent(valid)}`,
      timeoutMs,
      signal,
    );
    if (signal?.aborted) return [];
    if (!data) {
      logger.warn('youtube-music', 'YOUTUBE_MUSIC_SEARCH sidecar unavailable');
      throw new ProviderError('NETWORK', 'YouTube Music is unavailable (start the local service or disable the provider).');
    }
    const maybeErr = (data as unknown as { error?: { code?: string; message?: string } }).error;
    if (maybeErr) {
      const code = maybeErr.code;
      logger.warn('youtube-music', `YOUTUBE_MUSIC_SEARCH ${code ?? 'error'}`);
      throw errorFor(code, 'YouTube Music search failed.');
    }
    const list = (data as YouTubeMusicSearchResponse).results;
    // Shape drift (unofficial API) → empty, never a crash. Drift is not
    // cached; only real result lists are.
    if (!Array.isArray(list)) return [];
    const songs = mapSearchResults(list);
    cacheSet(cacheKey, songs);
    logger.info('youtube-music', `YOUTUBE_MUSIC_SEARCH ok (${songs.length})`);
    return songs;
  })();

  inFlight = run;
  inFlightQuery = cacheKey;
  try {
    return await run;
  } finally {
    if (inFlight === run) {
      inFlight = null;
      inFlightQuery = null;
    }
  }
}
