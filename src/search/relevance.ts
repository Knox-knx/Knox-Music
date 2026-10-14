// Relevance scoring with explicit match types.
//
// A same-title track with a DIFFERENT artist must never be treated as an
// exact match ("Mi Gente — David Tumax" is not "Mi Gente — J Balvin").
// Confidence comes only from comparing the parsed query against the
// provider-returned metadata — never fabricated.

import { normalizeKeyPart, foldedEquals } from './normalizeQuery';
import type { ParsedQuery } from './queryParser';

export type MatchType = 'exact' | 'strong' | 'partial' | 'related';

export interface Relevance {
  relevanceScore: number; // 0–100
  matchType: MatchType;
}

export interface ScorableTrack {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
}

/**
 * Bounded Levenshtein distance with early exit past `cap`.
 * Used ONLY for single-token typo tolerance (hardy↔harrdy), never for
 * whole-string matching — completely different names never fuzzy-match.
 */
export function tokenDistance(a: string, b: string, cap = 2): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > cap) return cap + 1;
  if (la === 0 || lb === 0) return Math.max(la, lb);
  let prev: number[] = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    let cur0 = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur0 + 1, prev[j - 1] + cost);
      prev[j - 1] = cur0;
      cur0 = v;
      if (v < rowMin) rowMin = v;
    }
    prev[lb] = cur0;
    if (rowMin > cap) return cap + 1;
  }
  return prev[lb];
}

/**
 * Single-token typo tolerance: identical, or edit distance ≤1 for tokens
 * of length ≥4 (≤2 for length ≥8). Short tokens (≤3) must match exactly —
 * initials like "j" never fuzzy-match. "david" never matches "balvin".
 */
export function tokenFuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  if (m < 4) return false;
  const allowed = m >= 8 ? 2 : 1;
  return tokenDistance(a, b, allowed) <= allowed;
}

/**
 * True when every significant query-side token is covered by a distinct
 * track-side token (byte-equal or typo-equal). Extra track tokens (featured
 * artists) are allowed; missing query tokens are not. Order-independent.
 */
export function tokensCover(haystack: string, needle: string): boolean {
  const h = haystack.split(' ').filter((w) => w.length > 1);
  const n = needle.split(' ').filter((w) => w.length > 1);
  if (n.length === 0) return false;
  const remaining = [...h];
  for (const qw of n) {
    const i = remaining.findIndex((tw) => tokenFuzzyEqual(tw, qw));
    if (i < 0) return false;
    remaining.splice(i, 1);
  }
  return true;
}

/**
 * Strict title equality modulo typos: same significant-token count AND full
 * mutual cover. "soch" never equals "soch na sake" (different songs), but
 * "soch" equals "soch" and "blinding lights" equals "blinding light".
 */
export function tokensEqualSet(a: string, b: string): boolean {
  const ta = a.split(' ').filter((w) => w.length > 1);
  const tb = b.split(' ').filter((w) => w.length > 1);
  if (ta.length === 0 || ta.length !== tb.length) return false;
  return tokensCover(a, b) && tokensCover(b, a);
}

/**
 * Score one track against a parsed query.
 *
 * Priority:
 *  1. Exact title + exact artist          → exact (100 byte-equal, 97 typo-tolerant)
 *  2. Exact title                          → strong (80–94, penalized if artist mismatches)
 *  3. Exact artist                         → strong (75–84)
 *  4. Title starts with query              → strong/partial
 *  5. Artist starts with query             → partial
 *  6. Title contains query                 → partial
 *  7. Artist contains query                → partial
 *  8. Album match                          → related
 *  9. Tags/categories (genre)              → related
 * 10. Weak metadata match                  → related (low score)
 */
