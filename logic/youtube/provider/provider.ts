// YouTube provider — search metadata + download-first permanent local playback.
//
// Architecture (never bypassed, never duplicated in the frontend):
//   KNOX UI → ProviderManager → YouTubeProvider → local YouTube sidecar
//     → services/audioService.js → yt-dlp → FFmpeg → validate → permanent
//     offlineRepo Blob (+ songRepo metadata) → singleton AudioEngine.
//
// - Provider id stays `youtube` (track ids `youtube:<videoId>`). Never merged
//   with `youtube-music` (discovery-only).
// - No yt-dlp/FFmpeg logic lives here: the sidecar + audioService own the
//   pipeline. This module only validates ids, maps metadata, and resolves
//   the permanent local asset before playback.
// - Live streams are rejected. Malformed ids are rejected before any fetch.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { MusicProvider, StreamResult } from '../types';
import { YOUTUBE_PROVIDER_ID, mapYouTubeSearchResult, mapYouTubeSearchResults, createYouTubeSong } from './mapper';
import type { YouTubeSearchResult } from './types';
import {
  getYouTubeSidecarBaseUrl,
  isValidYouTubeVideoId,
  youtubeVideoIdOf,
  ensurePermanentYouTubeTrack,
  __resetYouTubeBaseUrlForTests,
} from './youtubeOffline';

void __resetYouTubeBaseUrlForTests;

const YOUTUBE_LICENSE = 'YouTube Standard License';
// Cold yt-dlp metadata searches take ~20-30s (measured live); warm/cache hits
// are instant. The budget covers the cold case — the sidecar caps searches
// at 60s, and the manager override below matches this value.
const SEARCH_TIMEOUT_MS = 45000;

interface HealthBody {
  ok: boolean;
  service?: string;
  ytDlp?: boolean;
  ffmpeg?: boolean;
  ytDlpVersion?: string;
  error?: string;
}

/** HTTP failure that preserves the sidecar's structured JSON body. */
class SidecarHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, snippet: string) {
    super(`HTTP ${status}: ${snippet}`);
    this.name = 'SidecarHttpError';
    this.status = status;
    this.body = body;
  }
}

