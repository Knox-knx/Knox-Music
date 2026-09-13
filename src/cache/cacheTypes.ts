// Smart Playback Cache — types.
//
// Design note on §5 (storage layout): KNOX stores audio as IndexedDB Blobs
// (see `offline` table), never as raw files — there is no installation-dir
// filesystem to write to on web/Tauri. The spec's
// `cache/playback/<provider>/<track-id>.<ext>` layout therefore maps to a
// dedicated Dexie table (`smartcache`, keyed by stable song id) living in
// the same OS-appropriate app-data directory as everything else. The
// `.part → rename` atomicity requirement maps to "commit only complete
// entries in a single Dexie put" (uncommitted bytes are memory-only and can
// never become visible, even if the app closes mid-download).

/** Quality tier the Smart Cache aims for (provider permitting). */
export type SmartCacheQuality = 'Low' | 'Medium' | 'High';

/**
 * Smart Cache auto-clear policy (Settings → Playback → Smart Cache →
 * Auto-clear after playback). Default is "immediate": the entry is removed
 * right after its natural playback end. Delayed modes persist a cleanup
 * timestamp on the entry; "never" disables playback-triggered removal
 * (TTL/LRU/corruption/manual-clear rules still apply).
 */
export type SmartCacheAutoClear = 'immediate' | '1h' | '6h' | '24h' | 'never';

export const SMART_CACHE_AUTO_CLEAR_DEFAULT: SmartCacheAutoClear = 'immediate';

/** Valid auto-clear values (first entry is the default). */
export const SMART_CACHE_AUTO_CLEAR_VALUES: readonly SmartCacheAutoClear[] = [
  'immediate',
  '1h',
  '6h',
  '24h',
  'never',
] as const;

/** One committed Smart Cache row. `complete` is always true for stored rows:
 *  incomplete downloads are never persisted (atomic commit on completion).
 *
 *  Audio bytes are stored as `Uint8Array` (not Blob): both real IndexedDB
 *  and structured-clone engines round-trip ArrayBuffers losslessly, while
 *  Blob fidelity varies. A Blob is materialized only at playback time for
 *  the object URL handed to the AudioEngine. */
export interface SmartCacheEntry {
  /** Stable song id (`${providerId}:${providerTrackId}`) — the cache key. */
  id: string;
  provider: string;
  providerTrackId: string;
  title: string;
  artist: string;
  data: Uint8Array;
  mimeType: string;
  fileSize: number;
  /** Container/format derived from the MIME type (e.g. "mp3", "mp4"). */
  format: string;
  /** Honest quality label of the cached bytes (from the authorized stream). */
  quality: string;
  durationMs: number;
  cachedAt: number;
  lastPlayedAt: number;
  lastVerifiedAt: number;
  complete: true;
  /**
   * Persistent auto-clear deadline (epoch ms) recorded when a track
   * naturally ends under a delayed policy ("1h"/"6h"/"24h"). Null/undefined
   * means no pending playback-triggered cleanup. Stored on the same
   * `smartcache` row (no second DB) so cleanup survives restart.
   */
  autoClearAt?: number | null;
  /** Policy that scheduled `autoClearAt` (diagnostics only). */
  autoClearPolicy?: SmartCacheAutoClear | null;
}

/** Authorized cache source handed over from the playback path (no extra
 *  provider request is ever made to discover it). */
export interface SmartCacheSource {
  /** Download/cache URL — provider-authorized (download endpoint preferred). */
  url: string;
  quality: string;
  mimeType: string;
  /** True only when the provider license/terms permit local storage. */
  allowsOffline: boolean;
}

export interface SmartCacheStats {
  count: number;
  bytes: number;
}

/** Bandwidth-yield signal from the player (§2): the background download must
 *  never starve audible playback on thin links.
 *  - 'go': keep downloading (engine is playing this track).
 *  - 'wait': pause downloading (buffering / user paused) — resume shortly.
 *  - 'abort': stop the job (another track took over the engine). */
export type CacheYield = 'go' | 'wait' | 'abort';

export type SmartCacheSkipReason =
  | 'disabled'
  | 'use-cache-off'
  | 'already-local'
  | 'already-offline'
  | 'preview'
  | 'provider-forbidden'
  | 'license-forbids'
  | 'no-source'
  | 'radio';

export const SMART_CACHE_LOG = {
  HIT: 'SMART_CACHE_HIT',
  MISS: 'SMART_CACHE_MISS',
  START: 'SMART_CACHE_START',
  COMPLETE: 'SMART_CACHE_COMPLETE',
  FAILED: 'SMART_CACHE_FAILED',
  INVALID: 'SMART_CACHE_INVALID',
  EVICT: 'SMART_CACHE_EVICT',
  DISABLED: 'SMART_CACHE_DISABLED',
  VALIDATION_FAILED: 'cache_validation_failed',
  PLAYBACK_FAILED: 'cache_playback_failed',
  INVALIDATED: 'cache_invalidated',
  FRESH_RETRY: 'cache_fresh_retry',
  REPAIRED: 'cache_repaired',
  WRITE_SUCCESS: 'cache_write_success',
  WRITE_FAILED: 'cache_write_failed',
  HIT_EVENT: 'cache_hit',
} as const;
