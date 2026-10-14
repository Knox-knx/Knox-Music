// KNOX Autoplay — public surface. The player store owns queue/playback
// state; this module only recommends WHAT plays next.

export type { QueueSource, ScoredCandidate, CandidateSignals, RecommendationOptions, RecommendationResult } from './recommendationTypes';
export { scoreCandidate, rankCandidates } from './candidateScoring';
export {
  isPlayableCandidate,
  resolvePlayableEquivalent,
  filterExcluded,
  getRecommendations,
  MAX_PROVIDER_SEARCHES,
  MAX_RESULTS_PER_SEARCH,
} from './recommendationEngine';
export {
  tryAcquireTransition,
  releaseTransition,
  isTransitionInProgress,
  recordRecommendation,
  recentRecommendationIds,
  wasRecentlyRecommended,
  isAutoplayEnabled,
  shouldAutoplayForMode,
  buildExclusionIds,
  getRecentPlayedIds,
  getLibrarySignals,
  getNextCandidates,
  prefetchFor,
  consumePrefetch,
  resetPrefetchFor,
  resetAutoplayState,
  MAX_AUTOPLAY_ATTEMPTS,
  MAX_RECOMMENDATION_HISTORY,
  PREFETCH_CACHE_TTL_MS,
  PREFETCH_CANDIDATE_LIMIT,
} from './autoPlayManager';
