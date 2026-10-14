// Permanent YouTube offline storage — download-first, replay without network.
//
// Two separate concepts (never conflated):
//   A. Smart Cache (`smartcache` table) — temporary, TTL/LRU/auto-clear.
//   B. Permanent YouTube offline (`offline` table + `songs` metadata) —
//      user-requested persistent local file. Survives restart, Smart Cache
//      clear/auto-clear, and internet loss. Smart Cache NEVER deletes it.
//
// Resolution order for YouTube playback:
//   Permanent offline file → download if missing (never Smart Cache, never a
//   second temporary copy when the permanent copy exists).
//
// The sidecar owns the yt-dlp/FFmpeg pipeline and the on-disk atomic
// `.part → rename` publish. This module owns the renderer-side permanent
// truth: fetch the validated MP3 bytes from the sidecar ONCE, validate them
// again (magic bytes, size, MIME — never HTML/JSON), then commit them
// atomically to `offlineRepo` + `songRepo` metadata for restart recovery.

import { create } from 'zustand';
import type { Song } from '../../core/types';
import { logger } from '../../core/logger';
import { offlineRepo, songRepo } from '../../data/repositories';
import { getDb } from '../../data/db';
import {
  detectAudioContainer,
  looksLikeAudioBytes,
  isPlayableAudioMime,
  isDefinitelyNotAudio,
} from '../../audio/mediaDiagnostics';
import {
  cleanSongTitle,
  extractPrimarySongTitle,
  isSameSongOrVariant,
} from '../../audio/vibeClassifier';

export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{5,40}$/;
export const YOUTUBE_MAX_AUDIO_BYTES = 250 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1024;

export function isValidYouTubeVideoId(v: unknown): v is string {
  return typeof v === 'string' && YOUTUBE_VIDEO_ID_RE.test(v);
}

export function youtubeSongId(videoId: string): string {
  return `youtube:${videoId.replace(/^youtube:/, '')}`;
}

export function youtubeVideoIdOf(songOrId: Song | string): string | null {
  const raw =
    typeof songOrId === 'string'
      ? songOrId
      : (songOrId.providerTrackId || songOrId.id || '');
  const v = String(raw || '').replace(/^youtube:/, '');
  return isValidYouTubeVideoId(v) ? v : null;
}

export const IN_APP_SERVER_PROVIDERS = ['youtube', 'youtube-music', 'spotify', 'jiosaavn'] as const;

export function isYouTubeSong(song: Pick<Song, 'id' | 'providerId'>): boolean {
  return song.providerId === 'youtube' || song.id.startsWith('youtube:');
}

export function isInAppServerSong(song: Pick<Song, 'id' | 'providerId'>): boolean {
  return (
    isYouTubeSong(song) ||
    song.providerId === 'youtube-music' ||
    song.providerId === 'spotify' ||
    song.providerId === 'jiosaavn' ||
    song.id.startsWith('youtube-music:') ||
    song.id.startsWith('spotify:') ||
    song.id.startsWith('jiosaavn:')
  );
}

// --- Sidecar base URL (dynamic Tauri port → dev fallback) ---
//
// There is exactly ONE authoritative port, resolved live on every call:
//   - Desktop (Tauri): the host owns the sidecar process and its dynamic
//     loopback port. The renderer asks the host (IPC) for the CURRENT port
//     every time — never a cached copy. A cached port goes stale the moment
//     the sidecar restarts (new dynamic port), which previously left the
//     provider calling a dead port forever ("youtube unavailable").
//   - Browser/PWA dev: fixed dev port (env override or 5001).
//
// Only the explicit test override is cached (and only until reset).

let testBaseUrlOverride: string | null = null;

export function __resetYouTubeBaseUrlForTests(): void {
  testBaseUrlOverride = null;
}

export function __setYouTubeBaseUrlForTests(url: string | null): void {
  testBaseUrlOverride = url;
}

interface YouTubeAudioStatus {
  port: number | null;
  state?: string;
  last_error?: string | null;
}

function readDevEnv(key: string): string | undefined {
  // import.meta.env is statically baked by Vite for the browser build;
  // process.env covers node-driven contexts (tests, SSR) and shell exports.
  try {
    const meta = (import.meta as unknown as { env?: Record<string, string> }).env?.[key];
    if (typeof meta === 'string' && meta.trim()) return meta.trim();
  } catch {
    /* no import.meta env */
  }
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process
      ?.env?.[key];
    if (typeof proc === 'string' && proc.trim()) return proc.trim();
  } catch {
    /* no process env */
  }
  return undefined;
}

function devFallbackBaseUrl(): string {
  return (
    readDevEnv('VITE_YOUTUBE_SIDECAR_URL') ??
    readDevEnv('VITE_YOUTUBE_AUDIO_URL') ??
    'http://127.0.0.1:5001'
  );
}

