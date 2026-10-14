// KNOX search engine — the single entry point for online search.
//
// Pipeline: parse → fan-out (isolated) → normalize → dedupe → rank.
// SearchScreen must use this instead of hand-rolling provider calls.
//
// - Provider isolation: Promise.allSettled — one provider failing never
//   breaks the others; failures are returned per provider id.
// - Request cancellation: the caller's AbortSignal is forwarded; a stale
//   (aborted) response is discarded and never overwrites newer results.
// - Short-term cache: identical (kind + normalized query) searches within
//   CACHE_TTL_MS reuse results without hitting the network.

import type { Album, Artist, Playlist, Song } from '../core/types';
import type { MusicProvider } from '../providers/types';
import { logger } from '../core/logger';
import { parseQuery, type ParsedQuery } from './queryParser';
import { normalizeQuery, type NormalizedQuery } from './normalizeQuery';
import { rankSongs, hasExactMatch, hasStrongMatch } from './ranking';
import { dedupeSongs } from './dedupe';

export type SearchKind = 'songs' | 'artists' | 'albums' | 'playlists';
export type SearchItem = Song | Artist | Album | Playlist;

export interface SearchOutcome {
  query: NormalizedQuery;
  parsed: ParsedQuery;
  songs: Song[];
  hasExactMatch: boolean;
  hasStrongMatch: boolean;
  failures: string[];
}

interface CacheEntry {
  at: number;
  songs: Song[];
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function cacheKey(kind: SearchKind, normalized: string): string {
  return `${kind}:${normalized}`;
}

/** For tests: clear the short-term search cache. */
export function clearSearchCache(): void {
  cache.clear();
}

function readCache(kind: SearchKind, normalized: string): Song[] | null {
  const e = cache.get(cacheKey(kind, normalized));
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(cacheKey(kind, normalized));
    return null;
  }
  return e.songs;
}

function writeCache(kind: SearchKind, normalized: string, songs: Song[]): void {
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  cache.set(cacheKey(kind, normalized), { at: Date.now(), songs });
}

/**
 * Fan out a song search across providers with full isolation. Never throws
 * for provider failures — returns partial songs + failure ids.
 */
export async function searchSongsIsolated(
  providers: MusicProvider[],
  query: string,
  signal?: AbortSignal,
): Promise<{ songs: Song[]; failures: string[] }> {
  const q = query.trim();
  if (!q) return { songs: [], failures: [] };
  const settled = await Promise.allSettled(
    providers.map((p) => p.searchSongs(q, signal)),
  );
  const songs: Song[] = [];
  const failures: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const list = Array.isArray(r.value) ? r.value : [];
      songs.push(...list);
    } else {
      failures.push(providers[i]?.id ?? 'unknown');
      logger.warn('search', `provider failed (${providers[i]?.id})`, String(r.reason));
    }
  });
  return { songs, failures };
}

export interface RankOptions {
  /** When false, keep all results (default). When true, drop zero-score items. */
  dropZeroScore?: boolean;
}

/**
 * Full pipeline for one query: normalize → dedupe → rank.
 * Pure (no network) apart from the cache — easy to test.
 */
export function runSearchPipeline(songs: Song[], rawQuery: string, opts: RankOptions = {}): SearchOutcome {
  const query = normalizeQuery(rawQuery);
  const parsed = parseQuery(rawQuery);
  const clean = dedupeSongs(songs);
  const ranked = rankSongs(clean, rawQuery);
  const finalSongs = opts.dropZeroScore ? ranked.filter((s) => (s.relevanceScore ?? 0) > 0) : ranked;
  // Cache the ranked list for identical repeat searches.
  if (query.normalizedQuery) writeCache('songs', query.normalizedQuery, finalSongs);
  return {
    query,
    parsed,
    songs: finalSongs,
    hasExactMatch: hasExactMatch(finalSongs),
    hasStrongMatch: hasStrongMatch(finalSongs),
    failures: [],
  };
}

/** Cached ranked songs for an identical repeat query (null on miss). */
export function cachedSongs(rawQuery: string): Song[] | null {
  const { normalizedQuery } = normalizeQuery(rawQuery);
  if (!normalizedQuery) return null;
  return readCache('songs', normalizedQuery);
}

export { parseQuery, normalizeQuery, rankSongs, hasExactMatch, hasStrongMatch, dedupeSongs };
