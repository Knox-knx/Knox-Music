import { getDb } from '../data/db';
import type { Song } from '../core/types';
import { logger } from '../core/logger';
import { detectAudioContainer, looksLikeAudioBytes } from '../audio/mediaDiagnostics';
import { extensionOf } from './metadata';

/**
 * Local-file bytes persistence (§11 root-cause fix).
 *
 * Root cause: imported songs stored their `blob:` object URL as `streamUrl`
 * in the songs table. Blob URLs are revoked on every restart, so after a
 * relaunch the element received a DEAD url and reported the generic
 * MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) — surfaced as "Can't play this
 * format" even when the codec itself was perfectly fine. DjBaap / FUNK
 * UNIVERSO failed every time for exactly this reason, not because of their
 * containers.
 *
 * Fix: the raw File bytes persist in the `localFiles` table at import time.
 * Playback mints a FRESH object URL from those bytes per session (correct
 * MIME type, never a stale URL). Files whose bytes were never persisted
 * (imported before this fix) fail explicitly with "re-scan" guidance —
 * never a misleading format error.
 */

const MAX_PERSIST_BYTES = 400 * 1024 * 1024;

function mimeForExtension(ext: string, fallback: string): string {
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': case 'mp4': case 'm4b': case 'aac': return 'audio/mp4';
    case 'ogg': case 'oga': return 'audio/ogg';
    case 'opus': return 'audio/ogg; codecs=opus';
    case 'flac': return 'audio/flac';
    case 'wav': return 'audio/wav';
    case 'webm': case 'weba': return 'audio/webm';
    default: return fallback || 'audio/mpeg';
  }
}

/** Persist raw audio bytes for one local song (best-effort, never throws). */
export async function saveLocalFileBytes(songId: string, file: File): Promise<boolean> {
  try {
    if (!songId || !(file instanceof Blob)) return false;
    if (file.size <= 0 || file.size > MAX_PERSIST_BYTES) {
      logger.warn('scanner', `local bytes not persisted for ${songId} (size ${file.size})`);
      return false;
    }
    const ext = extensionOf(file.name);
    const mime = file.type || mimeForExtension(ext, 'audio/mpeg');
    await getDb().localFiles.put({
      id: songId,
      blob: file,
      mimeType: mime,
      fileSize: file.size,
      fileName: file.name,
      updatedAt: Date.now(),
    });
    return true;
  } catch (e) {
    logger.warn('scanner', `local bytes persist failed for ${songId}`, String(e));
    return false;
  }
}

/** Raw persisted bytes for one local song (undefined when never imported). */
export async function getLocalFileBytes(songId: string): Promise<Blob | undefined> {
  try {
    const row = await getDb().localFiles.get(songId);
    if (!row?.blob || row.blob.size <= 0) return undefined;
    return row.blob;
  } catch {
    return undefined;
  }
}

/** True when persisted bytes exist for this song. */
export async function hasLocalFileBytes(songId: string): Promise<boolean> {
  return (await getLocalFileBytes(songId)) !== undefined;
}

export interface LocalSniff {
  size: number;
  ext: string;
  detected: string | null;
  mime: string | null;
  /** File is empty/truncated — decode can never succeed. */
  truncated: boolean;
  /** Bytes are an HTML/JSON error page mislabeled as audio. */
  errorPage: boolean;
}

/**
 * Diagnose actual bytes (§11): extension vs real container (magic bytes),
 * size/completeness, error-page masquerade. Pure read of the first 512
 * bytes — never executes content, never logs paths/URLs.
 */
export async function sniffLocalBytes(blob: Blob, nameOrPath?: string): Promise<LocalSniff> {
  const size = blob.size;
  const ext = extensionOf(nameOrPath ?? '');
  if (size <= 0 || size < 256) {
    return { size, ext, detected: null, mime: null, truncated: true, errorPage: false };
  }
  try {
    const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    if (!looksLikeAudioBytes(head)) {
      return { size, ext, detected: null, mime: null, truncated: false, errorPage: true };
    }
    const d = detectAudioContainer(head);
    return {
      size, ext,
      detected: d?.container ?? null,
      mime: d?.mime ?? null,
      truncated: false,
      errorPage: false,
    };
  } catch {
    return { size, ext, detected: null, mime: null, truncated: false, errorPage: false };
  }
}

/** Log the §11 diagnosis line (scrubbed filename only, never URLs). */
export function logLocalDiagnosis(song: Song, sniff: LocalSniff, extra?: string): void {
  try {
    const base = (song.localPath || song.title || 'unknown').split('/').pop() || 'unknown';
    logger.error('player',
      `local diagnosis ext=.${sniff.ext || '?'} detected=${sniff.detected ?? 'unknown'} mime=${sniff.mime ?? 'n/a'} size=${sniff.size}${sniff.truncated ? ' TRUNCATED' : ''}${sniff.errorPage ? ' ERROR_PAGE' : ''} file=${base}${extra ? ` ${extra}` : ''}`);
  } catch { /* diagnostics never break playback */ }
}

/**
 * Mint a FRESH playable object URL from persisted bytes (correct MIME).
 * Returns null when no bytes are stored (pre-fix import or deleted file) —
 * the caller must then fail explicitly with re-scan guidance.
 */
export async function freshLocalObjectUrl(song: Song): Promise<{ url: string; mimeType: string; sniff: LocalSniff } | null> {
  const blob = await getLocalFileBytes(song.id);
  if (!blob) return null;
  const sniff = await sniffLocalBytes(blob, song.localPath || song.title);
  if (sniff.truncated || sniff.errorPage) {
    logLocalDiagnosis(song, sniff, 'bytes unusable');
    return null;
  }
  const ext = sniff.ext || extensionOf(song.localPath || song.title);
  const mime = sniff.mime || mimeForExtension(ext, (blob as File).type || 'audio/mpeg');
  try {
    const typed = blob instanceof Blob
      ? new Blob([blob], { type: mime.split(';')[0].trim() || 'audio/mpeg' })
      : blob;
    const url = URL.createObjectURL(typed);
    // Keep the row's streamUrl fresh for this session (in-memory truth;
    // persisted too so the current session never re-mints per tap).
    try {
      const { songRepo } = await import('../data/repositories');
      await songRepo.upsert({ ...song, streamUrl: url });
    } catch { /* row update best-effort */ }
    return { url, mimeType: mime, sniff };
  } catch {
    return null;
  }
}