function isTauriRuntime(): boolean {
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

export async function getYouTubeSidecarBaseUrl(): Promise<string> {
  if (testBaseUrlOverride) return testBaseUrlOverride;
  // Desktop: always read the LIVE dynamic port from the host. Never cache —
  // the host re-picks a free port on every sidecar (re)start.
  if (isTauriRuntime()) {
    try {
      const mod = await import('@tauri-apps/api/core');
      const status = await mod.invoke<YouTubeAudioStatus>('knox_youtube_audio_status');
      if (status && typeof status.port === 'number' && status.port > 0) {
        return `http://127.0.0.1:${status.port}`;
      }
      const state = typeof status?.state === 'string' && status.state ? status.state : 'not running';
      const cause =
        typeof status?.last_error === 'string' && status.last_error
          ? ` (${status.last_error.slice(0, 160)})`
          : '';
      throw new Error(`YouTube service unavailable (sidecar ${state})${cause}`);
    } catch (e) {
      if (e instanceof Error && /^YouTube service unavailable/.test(e.message)) throw e;
      throw new Error('YouTube service unavailable (desktop host unreachable)');
    }
  }
  return devFallbackBaseUrl();
}

// --- Progress (indeterminate phases — never fake percentages) ---

export type YouTubeDownloadStage =
  | 'preparing'
  | 'downloading'
  | 'converting'
  | 'validating'
  | 'saving'
  | 'ready';

export const YOUTUBE_STAGE_LABEL: Record<YouTubeDownloadStage, string> = {
  preparing: 'Preparing YouTube track…',
  downloading: 'Downloading…',
  converting: 'Converting audio…',
  validating: 'Validating…',
  saving: 'Saved offline',
  ready: 'Playing',
};

interface YouTubeProgressState {
  stages: Record<string, YouTubeDownloadStage>;
  setStage: (songId: string, stage: YouTubeDownloadStage) => void;
  clearStage: (songId: string) => void;
}

export const useYouTubeProgress = create<YouTubeProgressState>((set) => ({
  stages: {},
  setStage: (songId, stage) =>
    set((s) => ({ stages: { ...s.stages, [songId]: stage } })),
  clearStage: (songId) =>
    set((s) => {
      const next = { ...s.stages };
      delete next[songId];
      return { stages: next };
    }),
}));

export function reportYouTubeStage(songId: string, stage: YouTubeDownloadStage): void {
  try {
    useYouTubeProgress.getState().setStage(songId, stage);
  } catch {
    /* progress never breaks playback */
  }
}

export function clearYouTubeStage(songId: string): void {
  try {
    useYouTubeProgress.getState().clearStage(songId);
  } catch {
    /* best-effort */
  }
}

// --- Validation (bytes authoritative; never trust labels alone) ---

export interface YouTubeBytesVerdict {
  ok: boolean;
  reason: string;
  mime?: string;
  container?: string;
}

export function validateYouTubeAudioBytes(
  bytes: Uint8Array,
  mimeHint?: string,
): YouTubeBytesVerdict {
  if (!bytes || bytes.byteLength < MIN_AUDIO_BYTES) {
    return { ok: false, reason: 'truncated' };
  }
  if (bytes.byteLength > YOUTUBE_MAX_AUDIO_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  if (mimeHint && isDefinitelyNotAudio(mimeHint)) {
    return { ok: false, reason: 'not-audio' };
  }
  if (!looksLikeAudioBytes(bytes.slice(0, 64))) {
    return { ok: false, reason: 'not-audio' };
  }
  const detected = detectAudioContainer(bytes.slice(0, 16));
  if (!detected) {
    return { ok: false, reason: 'not-audio' };
  }
  if (detected.container === 'unknown-audio') {
    // Not an error page, but no known signature — accept only when the MIME
    // hint is honestly audio (the element remains the final decoder).
    if (mimeHint && isPlayableAudioMime(mimeHint)) {
      return { ok: true, reason: 'ok', mime: mimeHint, container: 'unknown-audio' };
    }
    return { ok: false, reason: 'not-audio' };
  }
  return { ok: true, reason: 'ok', mime: detected.mime ?? mimeHint ?? 'audio/mpeg', container: detected.container };
}

async function validateOfflineBlob(
  blob: Blob,
  meta?: { fileSize?: number; mimeType?: string },
): Promise<boolean> {
  // Real IndexedDB round-trips Blobs with bytes intact (production path
  // below). Some storage doubles return a plain object instead of a Blob —
  // fall back to the committed metadata then (never fail a valid permanent
  // entry just because the double dropped the bytes).
  const size = (blob as Blob | undefined)?.size;
  const canRead =
    blob instanceof Blob && typeof size === 'number' && typeof blob.slice === 'function';
  if (!canRead) {
    const fs = meta?.fileSize ?? 0;
    const mt = (meta?.mimeType || '').split(';')[0].trim().toLowerCase();
    if (!(fs >= MIN_AUDIO_BYTES)) return false;
    if (mt && isDefinitelyNotAudio(mt)) return false;
    if (mt && !isPlayableAudioMime(mt) && mt !== 'application/octet-stream') return false;
    return fs > 0;
  }
  try {
    if (!blob || blob.size < MIN_AUDIO_BYTES) return false;
    const type = (blob.type || '').split(';')[0].trim().toLowerCase();
    if (type && isDefinitelyNotAudio(type)) return false;
    if (type && !isPlayableAudioMime(type) && type !== 'application/octet-stream') return false;
    const head = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
    if (!looksLikeAudioBytes(head.slice(0, 64))) return false;
    const detected = detectAudioContainer(head.slice(0, 16));
    if (!detected) return false;
    // On Android WebView, WebM blobs lack duration metadata and cause playback interruption at 0:00
    if (detected.container === 'webm') {
      const isMobile = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
      if (isMobile) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- Permanent offline access (NO network, NO yt-dlp, NO Smart Cache) ---

export async function getPermanentYouTubeEntry(videoId: string) {
  if (!isValidYouTubeVideoId(videoId)) return undefined;
  try {
    return await offlineRepo.get(youtubeSongId(videoId));
  } catch {
    return undefined;
  }
}

export async function hasPermanentYouTube(videoId: string): Promise<boolean> {
  const entry = await getPermanentYouTubeEntry(videoId);
  if (!entry) return false;
  return validateOfflineBlob(entry.blob, { fileSize: entry.fileSize, mimeType: entry.mimeType });
}

// --- Sidecar fetch (download pipeline; only when no permanent copy) ---

export interface SidecarDownloadResult {
  success: boolean;
  videoId: string;
  filePath?: string;
  sizeBytes?: number;
  cached?: boolean;
  errorCode?: string;
  message?: string;
}

function layerError(sidecarCode: string | undefined, fallback: string): Error {
  switch (sidecarCode) {
    case 'YTDLP_UNAVAILABLE':
    case 'YTDLP_ERROR':
      return new Error('yt-dlp executable not found');
    case 'FFMPEG_UNAVAILABLE':
      return new Error('FFmpeg executable not found');
    case 'TIMEOUT':
      return new Error('YouTube download timed out');
    case 'TOO_LARGE':
      return new Error('YouTube download failed (file too large)');
    case 'INVALID_ID':
      return new Error('YouTube download failed (invalid video)');
    case 'VALIDATION_FAILED':
      return new Error('Audio validation failed');
    case 'DOWNLOAD_FAILED':
      return new Error('YouTube download failed');
    case 'BAD_REQUEST':
      return new Error('YouTube download failed (bad request)');
    default:
      return new Error(fallback);
  }
}

/**
 * Automatically delete any older duplicate song in the user's Library / Offline
 * storage when they start playing or downloading the same song from another provider
 * (e.g., user already has "Glory" downloaded from YouTube, searches "Glory" and starts
 * playing it from JioSaavn or Spotify → automatically deletes old duplicate song while
 * migrating favorites and playlist references).
 */
export async function dedupeLibraryForPlayedSong(newSong: Song): Promise<number> {
  if (!newSong || !newSong.id || !newSong.title || newSong.providerId === 'local') {
    return 0;
  }
  const cleanNew = cleanSongTitle(newSong.title);
  const primNew = extractPrimarySongTitle(newSong.title);
  if (
    (!cleanNew && !primNew) ||
    cleanNew === 'youtube video' ||
    cleanNew === 'unknown'
  ) {
    return 0;
  }

  try {
    const db = getDb();
    const [allSongs, allOffline] = await Promise.all([
      db.songs.toArray().catch(() => []),
      db.offline.toArray().catch(() => []),
    ]);

    const candidateMap = new Map<
      string,
      { id: string; title: string; artist: string; providerId?: string }
    >();
    for (const s of allSongs) {
      if (s && s.id && s.id !== newSong.id && s.providerId !== 'local' && !s.id.startsWith('local:')) {
        candidateMap.set(s.id, {
          id: s.id,
          title: s.title || '',
          artist: s.artist || '',
          providerId: s.providerId,
        });
      }
    }
    for (const o of allOffline) {
      if (o && o.id && o.id !== newSong.id && !o.id.startsWith('local:')) {
        if (!candidateMap.has(o.id)) {
          candidateMap.set(o.id, {
            id: o.id,
            title: o.title || '',
            artist: o.artist || '',
            providerId: o.provider,
          });
        }
      }
    }

    const duplicateIds: string[] = [];
    for (const cand of candidateMap.values()) {
      const cleanCand = cleanSongTitle(cand.title);
      const primCand = extractPrimarySongTitle(cand.title);
      if (
        (!cleanCand && !primCand) ||
        cleanCand === 'youtube video' ||
        cleanCand === 'unknown'
      ) {
        continue;
      }

      const sameOrVariant = isSameSongOrVariant(cand, newSong);
      const exactCleanMatch = cleanNew.length >= 2 && cleanCand === cleanNew;
      const exactPrimaryMatch =
        primNew.length >= 2 &&
        primCand.length >= 2 &&
        (primCand === primNew || primCand === cleanNew || cleanCand === primNew);

      if (sameOrVariant || exactCleanMatch || exactPrimaryMatch) {
        duplicateIds.push(cand.id);
      }
    }

    if (duplicateIds.length === 0) return 0;

    for (const oldId of duplicateIds) {
      try {
        const oldFav = await db.favorites.get(oldId);
        if (oldFav) {
          await db.favorites.delete(oldId);
          await db.favorites.put({ songId: newSong.id, addedAt: oldFav.addedAt });
        }
      } catch {
        /* best-effort */
      }

      try {
        const playlists = await db.playlists.toArray();
        for (const pl of playlists) {
          if (Array.isArray(pl.trackIds) && pl.trackIds.includes(oldId)) {
            const nextTrackIds = Array.from(
              new Set(pl.trackIds.map((tid) => (tid === oldId ? newSong.id : tid))),
            );
            await db.playlists.update(pl.id, { trackIds: nextTrackIds, updatedAt: Date.now() });
          }
        }
      } catch {
        /* best-effort */
      }

      await offlineRepo.remove(oldId).catch(() => undefined);
      await db.songs.delete(oldId).catch(() => undefined);
      await db.downloads.delete(oldId).catch(() => undefined);
      await db.smartcache.delete(oldId).catch(() => undefined);
    }

    await songRepo.upsert(newSong).catch(() => undefined);

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent('knox:library-updated', {
          detail: { replacedIds: duplicateIds, newSongId: newSong.id },
        }),
      );
    }
    logger.info(
      'youtube',
      `Auto-deleted ${duplicateIds.length} duplicate library song(s) (${duplicateIds.join(', ')}) in favor of ${newSong.id}`,
    );
    return duplicateIds.length;
  } catch {
    return 0;
  }
}

async function postDownload(videoId: string, baseUrl: string, signal?: AbortSignal): Promise<SidecarDownloadResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // Long tracks (~44 min like Barsana Bali Radhey) need up to 300s for chunked download + FFmpeg.
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(`${baseUrl}/api/youtube/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as SidecarDownloadResult;
    if (!res.ok || body.success !== true) {
      throw layerError(
        body.errorCode,
        body.message || `YouTube download failed (HTTP ${res.status})`,
      );
    }
    return body;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (signal?.aborted) throw new DOMException('YouTube download superseded', 'AbortError');
      throw new Error('YouTube download timed out');
    }
    if (e instanceof Error && /^YouTube |yt-dlp|FFmpeg|Audio validation/.test(e.message)) throw e;
    throw new Error('YouTube service unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchAudioBytes(
  videoId: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(`${baseUrl}/api/youtube/audio?videoId=${encodeURIComponent(videoId)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`YouTube audio fetch failed (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim() || 'audio/mpeg';
    return { bytes, mime };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (signal?.aborted) throw new DOMException('YouTube audio fetch superseded', 'AbortError');
      throw new Error('YouTube download timed out');
    }
    throw e instanceof Error ? e : new Error('YouTube service unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Duplicate-download protection: concurrent ensure() calls for the same
// `youtube:<videoId>` share one promise (one yt-dlp process). All callers
// receive the same final local asset. The lock is removed after completion
// (success or failure); failures also leave no corrupt permanent entry.
const inFlight = new Map<string, Promise<PermanentYouTubeAsset>>();

export function __youtubeInFlightForTests(): number {
  return inFlight.size;
}

export interface PermanentYouTubeAsset {
  blob: Blob;
  objectUrl: string;
  mimeType: string;
  sizeBytes: number;
  fromCache: boolean;
}

export interface EnsureOptions {
  onStage?: (stage: YouTubeDownloadStage) => void;
  signal?: AbortSignal;
  quality?: string;
}

/**
 * Download-first permanent resolve for one YouTube track.
 *   1. Permanent offline hit (validated) → return it. NO network, NO yt-dlp.
 *   2. Miss → single shared sidecar download → validate bytes → atomic commit
 *      to offlineRepo + songRepo metadata → return the committed asset.
 * Never touches Smart Cache. Never exposes a partial download as playable.
 */
export async function ensurePermanentYouTubeTrack(
  song: Song,
  opts: EnsureOptions = {},
): Promise<PermanentYouTubeAsset> {
  const videoId = youtubeVideoIdOf(song);
  if (!videoId) throw new Error('YouTube download failed (invalid video)');
  const songId = youtubeSongId(videoId);

  const stage = (s: YouTubeDownloadStage) => {
    reportYouTubeStage(songId, s);
    try {
      opts.onStage?.(s);
    } catch {
      /* stage callbacks never break playback */
    }
  };

  // 1. Permanent hit — validated before playback; corrupt entries are
  //    deleted + redownloaded once (never played).
  const existing = await getPermanentYouTubeEntry(videoId).catch(() => undefined);
  if (existing) {
    const valid = await validateOfflineBlob(existing.blob, {
      fileSize: existing.fileSize,
      mimeType: existing.mimeType,
    });
    if (valid) {
      try {
        await getDb().offline.update(songId, { lastPlayedAt: Date.now() }).catch(() => undefined);
      } catch {
        /* touch is best-effort */
      }
      await dedupeLibraryForPlayedSong({
        ...song,
        id: songId,
        providerId: 'youtube',
        providerTrackId: videoId,
        isOfflineAvailable: true,
      }).catch(() => 0);
      stage('ready');
      return {
        blob: existing.blob,
        objectUrl: offlineRepo.objectUrl(songId, existing.blob),
        mimeType: existing.mimeType || existing.blob.type || 'audio/mpeg',
        sizeBytes: existing.fileSize || existing.blob.size,
        fromCache: true,
      };
    }
    // Corrupt permanent entry: invalidate metadata, redownload once below.
    try {
      await offlineRepo.remove(songId);
    } catch {
      /* best-effort */
    }
    logger.warn('youtube', `removed corrupt permanent youtube file (${songId}); redownloading once`);
  }

  // 2. Shared in-flight download (duplicate Play clicks → one yt-dlp).
  const key = songId;
  const shared = inFlight.get(key);
  if (shared) return shared;

  const job = (async (): Promise<PermanentYouTubeAsset> => {
    stage('preparing');
    const baseUrl = await getYouTubeSidecarBaseUrl();
    let download: SidecarDownloadResult;
    try {
      stage('downloading');
      download = await postDownload(videoId, baseUrl, opts.signal);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      logger.error('youtube', 'YouTube download failed', String(e).slice(0, 200));
      throw e instanceof Error ? e : new Error('YouTube download failed');
    }
    void download;
    stage('converting');
    // The sidecar already converted + atomically published the MP3; fetch
    // its bytes for the renderer-side permanent commit (IndexedDB Blob).
    stage('validating');
    const { bytes, mime } = await fetchAudioBytes(videoId, baseUrl, opts.signal);
    const verdict = validateYouTubeAudioBytes(bytes, mime);
    if (!verdict.ok) {
      logger.error('youtube', `Audio validation failed (${verdict.reason})`);
      throw new Error('Audio validation failed');
    }
    stage('saving');
    const blob = new Blob([bytes as unknown as BlobPart], { type: verdict.mime ?? 'audio/mpeg' });
    const committedSong: Song = {
      ...song,
      id: songId,
      providerId: 'youtube',
      providerTrackId: videoId,
      isOfflineAvailable: true,
    };
    // Atomic commit: offline Blob + library metadata together. Only after
    // this point is the track visible as permanently available.
    await offlineRepo.put(committedSong, blob, opts.quality ?? 'MP3 (YouTube)');
    await songRepo.upsert({ ...committedSong, isOfflineAvailable: true }).catch(() => undefined);
    await dedupeLibraryForPlayedSong(committedSong).catch(() => 0);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('knox:library-updated', { detail: { newSongId: songId } }));
    }
    logger.info('youtube', `permanent youtube saved (${songId} bytes=${blob.size})`);
    stage('ready');
    return {
      blob,
      objectUrl: offlineRepo.objectUrl(songId, blob),
      mimeType: verdict.mime ?? 'audio/mpeg',
      sizeBytes: blob.size,
      fromCache: false,
    };
  })();

  inFlight.set(key, job);
  try {
    return await job;
  } catch (e) {
    throw e;
  } finally {
    if (inFlight.get(key) === job) inFlight.delete(key);
  }
}

async function resolveInAppVideoId(song: Song, signal?: AbortSignal): Promise<string | null> {
  // 1. Direct YouTube / YouTube Music videoId
  if (
    song.providerId === 'youtube' ||
    song.providerId === 'youtube-music' ||
    song.id.startsWith('youtube:') ||
    song.id.startsWith('youtube-music:')
  ) {
    const raw = String(song.providerTrackId || song.id || '').replace(/^youtube(-music)?:/, '');
    if (isValidYouTubeVideoId(raw)) return raw;
  }

  // 1b. Sidecar Spotify search tracks carry an 11-char YouTube videoId in providerTrackId
  if (song.providerId === 'spotify' || song.id.startsWith('spotify:')) {
    const rawTrackId = String(song.providerTrackId || song.id || '').replace(/^spotify:/, '');
    if (rawTrackId.length === 11 && /^[A-Za-z0-9_-]{11}$/.test(rawTrackId)) {
      return rawTrackId;
    }
  }

  // 2. Search YouTube for matching track by title + artist
  const query = `${song.title || ''} ${song.artist && song.artist !== 'Unknown' ? song.artist : ''}`.trim();
  if (!query) return null;

  const targetSec = song.durationMs && song.durationMs > 0 ? Math.round(song.durationMs / 1000) : 0;
  const pickBestMatch = (
    items: Array<{ id?: string; live?: boolean; duration?: number | null }>,
  ): string | null => {
    const valid = items
      .filter((r) => r && !r.live && isValidYouTubeVideoId(String(r.id ?? '').replace(/^youtube:/, '')))
      .map((r) => ({
        id: String(r.id).replace(/^youtube:/, ''),
        duration: typeof r.duration === 'number' && r.duration > 0 ? r.duration : 0,
      }));
    if (valid.length === 0) return null;
    if (targetSec >= 600) {
      // For long tracks (10+ min, e.g. 44-min Barsana Bali Radhey), prefer candidates >= 8 min or close to targetSec
      const longMatch = valid.find(
        (v) => v.duration >= 480 && Math.abs(v.duration - targetSec) <= Math.max(300, targetSec * 0.4),
      );
      if (longMatch) return longMatch.id;
      const anyLong = valid.find((v) => v.duration >= 480);
      if (anyLong) return anyLong.id;
    }
    return valid[0].id;
  };

  try {
    const baseUrl = await getYouTubeSidecarBaseUrl();
    const res = await fetch(
      `${baseUrl}/api/youtube/search?q=${encodeURIComponent(query)}&limit=8`,
      { signal },
    );
    if (res.ok) {
      const items = (await res.json()) as Array<{ id?: string; live?: boolean; duration?: number | null }>;
      if (Array.isArray(items)) {
        const picked = pickBestMatch(items);
        if (picked) return picked;
      }
    }
  } catch {
    /* try native / InnerTube fallbacks below */
  }

  try {
    const { canUseNativeYouTube, nativeSearch } = await import('./device');
    if (canUseNativeYouTube()) {
      const items = await nativeSearch(query, 8);
      const picked = pickBestMatch(items);
      if (picked) return picked;
    }
  } catch {
    /* try InnerTube fallback below */
  }

  try {
    const { searchYouTubeInnerTube } = await import('./scraper');
    const items = await searchYouTubeInnerTube(query, { limit: 8, signal });
    const picked = pickBestMatch(items);
    if (picked) return picked;
  } catch {
    /* no match */
  }

  return null;
}

/**
 * Shared download-first / permanent offline resolver for all in-app server
 * providers (`youtube`, `youtube-music`, `spotify`, `jiosaavn`).
 *
 * 1. Checks `offlineRepo.get(song.id)` for an existing validated local Blob.
 * 2. If `song` is a direct `youtube` track, delegates to `ensurePermanentYouTubeTrack`
 *    (with native Tauri fallback).
 * 3. If `song.streamUrl` is a direct HTTP(S) stream (e.g. JioSaavn decrypted CDN),
 *    fetches and validates the audio bytes directly and commits to `offlineRepo`.
 * 4. Otherwise resolves the matching YouTube `videoId` (directly for `youtube-music`,
 *    or via title+artist search for `spotify`/`jiosaavn`), extracts & validates audio
 *    via the sidecar or native Tauri extractor, and commits under `song.id` with the
 *    provider's original metadata preserved.
 */
export async function ensureInAppProviderTrack(
  song: Song,
  opts: EnsureOptions = {},
): Promise<PermanentYouTubeAsset> {
  if (isYouTubeSong(song)) {
    try {
      return await ensurePermanentYouTubeTrack(song, opts);
    } catch (sidecarErr) {
      const { canUseNativeYouTube, ensureNativeYouTubeTrack } = await import('./device');
      if (canUseNativeYouTube()) {
        return await ensureNativeYouTubeTrack(song);
      }
      throw sidecarErr;
    }
  }

  const songId = song.id || `${song.providerId}:${song.providerTrackId}`;
  const stage = (s: YouTubeDownloadStage) => {
    reportYouTubeStage(songId, s);
    try {
      opts.onStage?.(s);
    } catch {
      /* stage callbacks never break playback */
    }
  };

  // 1. Check permanent offline storage for this provider songId
  const existing = await offlineRepo.get(songId).catch(() => undefined);
  if (existing) {
    const valid = await validateOfflineBlob(existing.blob, {
      fileSize: existing.fileSize,
      mimeType: existing.mimeType,
    });
    if (valid) {
      try {
        await getDb().offline.update(songId, { lastPlayedAt: Date.now() }).catch(() => undefined);
      } catch {
        /* best-effort */
      }
      await dedupeLibraryForPlayedSong({ ...song, id: songId, isOfflineAvailable: true }).catch(() => 0);
      stage('ready');
      return {
        blob: existing.blob,
        objectUrl: offlineRepo.objectUrl(songId, existing.blob),
        mimeType: existing.mimeType || existing.blob.type || 'audio/mpeg',
        sizeBytes: existing.fileSize || existing.blob.size,
        fromCache: true,
      };
    }
    await offlineRepo.remove(songId).catch(() => undefined);
  }

  // 2. Deduplicate concurrent requests for the same songId
  const shared = inFlight.get(songId);
  if (shared) return shared;

  const job = (async (): Promise<PermanentYouTubeAsset> => {
    stage('preparing');
    const qualityLabel =
      opts.quality ??
      (song.providerId === 'jiosaavn'
        ? '320kbps AAC (JioSaavn)'
        : song.providerId === 'spotify'
          ? 'Audio (Spotify)'
          : 'Audio (YouTube Music)');

    // 3. Direct HTTP(S) streamUrl path (e.g. JioSaavn decrypted CDN or direct stream)
    if (song.streamUrl && /^https?:\/\//i.test(song.streamUrl)) {
      try {
        stage('downloading');
        let directBytes: Uint8Array | null = null;
        let directMime = 'audio/mp4';
        const isLongTrack = (song.durationMs ?? 0) >= 900_000;
        const bitrateOrder = isLongTrack ? ['96', '160', '320'] : ['320', '160', '96'];

        // 3a. On Tauri (Android / Desktop), fetch natively via reqwest (no WebView CORS!)
        try {
          const { canUseNativeYouTube, nativeFetchAudioBytes } = await import('./device');
          if (canUseNativeYouTube()) {
            const preferredUrl = isLongTrack
              ? song.streamUrl.replace(/_(160|320)\.mp4(\?.*)?$/i, '_96.mp4')
              : song.streamUrl;
            const nativeRes = await nativeFetchAudioBytes(preferredUrl);
            if (nativeRes) {
              directBytes = nativeRes.bytes;
              directMime = nativeRes.mime;
            }
          }
        } catch {
          /* fall through to sidecar proxy / standard fetch */
        }

        // 3b. Sidecar JioSaavn proxy (bypasses browser CORS on desktop)
        if (!directBytes && song.streamUrl.includes('saavncdn.com/')) {
          try {
            const baseUrl = await getYouTubeSidecarBaseUrl();
            const preferredUrl = isLongTrack
              ? song.streamUrl.replace(/_(160|320)\.mp4(\?.*)?$/i, '_96.mp4')
              : song.streamUrl;
            const proxyRes = await fetch(
              `${baseUrl}/api/jiosaavn/proxy?url=${encodeURIComponent(preferredUrl)}`,
              { signal: opts.signal },
            );
            if (proxyRes.ok) {
              directBytes = new Uint8Array(await proxyRes.arrayBuffer());
              directMime =
                (proxyRes.headers.get('content-type') || 'audio/mp4').split(';')[0].trim() ||
                'audio/mp4';
            }
          } catch (proxyErr) {
            if ((proxyErr as Error)?.name === 'AbortError') throw proxyErr;
            /* fall through to direct fetch */
          }
        }

        // 3c. Standard fetch with JioSaavn bitrate fallback
        if (!directBytes) {
          const candidates = [song.streamUrl];
          if (song.streamUrl.includes('saavncdn.com/')) {
            for (const br of bitrateOrder) {
              const cand = song.streamUrl
                .replace('//preview.saavncdn.com/', '//aac.saavncdn.com/')
                .replace('//h.saavncdn.com/', '//aac.saavncdn.com/')
                .replace(/_96_p\.mp4(\?.*)?$/i, `_${br}.mp4`)
                .replace(/_(96|160|320)\.mp4(\?.*)?$/i, `_${br}.mp4`);
              if (!candidates.includes(cand)) candidates.push(cand);
            }
          }
          for (const candUrl of candidates) {
            try {
              const res = await fetch(candUrl, { signal: opts.signal });
              if (res.ok) {
                directBytes = new Uint8Array(await res.arrayBuffer());
                directMime = (res.headers.get('content-type') || 'audio/mp4').split(';')[0].trim() || 'audio/mp4';
                break;
              }
            } catch (fetchErr) {
              if ((fetchErr as Error)?.name === 'AbortError') throw fetchErr;
            }
          }
        }

        if (directBytes) {
          stage('validating');
          const verdict = validateYouTubeAudioBytes(directBytes, directMime);
          if (verdict.ok) {
            stage('saving');
            const blob = new Blob([directBytes as unknown as BlobPart], {
              type: verdict.mime ?? directMime,
            });
            const committedSong: Song = {
              ...song,
              id: songId,
              isOfflineAvailable: true,
            };
            await offlineRepo.put(committedSong, blob, qualityLabel);
            await songRepo.upsert(committedSong).catch(() => undefined);
            await dedupeLibraryForPlayedSong(committedSong).catch(() => 0);
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              window.dispatchEvent(new CustomEvent('knox:library-updated', { detail: { newSongId: songId } }));
            }
            stage('ready');
            return {
              blob,
              objectUrl: offlineRepo.objectUrl(songId, blob),
              mimeType: verdict.mime ?? directMime,
              sizeBytes: blob.size,
              fromCache: false,
            };
          }
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        /* fall through to YouTube audio engine resolution */
      }
    }

    // 4. Resolve via in-app YouTube audio engine (sidecar -> native Tauri fallback)
    const videoId = await resolveInAppVideoId(song, opts.signal);
    if (!videoId) {
      throw new Error(`${song.providerId} audio resolution failed (track not found)`);
    }

    let bytes: Uint8Array | null = null;
    let mime = 'audio/mpeg';

    try {
      const baseUrl = await getYouTubeSidecarBaseUrl();
      stage('downloading');
      await postDownload(videoId, baseUrl, opts.signal);
      stage('converting');
      stage('validating');
      const fetched = await fetchAudioBytes(videoId, baseUrl, opts.signal);
      bytes = fetched.bytes;
      mime = fetched.mime;
    } catch (sidecarError) {
      if ((sidecarError as Error)?.name === 'AbortError') throw sidecarError;
      const { canUseNativeYouTube, ensureNativeYouTubeTrack } = await import('./device');
      if (!canUseNativeYouTube()) throw sidecarError;
      const ytSong: Song = {
        ...song,
        id: youtubeSongId(videoId),
        providerId: 'youtube',
        providerTrackId: videoId,
      };
      // Pass { persist: false } so we only commit under the requested provider songId
      // (e.g. spotify:... / jiosaavn:... / youtube-music:...) and don't create a second youtube:... duplicate!
      const nativeAsset = await ensureNativeYouTubeTrack(ytSong, { persist: false });
      stage('saving');
      const committedSong: Song = {
        ...song,
        id: songId,
        isOfflineAvailable: true,
      };
      await offlineRepo.put(committedSong, nativeAsset.blob, qualityLabel);
      await songRepo.upsert(committedSong).catch(() => undefined);
      await dedupeLibraryForPlayedSong(committedSong).catch(() => 0);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('knox:library-updated', { detail: { newSongId: songId } }));
      }
      stage('ready');
      return {
        blob: nativeAsset.blob,
        objectUrl: offlineRepo.objectUrl(songId, nativeAsset.blob),
        mimeType: nativeAsset.mimeType,
        sizeBytes: nativeAsset.sizeBytes,
        fromCache: false,
      };
    }

    const verdict = validateYouTubeAudioBytes(bytes, mime);
    if (!verdict.ok) {
      throw new Error('Audio validation failed');
    }

    stage('saving');
    const blob = new Blob([bytes as unknown as BlobPart], { type: verdict.mime ?? 'audio/mpeg' });
    const committedSong: Song = {
      ...song,
      id: songId,
      isOfflineAvailable: true,
    };
    await offlineRepo.put(committedSong, blob, qualityLabel);
    await songRepo.upsert(committedSong).catch(() => undefined);
    await dedupeLibraryForPlayedSong(committedSong).catch(() => 0);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('knox:library-updated', { detail: { newSongId: songId } }));
    }
    stage('ready');
    return {
      blob,
      objectUrl: offlineRepo.objectUrl(songId, blob),
      mimeType: verdict.mime ?? 'audio/mpeg',
      sizeBytes: blob.size,
      fromCache: false,
    };
  })();

  inFlight.set(songId, job);
  try {
    return await job;
  } finally {
    if (inFlight.get(songId) === job) inFlight.delete(songId);
  }
}

