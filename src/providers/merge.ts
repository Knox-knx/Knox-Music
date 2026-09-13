// Result merging: validation, normalization, dedup, ranking, sorting.
// Pure functions — no network, no side effects — so they are easy to test.

import type { Song } from '../core/types';
import { isPreviewSong } from './capabilities';

/** Normalize for comparison: lowercase, trim, collapse whitespace/punctuation. */
export function normalizeKeyPart(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strict equivalence key — same normalized title AND artist. */
export function equivalenceKey(song: Pick<Song, 'title' | 'artist'>): string {
  return `${normalizeKeyPart(song.artist)}|${normalizeKeyPart(song.title)}`;
}

/** Drop results that can never be played or displayed honestly. */
export function isValidSong(s: Song): boolean {
  if (!s || typeof s !== 'object') return false;
  if (!s.id || !s.providerId || !s.providerTrackId) return false;
  if (!s.title || !s.title.trim()) return false;
  if (!s.artist || !s.artist.trim()) return false;
  return true;
}

/**
 * Remove invalid entries + exact duplicates (same Song.id). Cross-provider
 * equivalents are NOT collapsed — they stay visible with their provider
 * badge so the user can pick/fallback. Use findEquivalents() for fallback.
 */
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

/** Other-provider results matching the same normalized title+artist. */
export function findEquivalents(song: Song, pool: Song[]): Song[] {
  const key = equivalenceKey(song);
  return pool.filter((s) => s.id !== song.id && equivalenceKey(s) === key);
}

function rankScore(song: Song, q: string): number {
  const needle = normalizeKeyPart(q);
  if (!needle) return 0;
  const title = normalizeKeyPart(song.title);
  const artist = normalizeKeyPart(song.artist);
  let score = 0;
  if (title === needle) score += 6;
  else if (title.startsWith(needle)) score += 4;
  else if (title.includes(needle)) score += 2;
  if (artist === needle) score += 4;
  else if (artist.startsWith(needle)) score += 2;
  else if (artist.includes(needle)) score += 1;
  // Prefer playable + artwork, but never above an exact text match.
  // A genuine full playable result outranks a preview-only one at equal
  // text relevance — previews stay visible, just ranked after equivalent
  // full results.
  const preview = isPreviewSong(song);
  if (!preview && (song.streamUrl || ['local', 'sample', 'jamendo', 'freetouse', 'internet-archive', 'airbeats'].includes(song.providerId))) score += 1;
  if (preview && song.streamUrl) score += 0.25;
  if (song.artworkUrl) score += 1;
  if (song.downloadAllowed) score += 0.5;
  return score;
}

/** Merge + rank. Stable: relevance desc, then full-before-preview, then title asc. */
export function mergeAndRank(songs: Song[], query: string): Song[] {
  const clean = dedupeSongs(songs);
  return clean
    .map((s, i) => ({ s, i, score: rankScore(s, query) }))
    .sort((a, b) =>
      b.score - a.score
      || Number(isPreviewSong(a.s)) - Number(isPreviewSong(b.s))
      || a.s.title.localeCompare(b.s.title)
      || a.i - b.i,
    )
    .map((r) => r.s);
}

export type SongSort = 'relevance' | 'title' | 'artist' | 'duration' | 'provider';

export function sortSongs(songs: Song[], sort: SongSort, query = ''): Song[] {
  const arr = [...songs];
  switch (sort) {
    case 'title':
      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case 'artist':
      return arr.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    case 'duration':
      return arr.sort((a, b) => (a.durationMs || 0) - (b.durationMs || 0));
    case 'provider':
      return arr.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.title.localeCompare(b.title));
    case 'relevance':
    default:
      return mergeAndRank(arr, query);
  }
}

/** Short human label for the provider badge in search rows. Truthful source badges. */
export function providerLabel(providerId: string): string {
  switch (providerId) {
    case 'local': return 'Local';
    case 'sample': return 'Demo';
    case 'jamendo': return 'Jamendo';
    case 'internet-archive': return 'Internet Archive';
    case 'freetouse': return 'FreeToUse';
    case 'airbeats': return 'AirBeats';
    case 'youtube-music': return 'YouTube Music';
    case 'radio-browser':
    case 'radio': return 'Radio';
    case 'web-discovery':
    case 'web': return 'Web';
    case 'web-jiosaavn': return 'JioSaavn (web ref)';
    case 'web-spotify': return 'Spotify (web ref)';
    case 'web-youtube-music-web': return 'YouTube Music (web ref)';
    case 'web-soundcloud': return 'SoundCloud (web ref)';
    case 'web-bandcamp': return 'Bandcamp (web ref)';
    case 'web-audius': return 'Audius (web ref)';
    case 'web-musicbrainz': return 'MusicBrainz (web ref)';
    case 'web-apple-music': return 'Apple Music (web ref)';
    default:
      if (providerId.startsWith('web-')) {
        const site = providerId.slice(4).replace(/-/g, ' ');
        return site.charAt(0).toUpperCase() + site.slice(1) + ' (web ref)';
      }
      return providerId.toUpperCase() === providerId ? providerId : providerId;
  }
}
