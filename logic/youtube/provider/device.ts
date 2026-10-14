// On-device YouTube bridge — renderer side of the native extraction host.
//
// Used ONLY when the loopback sidecars are unreachable (the Android APK
// ships no Python/Node sidecars; desktop with sidecars stopped also falls
// back here). Desktop with healthy sidecars never touches this module —
// the sidecar pipeline stays the preferred path.

import type { Song } from '../../core/types';
import { logger } from '../../core/logger';
import { offlineRepo, songRepo } from '../../data/repositories';
import type { YouTubeSearchResult } from './types';
import {
  getPermanentYouTubeEntry,
  isValidYouTubeVideoId,
  reportYouTubeStage,
  validateYouTubeAudioBytes,
  youtubeSongId,
  youtubeVideoIdOf,
} from './youtubeOffline';

function isTauriDevice(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    return (
      typeof window !== 'undefined' &&
      (w.__TAURI_INTERNALS__ !== undefined || w.__TAURI__ !== undefined)
    );
  } catch {
    return false;
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

interface NativeResult {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  url: string;
  live: boolean;
  thumbnails: { url: string; width: number; height: number }[];
}

interface NativeAudio {
  videoId: string;
  mime: string;
  ext: string;
  sizeBytes: number;
  base64: string;
  filePath: string;
}

interface NativeStatus {
  ok: boolean;
  detail: string;
}

/** True when the native on-device path can be attempted (Tauri shell). */
export function canUseNativeYouTube(): boolean {
  return isTauriDevice();
}

// Lightweight duration cache: search rows render instantly with –:–– and
// fill in as player-API lengths arrive. Bounded (latest 300 ids) so a long
// search session never grows memory without limit.
const durationCache = new Map<string, number>();

/**
 * Real track length (seconds) without downloading any bytes. Returns null
 * when the length is unknown (bot-gated client, live stream, invalid id) —
 * callers keep –:–– instead of guessing.
 */
export async function nativeDuration(videoId: string): Promise<number | null> {
  const v = String(videoId ?? '').replace(/^youtube:/, '');
  if (!isValidYouTubeVideoId(v)) return null;
  const hit = durationCache.get(v);
  if (typeof hit === 'number' && hit > 0) return hit;
  if (!isTauriDevice()) return null;
  try {
    const secs = await invoke<number>('knox_yt_duration', { videoId: v });
    if (typeof secs === 'number' && secs > 0 && secs <= 24 * 3600) {
      if (durationCache.size >= 300) {
        const oldest = durationCache.keys().next().value;
        if (oldest !== undefined) durationCache.delete(oldest);
      }
      durationCache.set(v, secs);
      return secs;
    }
  } catch {
    /* unknown length — row keeps –:–– */
  }
  return null;
}

/**
 * Tauri IPC rejects commands with the Rust `Err(String)` as a PLAIN STRING,
 * not an Error instance. Every `e instanceof Error ? e : fallback` in this
 * pipeline silently replaced the real cause (e.g. "HTTP 403") with a generic
 * message — the APK showed only "YouTube download failed" for every track.
 * Always preserve string rejections.
 */
export function nativeErrorOf(e: unknown, fallback: string): Error {
  if (e instanceof Error) return e;
  if (typeof e === 'string' && e.trim()) return new Error(e.trim().slice(0, 500));
  return new Error(fallback);
}

/** Native availability probe (cheap — no search, no download). */
export async function nativeHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const s = await invoke<NativeStatus>('knox_yt_status');
    if (s && s.ok === true) return { ok: true, detail: 'ready (on-device extraction)' };
    return { ok: false, detail: typeof s?.detail === 'string' && s.detail ? s.detail.slice(0, 200) : 'On-device extraction unavailable' };
  } catch (e) {
    return { ok: false, detail: 'On-device extraction unavailable' };
  }
}

/**
 * Metadata-only search through the native host. Returns the same
 * `YouTubeSearchResult` shape as the sidecar so the existing mapper,
 * filters, and UI work unchanged. Throws on failure (caller falls back
 * to / surfaces the sidecar error).
 */
