// Web Discovery — music page matching.
//
// A page is not a match for one keyword. Scores title/artist/album/
// duration/query-token overlap + structured-metadata confidence.
// Strong match: title=Soch + artist=Hardy Sandhu for query
// "hardy sandhu soch". Weak: same title, different artist → rejected.

import { normalizeKeyPart } from '../../search/normalizeQuery';
import { parseQuery } from '../../search/queryParser';
import { scoreTrack } from '../../search/relevance';
import type { WebCandidate } from './types';

export interface PageMatch {
  confidence: number; // 0–100
  kind: 'exact' | 'strong' | 'partial' | 'none';
}

/** Score one candidate against the raw query (pure). */
export function scoreWebCandidate(candidate: WebCandidate, rawQuery: string): PageMatch {
  const parsed = parseQuery(rawQuery);
  const { relevanceScore, matchType } = scoreTrack(
    { title: candidate.title, artist: candidate.artist, album: candidate.album },
    parsed,
  );
  // Duration + token-overlap refine (never override the text verdict alone).
  let confidence = relevanceScore;
  const q = parsed.full;
  if (q && candidate.title) {
    const qTokens = new Set(q.split(' ').filter((w) => w.length > 2));
    const hay = `${normalizeKeyPart(candidate.title)} ${normalizeKeyPart(candidate.artist)} ${normalizeKeyPart(candidate.album ?? '')}`;
    if (qTokens.size > 0) {
      let hits = 0;
      for (const w of qTokens) if (hay.includes(w)) hits++;
      // Require at least half the significant tokens for strong+.
      if (hits === 0) confidence = Math.min(confidence, 10);
      else if (hits / qTokens.size < 0.5 && confidence > 60) confidence = 55;
    }
  }
  // Structured metadata confidence nudges ties only.
  confidence = Math.min(100, Math.round(confidence + candidate.metadataConfidence * 4));
  if (matchType === 'exact' && confidence < 85) confidence = 85;
  const kind: PageMatch['kind'] =
    confidence >= 85 ? 'exact' : confidence >= 65 ? 'strong' : confidence >= 35 ? 'partial' : 'none';
  return { confidence, kind };
}

/** Reject unrelated pages (same title, different artist etc.). */
export function isMusicMatch(candidate: WebCandidate, rawQuery: string, minConfidence = 35): boolean {
  if (!candidate.title && !candidate.artist) return false;
  const m = scoreWebCandidate(candidate, rawQuery);
  return m.confidence >= minConfidence && m.kind !== 'none';
}