function bodyText(body: unknown): string {
  try {
    return JSON.stringify(body).slice(0, 400);
  } catch {
    return '';
  }
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // Preserve the structured body (health reports ytDlp/ffmpeg flags on
      // 503) so callers can name the missing dependency instead of a
      // generic "unavailable".
      let parsed: unknown = null;
      let snippet = '';
      try {
        const text = await res.text();
        snippet = text.slice(0, 200);
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      } catch {
        /* body unreadable — status alone */
      }
      throw new SidecarHttpError(res.status, parsed, snippet);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function sidecarSearch(query: string, limit = 25): Promise<YouTubeSearchResult[]> {
  const q = query.slice(0, 400);
  const n = Math.max(1, Math.min(60, limit));
  try {
    const baseUrl = await getYouTubeSidecarBaseUrl();
    return await fetchJson<YouTubeSearchResult[]>(
      `${baseUrl}/api/youtube/search?q=${encodeURIComponent(q)}&limit=${n}`,
      { headers: { 'Content-Type': 'application/json' } },
      SEARCH_TIMEOUT_MS,
    );
  } catch (sidecarError) {
    // No sidecar (Android APK, stopped desktop sidecars): try the native
    // on-device host before surfacing the failure. Desktop with a healthy
    // sidecar never reaches here. A native failure surfaces its own cause
    // (never the misleading sidecar "disabled").
    const { canUseNativeYouTube, nativeSearch, nativeErrorOf } = await import('./device');
    if (canUseNativeYouTube()) {
      try {
        return await nativeSearch(q, n);
      } catch (nativeError) {
        if ((nativeError as Error)?.name === 'AbortError') throw nativeError;
        // Preserve the native cause (Tauri rejects with plain strings).
        throw nativeErrorOf(nativeError, sidecarError instanceof Error ? sidecarError.message : 'YouTube search failed');
      }
    }
    throw sidecarError;
  }
}

async function sidecarHealth(): Promise<{ ok: boolean; detail: string }> {
  const checkSidecar = async (): Promise<{ ok: boolean; detail: string }> => {
    try {
    const baseUrl = await getYouTubeSidecarBaseUrl();
    const body = await fetchJson<HealthBody>(`${baseUrl}/api/health`, {}, 8000);
    if (body.ok === true && body.ytDlp !== false && body.ffmpeg !== false) {
      return { ok: true, detail: 'ready' };
    }
    // Structured dependency failure — name the missing piece.
    if (body.ytDlp === false && body.ffmpeg === false) {
      return { ok: false, detail: 'yt-dlp executable not found; FFmpeg executable not found' };
    }
    if (body.ytDlp === false) return { ok: false, detail: 'yt-dlp executable not found' };
    if (body.ffmpeg === false) return { ok: false, detail: 'FFmpeg executable not found' };
    return { ok: false, detail: body.error || 'YouTube service unavailable' };
  } catch (e) {
    // A non-OK health HTTP status still carries the structured dependency
    // flags in its JSON body (the sidecar answers 503 when yt-dlp/ffmpeg
    // are missing) — surface them instead of a generic message.
    if (e instanceof SidecarHttpError && e.body && typeof e.body === 'object') {
      const b = e.body as Partial<HealthBody>;
      if (b.ytDlp === false && b.ffmpeg === false) {
        return { ok: false, detail: 'yt-dlp executable not found; FFmpeg executable not found' };
      }
      if (b.ytDlp === false) return { ok: false, detail: 'yt-dlp executable not found' };
      if (b.ffmpeg === false) return { ok: false, detail: 'FFmpeg executable not found' };
      if (typeof b.error === 'string' && b.error) {
        return { ok: false, detail: b.error.slice(0, 200) };
      }
    }
    if (e instanceof Error && /^YouTube service unavailable \(sidecar /.test(e.message)) {
      return { ok: false, detail: e.message };
    }
    return { ok: false, detail: 'YouTube service unavailable' };
    }
  };
  const sidecar = await checkSidecar();
  if (sidecar.ok) return sidecar;
  // Sidecar down/missing (Android APK, stopped desktop sidecars): the native
  // on-device host answers the same health question with no loopback socket.
  try {
    const { canUseNativeYouTube, nativeHealth } = await import('./device');
    if (canUseNativeYouTube()) return await nativeHealth();
  } catch { /* keep the sidecar verdict below */ }
  return sidecar;
}

function toProviderError(detail: string, query?: string): ProviderError {
  void query;
  if (/yt-dlp executable not found/i.test(detail) || /"ytDlp":false/.test(detail)) {
    return new ProviderError('NETWORK', 'YouTube service unavailable (yt-dlp executable not found).');
  }
  if (/FFmpeg executable not found/i.test(detail) || /"ffmpeg":false/.test(detail)) {
    return new ProviderError('NETWORK', 'YouTube service unavailable (FFmpeg executable not found).');
  }
  if (/sidecar (disabled|starting|health_check|retry|start_failed|unavailable|not running)/i.test(detail)) {
    return new ProviderError('NETWORK', `YouTube provider is unavailable (${detail.slice(0, 160)}).`);
  }
  if (/timed out|timeout/i.test(detail)) {
    return new ProviderError('TIMEOUT', 'YouTube search timed out — check your connection, then retry.');
  }
  return new ProviderError('NETWORK', 'YouTube provider is unavailable (start the local service or disable the provider).');
}

export class YouTubeProvider implements MusicProvider {
  readonly id = YOUTUBE_PROVIDER_ID;
  readonly name = 'YouTube';
  /** Slow metadata backend (cold yt-dlp search ~25s) — needs headroom over the 15s manager default. */
  readonly requestTimeoutMs = SEARCH_TIMEOUT_MS;
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true, // via permanent local file after download-first
    supportsOffline: true,
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: false,
    supportsAlbums: false,
    supportsMetadata: true,
    supportsDownloads: true,
    commercialCatalog: false,
    supportsPlaybackCache: false, // permanent offline files, never Smart Cache
  };
  readonly offlineNotice = 'YouTube tracks are downloaded and saved permanently for offline playback.';

  async checkHealth(): Promise<boolean> {
    const { ok, detail } = await sidecarHealth();
    logger.info('youtube', ok ? 'YOUTUBE_PROVIDER_READY' : `YOUTUBE_PROVIDER_HEALTH_FAILED (${detail})`);
    return ok;
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = (query ?? '').trim();
    if (!q) return [];
    if (signal?.aborted) return [];
    try {
      const results = await sidecarSearch(q, 25);
      if (signal?.aborted) return [];
      if (!Array.isArray(results)) return [];
      // Validate ids before accepting: malformed ids never become songs or
      // process arguments. Live streams are dropped by the mapper.
      const clean = results.filter((r) => {
        const v = String(r?.id ?? '').replace(/^youtube:/, '');
        return isValidYouTubeVideoId(v);
      });
      return mapYouTubeSearchResults(clean);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      if (e instanceof ProviderError) throw e;
      const msg = e instanceof Error ? e.message : 'YouTube search failed';
      throw toProviderError(msg, q);
    }
  }

  async searchArtists(_query: string, _signal?: AbortSignal): Promise<Artist[]> {
    return [];
  }

  async searchAlbums(_query: string, _signal?: AbortSignal): Promise<Album[]> {
    return [];
  }

  async searchPlaylists(_query: string, _signal?: AbortSignal): Promise<Playlist[]> {
    return [];
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const videoId = String(providerTrackId || '').replace(/^youtube:/, '');
    if (!isValidYouTubeVideoId(videoId)) return null;

    // Check DB first so we preserve existing known metadata!
    try {
      const { getDb } = await import('../../data/db');
      const inDb = await getDb().songs.get(`youtube:${videoId}`);
      if (inDb && inDb.title && inDb.title !== 'YouTube Video') {
        return inDb;
      }
      const inOff = await getDb().offline.get(`youtube:${videoId}`);
      if (inOff && inOff.title && inOff.title !== 'YouTube Video') {
        const s = createYouTubeSong(videoId, {
          title: inOff.title,
          channel: inOff.artist || 'YouTube',
          durationMs: inOff.durationMs || 0,
        });
        s.album = inOff.album || '';
        s.isOfflineAvailable = true;
        return s;
      }
    } catch {
      /* ignore */
    }

    // Prefer fresh sidecar metadata for the exact id (no arbitrary URLs).
    try {
      const results = await sidecarSearch(videoId, 1);
      const exact = (results || []).find((r) => {
        const v = String(r?.id ?? '').replace(/^youtube:/, '');
        return v === videoId;
      });
      if (exact) return mapYouTubeSearchResult(exact);
    } catch {
      // Fall through to native on Android
    }

    // On Android (no sidecar): query native search for this exact videoId!
    try {
      const { canUseNativeYouTube, nativeSearch } = await import('./device');
      if (canUseNativeYouTube()) {
        const results = await nativeSearch(videoId, 1);
        const exact = (results || []).find((r) => {
          const v = String(r?.id ?? '').replace(/^youtube:/, '');
          return v === videoId;
        });
        if (exact) return mapYouTubeSearchResult(exact);
      }
    } catch {
      // Fall through to constructed song
    }

    return createYouTubeSong(videoId, {
      title: 'YouTube Video',
      channel: 'Unknown',
      durationMs: 0,
    });
  }

  async getArtist(_providerArtistId: string): Promise<Artist | null> {
    return null;
  }

  async getAlbum(_providerAlbumId: string): Promise<Album | null> {
    return null;
  }

  async getPlaylist(): Promise<Playlist | null> {
    return null;
  }

  async getAlbumTracks(): Promise<Song[]> {
    return [];
  }

  /**
   * Download-first stream resolve. First play downloads once (shared
   * in-flight promise), validates, and commits the permanent offline Blob;
   * replays reuse the committed Blob with no yt-dlp, no search, no network.
   */
  async getStream(song: Song): Promise<StreamResult> {
    const videoId = youtubeVideoIdOf(song);
    if (!videoId) {
      throw new ProviderError('UNSUPPORTED', 'YouTube download failed (invalid video).');
    }
    try {
      const asset = await ensurePermanentYouTubeTrack(song);
      return {
        url: asset.objectUrl,
        mimeType: asset.mimeType,
        quality: asset.fromCache ? 'MP3 (YouTube) · Offline' : 'MP3 (YouTube)',
        allowsOffline: true,
        downloadUrl: asset.objectUrl,
        license: YOUTUBE_LICENSE,
        sourceUrl: song.sourceUrl,
      };
    } catch (sidecarError) {
      // No sidecar: same download-first semantics through the native host.
      // NOTE: a native attempt that FAILS must surface its own cause — the
      // sidecar's "disabled" is misleading once we tried on-device extraction
      // (e.g. YouTube 403/unreachable/validation). Swallowing it here is what
      // produced "[PROVIDER_ERROR] ... (sidecar disabled)" in the APK even
      // though search (nativeSearch) worked fine.
      try {
        const { canUseNativeYouTube, ensureNativeYouTubeTrack, nativeErrorOf } = await import('./device');
        if (canUseNativeYouTube()) {
          try {
            const asset = await ensureNativeYouTubeTrack(song);
            return {
              url: asset.objectUrl,
              mimeType: asset.mimeType,
              quality: asset.fromCache ? 'Audio (YouTube) · Offline' : 'Audio (YouTube)',
              allowsOffline: true,
              downloadUrl: asset.objectUrl,
              license: YOUTUBE_LICENSE,
              sourceUrl: song.sourceUrl,
            };
          } catch (nativeError) {
            if ((nativeError as Error)?.name === 'AbortError') throw nativeError;
            throw nativeErrorOf(nativeError, 'YouTube download failed');
          }
        }
      } catch (nativeOrImportError) {
        // Native was attempted (or the import itself failed): its cause is
        // more honest than the sidecar's "disabled". Only fall through to the
        // sidecar mapping when native was never attempted (canUse === false).
        const msg =
          nativeOrImportError instanceof Error
            ? nativeOrImportError.message
            : typeof nativeOrImportError === 'string'
              ? nativeOrImportError
              : '';
        const neverAttempted =
          sidecarError instanceof Error &&
          /sidecar (disabled|not running|unavailable)/i.test(sidecarError.message) &&
          /Cannot find module|Failed to fetch dynamically|Failed to import/i.test(msg);
        if (!neverAttempted) throw nativeOrImportError;
        // else: dynamic import itself broken — fall through to sidecar mapping.
      }
      const e = sidecarError;
      if (e instanceof ProviderError) throw e;
      const msg =
        e instanceof Error ? e.message : typeof e === 'string' ? e : 'YouTube download failed';
      // Layer-honest mapping (never raw stderr, never huge dumps). Native
      // (Rust) causes arrive verbatim now — map each known one to a short
      // user-facing message instead of the old catch-all.
      if (/yt-dlp executable not found/i.test(msg)) {
        throw new ProviderError('NETWORK', 'YouTube service unavailable (yt-dlp executable not found).');
      }
      if (/FFmpeg executable not found/i.test(msg)) {
        throw new ProviderError('NETWORK', 'YouTube service unavailable (FFmpeg executable not found).');
      }
      if (/YouTube service unavailable/i.test(msg)) {
        throw new ProviderError('NETWORK', 'YouTube service unavailable.');
      }
      if (/No playable audio/i.test(msg)) {
        throw new ProviderError('UNSUPPORTED', 'YouTube has no playable audio for this video.');
      }
      if (/Invalid video identifier|invalid video/i.test(msg)) {
        throw new ProviderError('UNSUPPORTED', 'YouTube download failed (invalid video).');
      }
      if (/HTTP 403/i.test(msg)) {
        throw new ProviderError('NETWORK', 'YouTube refused the download (blocked network) — retry on Wi-Fi or another network.');
      }
      if (/YouTube download failed \(HTTP (\d{3})\)/i.test(msg)) {
        const code = msg.match(/HTTP (\d{3})/)?.[1] ?? '';
        throw new ProviderError('NETWORK', `YouTube download failed (HTTP ${code}).`);
      }
      if (/cannot (create audio store|write audio file|publish audio file)/i.test(msg)) {
        throw new ProviderError('NETWORK', 'Could not save the audio file (storage unavailable).');
      }
      if (/timed out/i.test(msg)) {
        throw new ProviderError('TIMEOUT', 'YouTube download timed out.');
      }
      if (/Audio validation failed/i.test(msg)) {
        throw new ProviderError('NETWORK', 'YouTube download failed (audio validation failed).');
      }
      throw new ProviderError('NETWORK', 'YouTube download failed.');
    }
  }

  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkUrl ?? null;
  }

  async getLyrics(): Promise<null> {
    return null;
  }

  async canDownload(_song: Song): Promise<boolean> {
    return true;
  }

  async getDownload(): Promise<{ url: string; mimeType: string } | null> {
    // YouTube downloads flow through the download-first pipeline
    // (DownloadManager branches to it); there is no direct remote URL.
    return null;
  }

  /** Trigger a YouTube download and commit the permanent offline copy. */
  async downloadAndStore(song: Song): Promise<{ filePath: string; sizeBytes: number }> {
    const videoId = youtubeVideoIdOf(song);
    if (!videoId) {
      throw new ProviderError('UNSUPPORTED', 'YouTube download failed (invalid video).');
    }
    try {
      const asset = await ensurePermanentYouTubeTrack(song);
      // Renderer-side permanent truth is the offlineRepo Blob (song id doubles
      // as the stable local path — no temp paths leak to callers).
      return { filePath: `offline:youtube:${videoId}`, sizeBytes: asset.sizeBytes };
    } catch (sidecarError) {
      const { canUseNativeYouTube, ensureNativeYouTubeTrack } = await import('./device');
      if (!canUseNativeYouTube()) throw sidecarError;
      const asset = await ensureNativeYouTubeTrack(song);
      return { filePath: `offline:youtube:${videoId}`, sizeBytes: asset.sizeBytes };
    }
  }
}

// Export for registration
export { YOUTUBE_PROVIDER_ID, YOUTUBE_LICENSE };
