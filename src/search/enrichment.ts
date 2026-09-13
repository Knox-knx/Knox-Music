// Progressive metadata enrichment for fast search results.
//
// Fast search rows may carry incomplete metadata (e.g. YouTube Music
// discovery returns `durationMs: 0` and an empty album for speed). This
// module owns the background detail-fetch policy:
//
//   search → render immediately → fetch track details in background
//          → merge into the existing rows (no flicker, no duplicates)
//
// Rules:
// - Only tracks where `needsEnrichment()` is true are fetched.
// - Detail lookups are cached per song id — never enrich the same track twice.
// - In-flight detail fetches are shared, so N rows for one track cost 1 request.
// - Cancellation: callers pass an AbortSignal tied to the current search; a
//   stale search never writes into newer state (callers must still guard on
//   the signal before applying, this module just stops early).
// - Failures are graceful: the original row is kept as-is, never removed.
// - Pure merge (`mergeEnrichedSongs`) keeps order stable and drops duplicates.

import type { Song } from '../core/types';
import { YOUTUBE_MUSIC_PROVIDER_ID } from '../providers/youtubeMusic/mapper';

/** Tracks that benefit from a background detail lookup. */
export function needsEnrichment(song: Song): boolean {
  if (!song || typeof song !== 'object') return false;
  if (song.providerId !== YOUTUBE_MUSIC_PROVIDER_ID) return false;
  if (!song.providerTrackId) return false;
  // Fast search rows have no duration yet; enriched rows do. Album/year may
  // legitimately stay empty even after enrichment — never gate on those.
  return !(song.durationMs > 0);
}

/** Merge enriched snapshots into the current rows: stable order, no dupes. */
export function mergeEnrichedSongs(current: Song[], enriched: Song[]): Song[] {
  if (enriched.length === 0) return current;
  const byId = new Map<string, Song>();
  for (const s of enriched) {
    if (s && s.id) byId.set(s.id, s);
  }
  if (byId.size === 0) return current;
  return current.map((s) => {
    const next = byId.get(s.id);
    if (!next) return s;
    // Preserve search-time ranking metadata; adopt the richer detail fields.
    return {
      ...s,
      durationMs: next.durationMs > 0 ? next.durationMs : s.durationMs,
      album: next.album || s.album,
      artworkUrl: next.artworkUrl || s.artworkUrl,
      year: next.year ?? s.year,
      title: next.title && next.title !== 'Untitled' ? next.title : s.title,
      artist: next.artist && next.artist !== 'Unknown artist' ? next.artist : s.artist,
    };
  });
}

/**
 * Enrich a batch of songs via `fetchDetail` (typically the provider's
 * `getSong`). Returns the merged list in the original order.
 *
 * - `cache` persists across searches (pass a component-level Map).
 * - `seenFailures` semantics: failures resolve to null and are NOT cached,
 *   so a later search may retry; successes are cached forever (per session).
 * - At most `maxDetails` detail fetches per call (oldest-first by order).
 */
export async function enrichSongs(
  songs: Song[],
  opts: {
    fetchDetail: (song: Song, signal?: AbortSignal) => Promise<Song | null>;
    cache?: Map<string, Song>;
    signal?: AbortSignal;
    maxDetails?: number;
  },
): Promise<Song[]> {
  const { fetchDetail, signal, maxDetails = 10 } = opts;
  const cache = opts.cache ?? new Map<string, Song>();
  if (songs.length === 0 || signal?.aborted) return songs;

  const pending: { song: Song; promise: Promise<Song | null> }[] = [];
  const queued = new Set<string>();
  for (const song of songs) {
    if (pending.length >= maxDetails) break;
    if (!needsEnrichment(song)) continue;
    if (cache.has(song.id) || queued.has(song.id)) continue;
    queued.add(song.id);
    let promise: Promise<Song | null>;
    try {
      promise = fetchDetail(song, signal);
    } catch {
      continue;
    }
    pending.push({ song, promise });
  }
  if (pending.length === 0) {
    // Everything needed is already cached — still merge so late cache writes
    // (from a previous batch) are reflected without new requests.
    const cachedOnly = songs.map((s) => cache.get(s.id)).filter((s): s is Song => !!s);
    return mergeEnrichedSongs(songs, cachedOnly);
  }

  const settled = await Promise.allSettled(pending.map((p) => p.promise));
  if (signal?.aborted) return songs;
  const fresh: Song[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && r.value.id) {
      cache.set(pending[i].song.id, r.value);
      fresh.push(r.value);
    }
    // Rejected / null: graceful — keep the original row, retry next time.
  });
  const cachedHits = songs
    .filter((s) => !fresh.some((f) => f.id === s.id))
    .map((s) => cache.get(s.id))
    .filter((s): s is Song => !!s);
  return mergeEnrichedSongs(songs, [...fresh, ...cachedHits]);
}

/** For tests: fresh per-test cache. */
export function createEnrichmentCache(): Map<string, Song> {
  return new Map<string, Song>();
}
