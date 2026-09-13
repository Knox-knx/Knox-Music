// searchApi — UI entry point for search (replaces direct ProviderManager use).
//
// Pipeline (unchanged semantics, owned by KNOX Core):
//   UI → searchApi.search() → ProviderManager (parallel, isolated) → ranking/dedupe
//   + optional Live Web Discovery (parallel, never blocking, reference-only)
//
// Search never stops playback, never throws for provider failures (partial
// results + failure ids), supports abort + short-term cache.

import type { Album, Artist, Playlist, Song } from '../core/types';
import { assertQuery } from './client';
import { getProviderManager } from '../providers/ProviderManager';
import { runSearchPipeline, type SearchOutcome } from '../search/searchEngine';
import { songRepo } from '../data/repositories';
import { logger } from '../core/logger';
import type { TrackReference } from '../discovery/types';

export type SearchKind = 'songs' | 'artists' | 'albums' | 'playlists';

export interface SearchResult {
  songs: Song[];
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  failures: string[];
  hasExactMatch: boolean;
  /** Live Web Discovery references (metadata/reference only, never playable). */
  webReferences?: TrackReference[];
  webDiscoveryTimedOut?: boolean;
}

/**
 * Web Discovery is disconnected in the stable release: provider-only
 * search. The toggle (Settings → Search) is removed; an explicit
 * per-call `withWebDiscovery: true` still reaches the isolated discovery
 * module (used by tests/diagnostics — never by shipped UI).
 */
function webDiscoveryEnabled(): boolean {
  return false;
}