export function scoreTrack(track: ScorableTrack, parsed: ParsedQuery): Relevance {
  const q = parsed.full;
  if (!q) return { relevanceScore: 0, matchType: 'related' };

  const title = normalizeKeyPart(track.title);
  const artist = normalizeKeyPart(track.artist);
  const album = normalizeKeyPart(track.album);
  const genre = normalizeKeyPart(track.genre);

  if (!title && !artist) return { relevanceScore: 0, matchType: 'related' };

  // --- 1. Exact title + exact artist over any hypothesis -------------------
  // Byte-equal on both sides → 100. One side byte-equal and the other
  // token-fuzzy (provider spelling "Harrdy Sandhu" vs query "hardy sandhu",
  // featured-artist extras) → still exact at 97: the SAME song was found,
  // only the spelling/credit differs by a typo. Completely different names
  // (Mi Gente — David Tumax vs J Balvin) never satisfy tokensCover.
  for (const h of parsed.hypotheses) {
    if (!h.title || !h.artist) continue;
    const titleByte = foldedEquals(title, h.title) || foldedEquals(artist, h.title);
    const artistByte = foldedEquals(artist, h.artist) || foldedEquals(title, h.artist);
    if (titleByte && artistByte) {
      return { relevanceScore: 100, matchType: 'exact' };
    }
    const titleOk = titleByte
      || (!!title && !!h.title && tokensEqualSet(title, h.title));
    const artistOk = artistByte
      || (!!artist && !!h.artist && (tokensCover(artist, h.artist) || tokensCover(h.artist, artist)));
    if (titleOk && artistOk) {
      return { relevanceScore: 97, matchType: 'exact' };
    }
  }

  const titleExact = foldedEquals(title, q);
  const artistExact = foldedEquals(artist, q);

  // --- 2. Exact title -------------------------------------------------------
  // Penalize when a hypothesis names an artist that does NOT match this
  // track's artist: same title, wrong artist is not an exact match.
  if (titleExact) {
    let penalty = 0;
    for (const h of parsed.hypotheses) {
      if (h.title && foldedEquals(title, h.title) && h.artist) {
        if (artist && !foldedEquals(artist, h.artist) && !artist.includes(h.artist) && !h.artist.includes(artist)
          && !tokensCover(artist, h.artist) && !tokensCover(h.artist, artist)) {
          penalty = Math.max(penalty, 25);
        }
      }
    }
    const score = 90 - penalty;
    return {
      relevanceScore: score,
      matchType: penalty > 0 ? 'strong' : 'exact',
    };
  }

  // --- 3. Exact artist ------------------------------------------------------
  if (artistExact) return { relevanceScore: 82, matchType: 'strong' };
  // Typo-tolerant artist-only queries ("hardy sandhu" → Harrdy Sandhu
  // tracks): same strong tier, two points below byte-exact.
  if (!!artist && !!q && (tokensCover(artist, q) || tokensCover(q, artist))) {
    return { relevanceScore: 80, matchType: 'strong' };
  }

  // --- 4–7. Starts-with / contains ------------------------------------------
  const titleStarts = title.startsWith(q) || q.startsWith(title);
  const artistStarts = artist.startsWith(q) || (!!artist && !!q && q.startsWith(artist));
  const titleContains = !!title && !!q && (title.includes(q) || q.includes(title));
  const artistContains = !!artist && !!q && (artist.includes(q) || q.includes(artist));

  // Multi-word hypothesis agreement boosts partials into strong.
  let hypothesisBonus = 0;
  for (const h of parsed.hypotheses) {
    if (!h.title || !h.artist) continue;
    const tHit = title.includes(h.title) || h.title.includes(title);
    const aHit = artist.includes(h.artist) || h.artist.includes(artist);
    if (tHit && aHit) hypothesisBonus = Math.max(hypothesisBonus, 12);
    else if (tHit || aHit) hypothesisBonus = Math.max(hypothesisBonus, 4);
  }

  if (titleStarts && artistContains) {
    return { relevanceScore: Math.min(88, 78 + hypothesisBonus), matchType: 'strong' };
  }
  if (titleStarts) {
    return { relevanceScore: Math.min(84, 70 + hypothesisBonus), matchType: hypothesisBonus >= 12 ? 'strong' : 'partial' };
  }
  if (artistStarts) {
    return { relevanceScore: 64, matchType: 'partial' };
  }
  if (titleContains && artistContains) {
    return { relevanceScore: Math.min(80, 66 + hypothesisBonus), matchType: 'strong' };
  }
  if (titleContains) {
    return { relevanceScore: Math.min(72, 58 + hypothesisBonus), matchType: 'partial' };
  }
  if (artistContains) {
    return { relevanceScore: 54, matchType: 'partial' };
  }

  // --- 8. Album match --------------------------------------------------------
  if (album && (album.includes(q) || q.includes(album))) {
    return { relevanceScore: 38, matchType: 'related' };
  }

  // --- 9. Tags / categories ---------------------------------------------------
  if (genre && (genre.includes(q) || q.includes(genre))) {
    return { relevanceScore: 28, matchType: 'related' };
  }

  // --- 10. Weak word-overlap fallback -----------------------------------------
  const qWords = new Set(q.split(' ').filter((w) => w.length > 2));
  if (qWords.size > 0) {
    const hay = `${title} ${artist} ${album}`;
    let hits = 0;
    for (const w of qWords) if (hay.includes(w)) hits++;
    if (hits > 0) {
      const score = Math.min(24, Math.round((hits / qWords.size) * 24));
      return { relevanceScore: score, matchType: 'related' };
    }
  }

  return { relevanceScore: 0, matchType: 'related' };
}
