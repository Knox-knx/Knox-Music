// Smart Cache validation — pure, side-effect free.
//
// Every cache HIT is re-validated before playback (the historical 0:00
// class: stale/corrupted entries, truncated downloads, HTML error pages
// stored as audio). Invalid entries are auto-invalidated by the caller —
// a corrupted entry is never retried repeatedly.

import {
  detectAudioContainer,
  isDefinitelyNotAudio,
  isPlayableAudioMime,
  looksLikeAudioBytes,
} from '../audio/mediaDiagnostics';
import type { SmartCacheEntry } from './cacheTypes';

/** Minimum persisted audio payload (mirrors TEMP_MIN_BYTES semantics). */
export const SMART_CACHE_MIN_BYTES = 1024;

export type CacheInvalidReason =
  | 'empty'
  | 'truncated'
  | 'not-audio'
  | 'unknown-container'
  | 'size-mismatch'
  | 'bad-mime';

export interface CacheValidation {
  ok: boolean;
  reason?: CacheInvalidReason;
  container?: string;
  mime?: string;
}

/**
 * Validate raw audio bytes before they enter the cache or the element.
 * Rejects empty/truncated payloads, HTML/JSON error pages, and
 * definitely-non-audio MIME — the historical silent-0:00 class. A
 * recognized container is recorded when detectable; otherwise the
 * <audio> element stays authoritative (as before) and the bytes are
 * still cached. Re-validation on every HIT applies the same rule, so a
 * HIT can never flip to a different verdict than its MISS commit.
 */
export function validateCacheBytes(
  bytes: Uint8Array | null | undefined,
  mimeType?: string,
): CacheValidation {
  if (!bytes || bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  if (bytes.byteLength < SMART_CACHE_MIN_BYTES) return { ok: false, reason: 'truncated' };
  const head = bytes.slice(0, Math.min(512, bytes.byteLength));
  if (!looksLikeAudioBytes(head)) return { ok: false, reason: 'not-audio' };
  if (mimeType && isDefinitelyNotAudio(mimeType)) return { ok: false, reason: 'bad-mime' };
  const detected = detectAudioContainer(head);
  if (!detected) return { ok: false, reason: 'unknown-container' };
  let mime = mimeType && isPlayableAudioMime(mimeType) ? mimeType.split(';')[0].trim() : '';
  if (!mime) mime = detected.mime ?? 'audio/mpeg';
  return { ok: true, container: detected.container, mime };
}

/** Validate a committed cache row (shape + bytes re-sniffed every hit). */
export function validateCacheEntry(entry: SmartCacheEntry | null | undefined): CacheValidation {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'empty' };
  if (entry.complete !== true) return { ok: false, reason: 'truncated' };
  if (!entry.data || entry.data.byteLength === 0) return { ok: false, reason: 'empty' };
  if (entry.fileSize !== entry.data.byteLength) return { ok: false, reason: 'size-mismatch' };
  return validateCacheBytes(entry.data, entry.mimeType);
}
