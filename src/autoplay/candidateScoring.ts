// Autoplay candidate scoring — pure functions, no I/O.
//
// Priority (best → worst):
//   1. Same artist (exact normalized match)
//   2. Same album
//   3. Same genre/tags
//   4. Related artist (shared words)
//   5. Same provider (related tracks from the same source)
//   6. Related search results (title word overlap)
//
// Bonuses: favorites, frequent plays, artwork, full (non-preview) tracks.
// Penalties: previews, missing metadata. Discovery-only tracks are NOT
// scored here — they are excluded before scoring (see recommendationEngine).

import type { Song } from '../core/types';
import { normalizeKeyPart } from '../providers/merge';
import { isPreviewSong } from '../providers/capabilities';
import type { CandidateSignals, ScoredCandidate } from './recommendationTypes';

function wordsOf(s: string | undefined): string[] {
  const n = normalizeKeyPart(s);
  return n ? n.split(' ').filter(Boolean) : [];
}

function sharedWordCount(a: string | undefined, b: string | undefined): number {
  const aw = new Set(wordsOf(a));
  if (aw.size === 0) return 0;
  let n = 0;
  for (const w of wordsOf(b)) {
    if (w.length > 2 && aw.has(w)) n += 1;
  }
  return n;
}

/**
 * Score one candidate against the current track. Higher wins.
 * Deterministic and side-effect free — safe to call on every prefetch.
 */
export function scoreCandidate(
  candidate: Song,
  current: Song,
  signals: CandidateSignals = { isFavorite: false, playCount: 0 },
): ScoredCandidate {
  let score = 0;
  const reasons: string[] = [];

  // 1. Same artist — strongest signal.
  if (
    normalizeKeyPart(candidate.artist) &&
    normalizeKeyPart(candidate.artist) === normalizeKeyPart(current.artist)
  ) {
    score += 10;
    reasons.push('same-artist');
  } else {
    // 4. Related artist — shared significant words (e.g. "Alan Walker"
    // vs "Walker & Royce" is weak; "Arijit Singh" vs "Arijit" is strong).
    const shared = sharedWordCount(candidate.artist, current.artist);
    if (shared > 0) {
      const bonus = Math.min(4, shared * 2);
      score += bonus;
      reasons.push('related-artist');
    }
  }

  // 2. Same album.
  if (
    normalizeKeyPart(candidate.album) &&
    normalizeKeyPart(candidate.album) === normalizeKeyPart(current.album)
  ) {
    score += 8;
    reasons.push('same-album');
  }

  // 3. Same genre/tags.
  if (
    candidate.genre &&
    current.genre &&
    normalizeKeyPart(candidate.genre) === normalizeKeyPart(current.genre)
  ) {
    score += 5;
    reasons.push('same-genre');
  }

  // 5. Same provider — related tracks from the same source resolve fastest
  // and share licensing/quality characteristics.
  if (candidate.providerId && candidate.providerId === current.providerId) {
    score += 2;
    reasons.push('same-provider');
  }

  // 6. Title word overlap — related search results.
  const titleOverlap = sharedWordCount(candidate.title, current.title);
  if (titleOverlap > 0) {
    const bonus = Math.min(3, titleOverlap);
    score += bonus;
    reasons.push('related-title');
  }

  // Favorites / frequent plays are recommendation SIGNALS only — autoplay
  // never writes to the library or favorites itself.
  if (signals.isFavorite) {
    score += 3;
    reasons.push('favorite');
  }
  if (signals.playCount > 0) {
    const bonus = Math.min(4, Math.floor(Math.log2(signals.playCount + 1)) + 1);
    score += bonus;
    reasons.push('frequent');
  }

  // Honest quality signals — never enough to outrank a text match.
  if (candidate.artworkUrl) {
    score += 1;
    reasons.push('artwork');
  }
  if (!isPreviewSong(candidate)) {
    score += 2;
    reasons.push('full-track');
  } else {
    score -= 5;
    reasons.push('preview-penalty');
  }

  // Duration similarity: tracks of similar length fit the listening flow.
  if (candidate.durationMs > 0 && current.durationMs > 0) {
    const diff = Math.abs(candidate.durationMs - current.durationMs);
    if (diff <= 60_000) {
      score += 1;
      reasons.push('similar-length');
    }
  }

  return { song: candidate, score, reasons };
}

/** Rank candidates best-first. Stable: score desc, then title asc. */
export function rankCandidates(
  candidates: Song[],
  current: Song,
  signalFor: (song: Song) => CandidateSignals = () => ({ isFavorite: false, playCount: 0 }),
): ScoredCandidate[] {
  return candidates
    .map((song, i) => ({ ...scoreCandidate(song, current, signalFor(song)), order: i }))
    .sort((a, b) => b.score - a.score || a.song.title.localeCompare(b.song.title) || a.order - b.order)
    .map(({ song, score, reasons }) => ({ song, score, reasons }));
}
