// Dedupe for ranked results: drop invalid entries + exact id duplicates.
// Cross-provider equivalents stay visible (with provider badges) so the user
// can pick sources and playback can fall back. See findEquivalents().

import type { Song } from '../core/types';
import { normalizeKeyPart } from './normalizeQuery';

export function isValidSong(s: Song): boolean {
  if (!s || typeof s !== 'object') return false;
  if (!s.id || !s.providerId || !s.providerTrackId) return false;
  if (!s.title || !s.title.trim()) return false;
  if (!s.artist || !s.artist.trim()) return false;
  return true;
}

export function dedupeSongs(songs: Song[]): Song[] {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const s of songs) {
    if (!isValidSong(s)) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Strict equivalence key — same folded title AND artist. */
export function equivalenceKey(song: Pick<Song, 'title' | 'artist'>): string {
  return `${normalizeKeyPart(song.artist)}|${normalizeKeyPart(song.title)}`;
}

/** Duration tolerance: same song if within max(5s, 8% of shorter). */
export function durationsMatch(aMs?: number, bMs?: number): boolean {
  if (!aMs || !bMs || aMs <= 0 || bMs <= 0) return true; // unknown duration never splits a group
  const tolerance = Math.max(5000, Math.min(aMs, bMs) * 0.08);
  return Math.abs(aMs - bMs) <= tolerance;
}

/**
 * Other-provider results matching the same folded title+artist AND a
 * compatible duration. Two different songs that share a title but have
 * different artists never match (key includes artist); same title+artist
 * with a wildly different duration is kept separate.
 */
export function findEquivalents(song: Song, pool: Song[]): Song[] {
  const key = equivalenceKey(song);
  return pool.filter(
    (s) => s.id !== song.id && equivalenceKey(s) === key && durationsMatch(song.durationMs, s.durationMs),
  );
}

export interface SongGroup {
  key: string;
  title: string;
  artist: string;
  /** One logical song; sources sorted playable-first for fallback. */
  sources: Song[];
  primary: Song;
}

/**
 * Group cross-provider equivalents for display ("one logical song with
 * source variants") while preserving every source. Groups are ordered by
 * their best source's existing order. Never merges different songs that
 * merely share a title (artist must match; duration must be compatible).
 */
export function groupEquivalents(songs: Song[]): SongGroup[] {
  const groups = new Map<string, Song[]>();
  for (const s of songs) {
    if (!isValidSong(s)) continue;
    const key = equivalenceKey(s);
    const bucket = groups.get(key);
    if (!bucket) {
      groups.set(key, [s]);
      continue;
    }
    // Duration-incompatible entries with the same title+artist start a
    // separate logical group (different recording/edit).
    const compat = bucket.find((b) => durationsMatch(b.durationMs, s.durationMs));
    if (compat || bucket.length === 0) {
      bucket.push(s);
    } else {
      groups.set(`${key}#${bucket.length}`, [s]);
    }
  }
  const out: SongGroup[] = [];
  for (const [key, sources] of groups) {
    const sorted = [...sources].sort((a, b) => {
      const aPlay = a.capabilities?.streamable !== false || !!a.streamUrl ? 0 : 1;
      const bPlay = b.capabilities?.streamable !== false || !!b.streamUrl ? 0 : 1;
      if (aPlay !== bPlay) return aPlay - bPlay;
      return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    });
    out.push({ key, title: sorted[0].title, artist: sorted[0].artist, sources: sorted, primary: sorted[0] });
  }
  return out;
}
