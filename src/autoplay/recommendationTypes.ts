// KNOX Autoplay — shared recommendation types.
//
// Queue marking: Song.queueSource distinguishes MANUAL vs AUTOPLAY entries
// (see src/core/types.ts). Manual items always win over autoplay items.

import type { Song } from '../core/types';

/** How a queue entry entered the queue. */
export type QueueSource = 'manual' | 'autoplay';

/** A scored recommendation candidate (pure — no I/O). */
export interface ScoredCandidate {
  song: Song;
  score: number;
  reasons: string[];
}

/** Extra user signals attached to a candidate for scoring. */
export interface CandidateSignals {
  /** True when the candidate is in the user's favorites/library. */
  isFavorite: boolean;
  /** Known play count (listening history / library stats). */
  playCount: number;
}

/** Options for recommendation generation. */
export interface RecommendationOptions {
  /** Max candidates to return, ranked best-first. Default 5. */
  limit?: number;
  /** Song ids that must never be recommended (queue + history). */
  excludeIds?: Set<string>;
  /** Recently played song ids (extra penalty — never immediate repeats). */
  recentIds?: Set<string>;
  /** Favorite song ids (small bonus — never auto-added to library). */
  favoriteIds?: Set<string>;
  /** Known play counts by song id (frequent plays are favored). */
  playCounts?: Map<string, number>;
  /**
   * Pre-collected candidate pool (tests / prefetch). When omitted, the
   * engine collects from local library + provider search infrastructure.
   */
  candidatePool?: Song[];
}

/** Result of one recommendation round. */
export interface RecommendationResult {
  /** Ranked candidates, best first (already filtered + playable). */
  candidates: Song[];
  /** Per-provider search failures (isolated — never fatal). */
  failures: string[];
}
