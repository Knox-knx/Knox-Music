// Result ranking: attach relevanceScore + matchType, then stable-sort.
//
// Priority (Phase 13):
//  1. Exact local match
//  2. Exact playable provider match
//  3. Strong playable provider match
//  4. Exact web reference
//  5. Strong web reference
//  6. Related result
// Order: match tier (exact → strong → partial → related) → playable before
// reference at the same tier → full before preview at the same tier →
// relevance desc → metadata confidence → title asc (stable) → original index.
//
// A web result never buries a playable exact match. Exact title+artist
// strongly outranks unrelated results. Bonuses never outrank a text tier.

import type { Song } from '../core/types';
import { isPreviewSong } from '../providers/capabilities';
import { parseQuery } from './queryParser';
import { scoreTrack } from './relevance';
import { confidenceFor } from './trackCandidate';

export type { MatchType } from './relevance';

/** Provider reliability (tiebreak only — never outranks text match). */
function providerWeight(providerId: string): number {
  switch (providerId) {
    case 'local': return 3;
    case 'jamendo': return 2;
    case 'internet-archive': return 2;
    case 'airbeats': return 2;
    case 'freetouse': return 1.5;
    case 'sample': return 1;
    case 'youtube-music': return 0.5;
    default:
      return providerId.startsWith('web-') ? 0 : 1;
  }
}

function isWebReferenceSong(s: Song): boolean {
  if (s.providerId.startsWith('web-')) return true;
  return s.capabilities?.streamable === false && !s.streamUrl && !s.isLocalFile && !s.isOfflineAvailable;
}

function isLocalSong(s: Song): boolean {
  return s.providerId === 'local' || s.isLocalFile === true;
}

/** Lower wins: tier(0-3) → local(0)/playable(1)/reference(2) → preview(0/1). */
function tierRank(
  matchType: Song['matchType'],
  opts: { local: boolean; playable: boolean; preview: boolean },
): number {
  const tier = matchType === 'exact' ? 0
    : matchType === 'strong' ? 1
    : matchType === 'partial' ? 2 : 3;
  // Within a tier: local exact first, then playable, then web reference.
  const playTier = opts.local ? 0 : opts.playable ? 1 : 2;
  const previewPen = opts.preview ? 1 : 0;
  return tier * 6 + playTier * 2 + previewPen;
}

export function rankSongs(songs: Song[], query: string): Song[] {
  const parsed = parseQuery(query);
  return songs
    .map((s, i) => {
      const { relevanceScore, matchType } = scoreTrack(
        { title: s.title, artist: s.artist, album: s.album, genre: s.genre },
        parsed,
      );
      // Small, honest quality signals — never enough to outrank a text match.
      let bonus = 0;
      if (s.artworkUrl) bonus += 1;
      if (s.streamUrl) bonus += 0.5;
      if (s.durationMs > 0) bonus += 0.5;
      if (s.album) bonus += 0.25;
      bonus += confidenceFor(s) * 0.5;
      bonus += providerWeight(s.providerId) * 0.2;
      const ranked: Song = { ...s, relevanceScore, matchType };
      const preview = isPreviewSong(ranked);
      const webRef = isWebReferenceSong(ranked);
      const local = isLocalSong(ranked);
      const playable = !webRef;
      return {
        s: ranked,
        i,
        score: relevanceScore + bonus,
        tier: tierRank(matchType, { local, playable, preview }),
      };
    })
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.s.title.localeCompare(b.s.title) || a.i - b.i)
    .map((r) => r.s);
}

/** True when at least one result is an exact match for the query. */
export function hasExactMatch(songs: Song[]): boolean {
  return songs.some((s) => s.matchType === 'exact');
}

/**
 * True when at least one result is a strong match or better.
 * The "No exact match" banner must stay hidden for strong results —
 * showing it next to a strong/exact hit is logically inconsistent.
 */
export function hasStrongMatch(songs: Song[]): boolean {
  return songs.some((s) => s.matchType === 'exact' || s.matchType === 'strong');
}
