// Smart Cache playback pipeline — lookup → validate → hit/miss.
//
// CACHE HIT:  track → lookup → validate → valid → local cached audio → play.
// CACHE MISS: track → lookup → missing/invalid → provider.getStream() →
//             fresh audio → validate → save cache → play.
// INVALID:    invalidate immediately → fresh provider request → rebuild →
//             play. A corrupted entry is never retried repeatedly.
//
// Cache COMMIT failures never fail playback: the in-memory bytes still
// play. Only validated bytes are committed (atomic single put).

import type { Song } from '../core/types';
import { logger } from '../core/logger';
import { inferMimeTypeFromUrl } from '../audio/mediaDiagnostics';
import { SMART_CACHE_LOG, type SmartCacheEntry } from './cacheTypes';
import { validateCacheBytes, validateCacheEntry, type CacheInvalidReason } from './cacheValidator';
import {
  getCacheEntry,
  putCacheEntry,
  removeCacheEntry,
  touchCacheEntry,
} from './cacheStorage';
import { enforceCacheLimits } from './cacheEviction';

export const CACHE_FETCH_TIMEOUT_MS = 60_000;
/** Hard cap per cached track (far above any real song, blocks bombs). */
export const CACHE_FILE_CAP = 100 * 1024 * 1024;

export type CacheLookup =
  | { status: 'hit'; entry: SmartCacheEntry }
  | { status: 'miss' }
  | { status: 'invalid'; reason: CacheInvalidReason };

/** Lookup + re-validate. Invalid entries are deleted immediately. */
export async function lookupCacheTrack(songId: string): Promise<CacheLookup> {
  const entry = await getCacheEntry(songId);
  if (!entry) return { status: 'miss' };
  const verdict = validateCacheEntry(entry);
  if (verdict.ok) {
    logger.debug('cache', SMART_CACHE_LOG.HIT, { id: songId });
    return { status: 'hit', entry };
  }
  // Auto-invalidate corrupted entries (§5): never serve or retry them.
  await removeCacheEntry(songId);
  logger.warn('cache', `${SMART_CACHE_LOG.INVALIDATED} (${verdict.reason})`, { id: songId });
  return { status: 'invalid', reason: verdict.reason ?? 'not-audio' };
}

export interface FetchedAudio {
  bytes: Uint8Array;
  mimeType: string;
  container: string;
}

async function readBounded(
  res: Response,
  signal: AbortSignal,
): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }> {
  const contentType = res.headers.get('content-type');
  const status = res.status;
  if (!res.ok && status !== 206) {
    throw new Error(`Smart Cache download failed (HTTP ${status})`);
  }
  if (!res.body) {
    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf) throw new Error('Smart Cache download failed (no body)');
    return { status, contentType, bytes: new Uint8Array(buf) };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    if (signal.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new DOMException('Smart Cache download superseded', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > CACHE_FILE_CAP) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error('Smart Cache file exceeds size cap');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { status, contentType, bytes: out };
}

/**
 * Download + validate provider bytes WITHOUT committing (commit is a
 * separate step so playback can proceed even if the cache write fails).
 * Throws on any failure — keeps nothing.
 */
export async function fetchBytesForCache(
  sourceUrl: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    sourceMimeType?: string;
  } = {},
): Promise<FetchedAudio> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CACHE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(sourceUrl, { signal: controller.signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        if (opts.signal?.aborted) throw new DOMException('Smart Cache download superseded', 'AbortError');
        throw new Error(`Smart Cache download timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Smart Cache download failed (${(e as Error)?.message ?? 'network error'})`);
    }
    const { status, contentType, bytes } = await readBounded(res, controller.signal);
    if (opts.signal?.aborted || controller.signal.aborted) {
      throw new DOMException('Smart Cache download superseded', 'AbortError');
    }
    void status;
    const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
    const mimeHint = ct || opts.sourceMimeType || '';
    const verdict = validateCacheBytes(bytes, mimeHint || undefined);
    if (!verdict.ok) {
      throw new Error(`Smart Cache download is not audio (${verdict.reason})`);
    }
    return { bytes, mimeType: verdict.mime!, container: verdict.container! };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export interface CacheCommit {
  committed: boolean;
  evicted?: number;
}

/**
 * Validate + commit bytes for a track (atomic single put). Commit problems
 * are logged, never thrown — playback proceeds from memory regardless.
 */
export async function storeCacheTrack(
  song: Pick<Song, 'id' | 'providerId' | 'providerTrackId' | 'title' | 'artist' | 'durationMs'>,
  audio: FetchedAudio,
  opts: { quality?: string; maxBytes: number; ttlDays: number },
): Promise<CacheCommit> {
  try {
    const recheck = validateCacheBytes(audio.bytes, audio.mimeType);
    if (!recheck.ok) {
      logger.warn('cache', `${SMART_CACHE_LOG.VALIDATION_FAILED} (${recheck.reason})`, { id: song.id });
      return { committed: false };
    }
    const entry: SmartCacheEntry = {
      id: song.id,
      provider: song.providerId,
      providerTrackId: song.providerTrackId,
      title: song.title,
      artist: song.artist,
      data: audio.bytes,
      mimeType: audio.mimeType,
      fileSize: audio.bytes.byteLength,
      format: audio.container,
      quality: opts.quality ?? audio.mimeType,
      durationMs: song.durationMs,
      cachedAt: Date.now(),
      lastPlayedAt: Date.now(),
      lastVerifiedAt: Date.now(),
      complete: true,
    };
    try {
      await putCacheEntry(entry);
    } catch {
      // Likely quota: evict aggressively (except this track) and retry once.
      const { evicted } = await enforceCacheLimits({ maxBytes: Math.floor(opts.maxBytes / 4), ttlDays: 0 });
      void evicted;
      await putCacheEntry(entry);
    }
    await enforceCacheLimits({ maxBytes: opts.maxBytes, ttlDays: opts.ttlDays, excludeId: song.id }).catch(
      () => undefined,
    );
    logger.debug('cache', SMART_CACHE_LOG.WRITE_SUCCESS, { id: song.id });
    return { committed: true };
  } catch (e) {
    logger.warn('cache', `${SMART_CACHE_LOG.WRITE_FAILED}`, String(e).slice(0, 160));
    return { committed: false };
  }
}

/** Preferred MIME for a source URL (honest inference, bytes authoritative). */
export function mimeForSourceUrl(sourceUrl: string, fallback = 'audio/mpeg'): string {
  return inferMimeTypeFromUrl(sourceUrl, fallback);
}

export async function touchCacheTrack(id: string): Promise<void> {
  await touchCacheEntry(id);
}