export async function nativeSearch(query: string, limit = 25): Promise<YouTubeSearchResult[]> {
  const q = (query ?? '').trim().slice(0, 400);
  if (!q) return [];
  const n = Math.max(1, Math.min(60, limit));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const results = await invoke<NativeResult[]>('knox_yt_search', { query: q, limit: n });
    if (!Array.isArray(results)) return [];
    return results
      .filter((r) => r && isValidYouTubeVideoId(String(r.id ?? '').replace(/^youtube:/, '')))
      .map((r) => ({
        id: String(r.id).replace(/^youtube:/, ''),
        title: String(r.title ?? 'Unknown'),
        channel: String(r.channel ?? 'Unknown'),
        duration: typeof r.duration === 'number' && r.duration > 0 ? r.duration : null,
        url: String(r.url || ''),
        live: r.live === true,
        thumbnails: Array.isArray(r.thumbnails)
          ? r.thumbnails
              .filter((t) => t && t.url)
              .map((t) => ({ url: String(t.url), width: Number(t.width) || 0, height: Number(t.height) || 0 }))
          : undefined,
      }));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function b64ToBytes(b64: string): Uint8Array {
  // Chunked atob: a single atob() on a ~33MB base64 string (25MB audio cap)
  // OOMs / throws in mobile WebViews. 32KB slices stay well under the limit
  // and produce identical bytes.
  const CHUNK = 0x8000;
  const total = b64.length;
  // First pass: decode length without holding two giant strings at once.
  let outLen = 0;
  const parts: Uint8Array[] = [];
  for (let i = 0; i < total; i += CHUNK) {
    const slice = b64.slice(i, i + CHUNK);
    const bin = atob(slice);
    const chunk = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j += 1) chunk[j] = bin.charCodeAt(j);
    parts.push(chunk);
    outLen += chunk.length;
  }
  const out = new Uint8Array(outLen);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Duplicate-download protection: concurrent ensure() calls for the same
// `youtube:<videoId>` share one native run. Mirrors youtubeOffline's map.
const nativeInFlight = new Map<string, Promise<PermanentYouTubeAsset>>();

export interface PermanentYouTubeAsset {
  blob: Blob;
  objectUrl: string;
  mimeType: string;
  sizeBytes: number;
  fromCache: boolean;
}

/**
 * Download-first permanent resolve through the native host. Permanent
 * offline hits reuse the committed Blob (no host call at all); misses run
 * one native extraction, validate the bytes, and commit them to the same
 * `offlineRepo` + `songRepo` truth the sidecar path uses — replays are
 * identical regardless of which backend fetched first.
 */
export async function ensureNativeYouTubeTrack(song: Song): Promise<PermanentYouTubeAsset> {
  const videoId = youtubeVideoIdOf(song);
  if (!videoId) throw new Error('YouTube download failed (invalid video)');
  const songId = youtubeSongId(videoId);

  const existing = await getPermanentYouTubeEntry(videoId).catch(() => undefined);
  if (existing) {
    const isWebm = (existing.mimeType || '').includes('webm') || (existing.blob?.type || '').includes('webm');
    if (isWebm) {
      logger.warn('youtube', `Purging old WebM offline file for ${songId} to download clean MP4/AAC`);
      await offlineRepo.remove(songId).catch(() => undefined);
    } else {
      reportYouTubeStage(songId, 'ready');
      return {
        blob: existing.blob,
        objectUrl: offlineRepo.objectUrl(songId, existing.blob),
        mimeType: existing.mimeType || existing.blob.type || 'audio/mp4',
        sizeBytes: existing.fileSize || existing.blob.size,
        fromCache: true,
      };
    }
  }

  const shared = nativeInFlight.get(songId);
  if (shared) return shared;

  const job = (async (): Promise<PermanentYouTubeAsset> => {
    reportYouTubeStage(songId, 'preparing');
    let res: NativeAudio;
    try {
      reportYouTubeStage(songId, 'downloading');
      res = await invoke<NativeAudio>('knox_yt_audio', { videoId });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw nativeErrorOf(e, 'YouTube download failed');
    }
    if (!res || typeof res.base64 !== 'string' || !res.base64) {
      throw new Error('YouTube download failed (empty response)');
    }
    reportYouTubeStage(songId, 'validating');
    const bytes = b64ToBytes(res.base64);
    const mime = (res.mime || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
    const verdict = validateYouTubeAudioBytes(bytes, mime);
    if (!verdict.ok) {
      logger.error('youtube', `Native audio validation failed (${verdict.reason})`);
      throw new Error('Audio validation failed');
    }
    reportYouTubeStage(songId, 'saving');
    const blob = new Blob([bytes as unknown as BlobPart], { type: verdict.mime ?? 'audio/mp4' });
    const inDb = await songRepo.get(songId).catch(() => undefined);
    const inOff = await offlineRepo.get(songId).catch(() => undefined);
    const bestTitle = (song.title && song.title !== 'YouTube Video') ? song.title
      : (inDb?.title && inDb.title !== 'YouTube Video') ? inDb.title
      : (inOff?.title && inOff.title !== 'YouTube Video') ? inOff.title
      : song.title;
    const bestArtist = (song.artist && song.artist !== 'Unknown') ? song.artist
      : (inDb?.artist && inDb.artist !== 'Unknown') ? inDb.artist
      : (inOff?.artist && inOff.artist !== 'Unknown') ? inOff.artist
      : song.artist;
    const committedSong: Song = {
      ...song,
      id: songId,
      providerId: 'youtube',
      providerTrackId: videoId,
      title: bestTitle,
      artist: bestArtist,
      isOfflineAvailable: true,
    };
    await offlineRepo.put(committedSong, blob, 'MP3 (YouTube)');
    await songRepo.upsert({ ...committedSong, isOfflineAvailable: true }).catch(() => undefined);
    logger.info('youtube', `native youtube saved (${songId} bytes=${blob.size})`);
    reportYouTubeStage(songId, 'ready');
    return {
      blob,
      objectUrl: offlineRepo.objectUrl(songId, blob),
      mimeType: verdict.mime ?? 'audio/mpeg',
      sizeBytes: blob.size,
      fromCache: false,
    };
  })();

  nativeInFlight.set(songId, job);
  try {
    return await job;
  } finally {
    if (nativeInFlight.get(songId) === job) nativeInFlight.delete(songId);
  }
}