export const searchApi = {
  /**
   * Full multi-kind search across enabled providers + ranking.
   * `offlineOnly` restricts to the local library (offline mode).
   * Live Web Discovery runs in parallel (when enabled) and merges when
   * available — provider results render immediately and are never blocked.
   */
  async search(
    rawQuery: string,
    opts: {
      kinds?: SearchKind[];
      signal?: AbortSignal;
      offlineOnly?: boolean;
      /** Override the settings toggle (tests / explicit opt-out). */
      withWebDiscovery?: boolean;
    } = {},
  ): Promise<SearchResult> {
    const q = rawQuery.trim();
    if (!q) return { songs: [], artists: [], albums: [], playlists: [], failures: [], hasExactMatch: false };
    assertQuery(q);
    const kinds = opts.kinds ?? ['songs', 'artists', 'albums', 'playlists'];
    const empty: SearchResult = { songs: [], artists: [], albums: [], playlists: [], failures: [], hasExactMatch: false };

    if (opts.offlineOnly) {
      const local = await songRepo.searchLocal(q, 50);
      if (opts.signal?.aborted) return empty;
      const outcome: SearchOutcome = runSearchPipeline(local, q);
      return { ...empty, songs: outcome.songs, hasExactMatch: outcome.hasExactMatch };
    }

    const pm = getProviderManager();
    const wantDiscovery =
      (opts.withWebDiscovery ?? webDiscoveryEnabled()) && kinds.includes('songs') && !opts.signal?.aborted;

    // Provider search starts immediately; web discovery starts in parallel.
    const discoveryP = wantDiscovery
      ? import('../discovery/webDiscovery').then(
          ({ discoverWebReferences }) =>
            discoverWebReferences(q, { signal: opts.signal }).catch(
              (): { references: TrackReference[]; failures: string[]; timedOut: boolean } => ({
                references: [],
                failures: ['error'],
                timedOut: false,
              }),
            ),
          () => ({ references: [] as TrackReference[], failures: ['error'], timedOut: false }),
        )
      : Promise.resolve({ references: [] as TrackReference[], failures: [] as string[], timedOut: false });

    const [rs, ra, rl, rp] = await Promise.all([
      kinds.includes('songs') ? pm.searchAll(q, 'songs', opts.signal) : Promise.resolve({ items: [], failures: [] }),
      kinds.includes('artists') ? pm.searchAll(q, 'artists', opts.signal) : Promise.resolve({ items: [], failures: [] }),
      kinds.includes('albums') ? pm.searchAll(q, 'albums', opts.signal) : Promise.resolve({ items: [], failures: [] }),
      kinds.includes('playlists') ? pm.searchAll(q, 'playlists', opts.signal) : Promise.resolve({ items: [], failures: [] }),
    ]);
    if (opts.signal?.aborted) return empty;
    const outcome: SearchOutcome = runSearchPipeline(rs.items as Song[], q);
    const failures = [...new Set([...rs.failures, ...ra.failures, ...rl.failures, ...rp.failures])];

    // Merge web results when available — never wait indefinitely (bounded).
    let webReferences: TrackReference[] = [];
    let webDiscoveryTimedOut = false;
    if (wantDiscovery) {
      try {
        const settled = await Promise.race([
          discoveryP,
          new Promise<{ references: TrackReference[]; failures: string[]; timedOut: boolean }>((resolve) =>
            setTimeout(() => resolve({ references: [], failures: ['timeout'], timedOut: true }), 9000),
          ),
        ]);
        webReferences = Array.isArray(settled.references) ? settled.references.slice(0, 8) : [];
        webDiscoveryTimedOut = settled.timedOut === true;
      } catch (e) {
        logger.warn('discovery', 'web merge skipped', String(e).slice(0, 160));
      }
    }

    return {
      songs: kinds.includes('songs') ? outcome.songs : [],
      artists: (ra.items as Artist[]) ?? [],
      albums: (rl.items as Album[]) ?? [],
      playlists: (rp.items as Playlist[]) ?? [],
      failures,
      hasExactMatch: outcome.hasExactMatch,
      webReferences,
      webDiscoveryTimedOut,
    };
  },

  /** Ranked song search only (cheap path for detail screens). */
  async searchSongs(query: string, signal?: AbortSignal): Promise<{ songs: Song[]; failures: string[] }> {
    const r = await this.search(query, { kinds: ['songs'], signal });
    return { songs: r.songs, failures: r.failures };
  },

  /**
   * Find playable versions of a web reference using only authorized
   * playback-capable providers. Never returns the reference itself.
   */
  async findPlayableVersions(
    ref: TrackReference,
    signal?: AbortSignal,
  ): Promise<{ songs: Song[]; failures: string[] }> {
    const q = `${ref.title ?? ''} ${ref.artist ?? ''}`.trim();
    if (!q) return { songs: [], failures: [] };
    const pm = getProviderManager();
    const { items, failures } = await pm.searchAll(q, 'songs', signal);
    const playable = (items as Song[]).filter((s) => {
      try {
        const p = pm.get(s.providerId);
        if (p && p.capabilities.supportsStreaming === false) return false;
      } catch {
        /* keep */
      }
      return s.capabilities?.streamable !== false;
    });
    const { matchDiscoveryToSongs } = await import('../discovery/trackMatcher');
    const matches = matchDiscoveryToSongs([ref], playable, 60);
    if (matches.length > 0) {
      const ids = new Set(matches.map((m) => m.song.id));
      return { songs: playable.filter((s) => ids.has(s.id)), failures };
    }
    // Fallback: top provider hits by text match (still playable-only).
    const { runSearchPipeline } = await import('../search/searchEngine');
    const outcome = runSearchPipeline(playable, q);
    return { songs: outcome.songs.slice(0, 6), failures };
  },

  /** Local library search (offline mode). */
  async searchLocal(query: string, limit = 50): Promise<Song[]> {
    const q = query.trim();
    if (!q) return [];
    return songRepo.searchLocal(q, limit);
  },

  /** Suggestion source: local history + library prefix matches. No network. */
  async suggestions(prefix: string, limit = 8): Promise<string[]> {
    const q = prefix.trim().toLowerCase();
    if (!q) return [];
    try {
      const local = await songRepo.searchLocal(prefix, limit);
      const out = new Set<string>();
      for (const s of local) {
        if (s.title.toLowerCase().includes(q)) out.add(s.title);
        if (out.size >= limit) break;
      }
      return [...out].slice(0, limit);
    } catch {
      return [];
    }
  },
};
