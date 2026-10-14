// Smart Cache — public surface (reconstructed, CASE D).
//
// Persistent playback cache: automatic, disposable, bounded. STRICTLY
// separate from `offline` (user-owned permanent downloads) — a cache
// entry NEVER renders as "Available Offline".

export type {
  SmartCacheQuality,
  SmartCacheEntry,
  SmartCacheSource,
  SmartCacheStats,
  SmartCacheSkipReason,
  SmartCacheAutoClear,
  CacheYield,
} from './cacheTypes';
export {
  SMART_CACHE_AUTO_CLEAR_DEFAULT,
  SMART_CACHE_AUTO_CLEAR_VALUES,
} from './cacheTypes';
export { SMART_CACHE_LOG } from './cacheTypes';
export {
  validateCacheBytes,
  validateCacheEntry,
  SMART_CACHE_MIN_BYTES,
  type CacheInvalidReason,
  type CacheValidation,
} from './cacheValidator';
export {
  getCacheEntry,
  putCacheEntry,
  removeCacheEntry,
  clearCacheEntries,
  countCacheEntries,
  totalCacheBytes,
  listCacheByRecency,
  touchCacheEntry,
  setCacheAutoClearAt,
  clearCacheAutoClearAt,
  listDueAutoClearEntries,
} from './cacheStorage';
export {
  enforceCacheLimits,
  type EvictionPolicy,
  type EvictionResult,
} from './cacheEviction';
export {
  lookupCacheTrack,
  fetchBytesForCache,
  storeCacheTrack,
  touchCacheTrack,
  mimeForSourceUrl,
  CACHE_FETCH_TIMEOUT_MS,
  CACHE_FILE_CAP,
  type CacheLookup,
  type FetchedAudio,
  type CacheCommit,
} from './cachePlayback';
export {
  isSmartCacheEnabled,
  smartCacheLimits,
  clearSmartCache,
  smartCacheStats,
} from './smartCache';
export {
  SMART_CACHE_AUTO_CLEAR_LOG,
  cancelSmartCacheAutoClear,
  getSmartCacheAutoClear,
  handleSmartCacheNaturalEnded,
  normalizeSmartCacheAutoClear,
  runSmartCacheAutoClearMaintenance,
  safeAutoClearTrackId,
  smartCacheAutoClearDelayMs,
  verifyNaturalEndedForAutoClear,
  type NaturalEndedVerification,
} from './smartCacheAutoClear';
