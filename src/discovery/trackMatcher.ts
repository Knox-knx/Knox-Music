// Live Web Discovery — track matching.
//
// Connects web references to the KNOX search engine using the existing
// normalization (normalizeKeyPart) and relevance helpers where possible.
// Artist matching is load-bearing: exact title + different artist never
// auto-merges. Confidence scoring:
//
//   exact title + exact artist + similar duration → very strong
//   exact title + different artist               → do not merge

import { normalizeKeyPart, foldedEquals } from '../search/normalizeQuery';
import type { Song } from '../core/types';
import type { TrackReference } from './types';

export interface DiscoveryMatch {
  reference: TrackReference;
  song: Song;
  confidence: number; // 0–100
  kind: 'exact' | 'strong' | 'partial' | 'none';
}

function durationClose(a?: number, b?: number): boolean {
  if (!a || !b || a <= 0 || b <= 0) return false;
  const tolerance = Math.max(5000, Math.min(a, b) * 0.08);
  return Math.abs(a - b) <= tolerance;
}

export function scoreDiscoveryMatch(
  ref: Pick<TrackReference, 'title' | 'artist' | 'album' | 'durationMs' | 'providerId' | 'canonicalUrl'>,
  song: Pick<Song, 'title' | 'artist' | 'album' | 'durationMs' | 'providerId' | 'sourceUrl' | 'providerTrackId'>,
): { confidence: number; kind: DiscoveryMatch['kind'] } {
  const refTitle = normalizeKeyPart(ref.title);
  const refArtist = normalizeKeyPart(ref.artist);
  const songTitle = normalizeKeyPart(song.title);
  const songArtist = normalizeKeyPart(song.artist);
  if (!refTitle || !songTitle) return { confidence: 0, kind: 'none' };

  const titleExact = refTitle === songTitle;
  const titleContains = refTitle.includes(songTitle) || songTitle.includes(refTitle);
  const artistExact = !!refArtist && !!songArtist && foldedEquals(refArtist, songArtist);
  const artistKnown = !!refArtist && !!songArtist;
  const artistMismatch =
    artistKnown && !artistExact && !songArtist.includes(refArtist) && !refArtist.includes(songArtist);

  // Same canonical URL / provider id is a strong identity signal.
  if (ref.canonicalUrl && song.sourceUrl && ref.canonicalUrl === song.sourceUrl) {
    return { confidence: 98, kind: 'exact' };
  }
  if (ref.providerId && song.providerTrackId && ref.providerId === song.providerTrackId) {
    if (titleExact && artistExact) return { confidence: 100, kind: 'exact' };
    if (titleExact) return { confidence: 88, kind: 'strong' };
  }

  if (titleExact && artistExact) {
    const durBonus = durationClose(ref.durationMs, song.durationMs) ? 4 : 0;
    const albumBonus =
      ref.album && song.album && normalizeKeyPart(ref.album) === normalizeKeyPart(song.album) ? 2 : 0;
    return { confidence: Math.min(100, 94 + durBonus + albumBonus), kind: 'exact' };
  }
  // Exact title but a DIFFERENT artist: never merge automatically.
  if (titleExact && artistMismatch) {
    return { confidence: 18, kind: 'none' };
  }
  if (titleExact && !artistKnown) {
    return { confidence: 62, kind: 'partial' };
  }
  if (titleExact) {
    // Artist partially overlaps (e.g. featured artists).
    return { confidence: 78, kind: 'strong' };
  }
  if (titleContains && artistExact) {
    return { confidence: 74, kind: 'strong' };
  }
  if (titleContains) {
    return { confidence: 38, kind: 'partial' };
  }
  return { confidence: 0, kind: 'none' };
}

/** Best provider-song match for each reference (sorted by confidence desc). */
export function matchDiscoveryToSongs(
  refs: TrackReference[],
  songs: Song[],
  minConfidence = 70,
): DiscoveryMatch[] {
  const out: DiscoveryMatch[] = [];
  for (const reference of refs) {
    let best: Song | null = null;
    let bestScore = { confidence: 0, kind: 'none' as DiscoveryMatch['kind'] };
    for (const song of songs) {
      const s = scoreDiscoveryMatch(reference, song);
      if (s.confidence > bestScore.confidence) {
        bestScore = s;
        best = song;
      }
    }
    if (best && bestScore.confidence >= minConfidence) {
      out.push({ reference, song: best, confidence: bestScore.confidence, kind: bestScore.kind });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Deduplicate discovery references: same canonical URL wins once; same
 * folded title+artist keeps the highest-confidence / most complete entry.
 */
export function dedupeReferences(refs: TrackReference[]): TrackReference[] {
  const byUrl = new Map<string, TrackReference>();
  for (const r of refs) {
    if (!r.canonicalUrl) continue;
    const prev = byUrl.get(r.canonicalUrl);
    if (!prev) {
      byUrl.set(r.canonicalUrl, r);
      continue;
    }
    const score = (x: TrackReference) =>
      (x.title ? 2 : 0) + (x.artist ? 2 : 0) + (x.durationMs ? 1 : 0) + (x.artwork ? 1 : 0);
    if (score(r) > score(prev)) byUrl.set(r.canonicalUrl, r);
  }
  const seenTitleArtist = new Set<string>();
  const out: TrackReference[] = [];
  const sorted = [...byUrl.values()].sort(
    (a, b) => (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0),
  );
  for (const r of sorted) {
    const k = `${normalizeKeyPart(r.artist)}|${normalizeKeyPart(r.title)}`;
    if (seenTitleArtist.has(k)) continue;
    seenTitleArtist.add(k);
    out.push(r);
  }
  return out;
}
