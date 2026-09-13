// AirBeats transport — thin wrapper over the shared fetchJson helper.
//
// All calls are unauthenticated GETs against https://api.airbeats.xyz
// (verified live: no API key, no login, CORS `*`). Timeouts, retries with
// backoff, and URL validation come from src/providers/http.ts so one slow
// AirBeats response can never hang KNOX search or playback.

import { ProviderError } from '../../core/errors';
import { fetchJson } from '../http';
import { providerEnv } from '../env';
import {
  AIRBEATS_DEFAULT_LIMIT,
  AIRBEATS_DEFAULT_PAGE,
  AIRBEATS_MAX_LIMIT,
  type AirbeatsAlbumDetail,
  type AirbeatsAlbumSearchData,
  type AirbeatsArtistDetail,
  type AirbeatsArtistSongsData,
  type AirbeatsArtistSearchData,
  type AirbeatsFailure,
  type AirbeatsPlaylistDetail,
  type AirbeatsPlaylistSearchData,
  type AirbeatsSong,
  type AirbeatsSongSearchData,
} from './types';

// Structured error labels (§13). These travel as ProviderError messages with
// a stable AIRBEATS_ prefix; the user-facing text stays friendly (see
// messageForAirbeatsError) — raw stack traces never reach the UI.
export const AIRBEATS_TIMEOUT = 'AIRBEATS_TIMEOUT';
export const AIRBEATS_UNAVAILABLE = 'AIRBEATS_UNAVAILABLE';
export const AIRBEATS_RATE_LIMITED = 'AIRBEATS_RATE_LIMITED';
export const AIRBEATS_INVALID_RESPONSE = 'AIRBEATS_INVALID_RESPONSE';
export const AIRBEATS_AUTH_REQUIRED = 'AIRBEATS_AUTH_REQUIRED';
export const AIRBEATS_TRACK_NOT_FOUND = 'AIRBEATS_TRACK_NOT_FOUND';
export const AIRBEATS_STREAM_UNAVAILABLE = 'AIRBEATS_STREAM_UNAVAILABLE';
export const AIRBEATS_DOWNLOAD_UNAVAILABLE = 'AIRBEATS_DOWNLOAD_UNAVAILABLE';

/** Friendly user-facing message for an AirBeats failure (no internals). */
export function messageForAirbeatsError(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'TIMEOUT':
        return 'AirBeats is taking too long to respond.';
      case 'RATE_LIMIT':
        return 'AirBeats is temporarily rate-limited. Try again shortly.';
      case 'NOT_FOUND':
        return 'This track is no longer available on AirBeats.';
      case 'UNSUPPORTED':
        return 'This action is not supported by AirBeats.';
      default:
        return 'AirBeats is temporarily unavailable.';
    }
  }
  return 'AirBeats is temporarily unavailable.';
}

function base(): string {
  return providerEnv.airbeatsBaseUrl;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return AIRBEATS_DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), AIRBEATS_MAX_LIMIT);
}

/** Map transport failures to structured AirBeats errors (never raw). */
export function toAirbeatsError(e: unknown, fallback = AIRBEATS_UNAVAILABLE): ProviderError {
  if (e instanceof ProviderError) {
    if (e.code === 'TIMEOUT') return new ProviderError('TIMEOUT', `${AIRBEATS_TIMEOUT}: AirBeats is taking too long to respond.`);
    if (e.code === 'RATE_LIMIT') return new ProviderError('RATE_LIMIT', `${AIRBEATS_RATE_LIMITED}: AirBeats is temporarily rate-limited.`);
    if (e.code === 'NOT_FOUND') return new ProviderError('NOT_FOUND', `${AIRBEATS_TRACK_NOT_FOUND}: ${e.message}`);
    return new ProviderError(e.code, `${fallback}: ${e.message}`);
  }
  if ((e as Error)?.name === 'AbortError') throw e as Error;
  return new ProviderError('NETWORK', `${fallback}: AirBeats is temporarily unavailable.`);
}

async function get<T>(path: string, params: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && String(v).length > 0) qs.set(k, String(v));
  }
  const url = `${base()}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  try {
    return await fetchJson<T>(url, {
      timeoutMs: providerEnv.requestTimeoutMs,
      retries: 2,
      signal,
    });
  } catch (e) {
    throw toAirbeatsError(e);
  }
}

/** Success-envelope guard: { success: true, data } vs { success: false, … }. */
export function airbeatsData<T>(body: { success?: boolean; data?: T } | null | undefined): T | null {
  if (!body || typeof body !== 'object') return null;
  if ((body as AirbeatsFailure).success === false) return null;
  if (!('data' in body) || (body as { data?: T }).data === undefined) return null;
  return (body as { data: T }).data;
}

export const airbeatsClient = {
  base,

  /** GET /api/search/songs?query=&page=&limit= (verified live). */
  async searchSongs(query: string, opts: { page?: number; limit?: number; signal?: AbortSignal } = {}): Promise<AirbeatsSongSearchData> {
    const data = await get<{ success?: boolean; data?: AirbeatsSongSearchData }>(
      '/api/search/songs',
      { query: query.trim(), page: opts.page ?? AIRBEATS_DEFAULT_PAGE, limit: clampLimit(opts.limit ?? AIRBEATS_DEFAULT_LIMIT) },
      opts.signal,
    );
    return airbeatsData(data) ?? { results: [] };
  },

  /** GET /api/search/albums?query=&limit= (verified live). */
  async searchAlbums(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<AirbeatsAlbumSearchData> {
    const data = await get<{ success?: boolean; data?: AirbeatsAlbumSearchData }>(
      '/api/search/albums',
      { query: query.trim(), limit: clampLimit(opts.limit ?? AIRBEATS_DEFAULT_LIMIT) },
      opts.signal,
    );
    return airbeatsData(data) ?? { results: [] };
  },

  /** GET /api/search/artists?query= (verified live). */
  async searchArtists(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<AirbeatsArtistSearchData> {
    const data = await get<{ success?: boolean; data?: AirbeatsArtistSearchData }>(
      '/api/search/artists',
      { query: query.trim(), limit: clampLimit(opts.limit ?? AIRBEATS_DEFAULT_LIMIT) },
      opts.signal,
    );
    return airbeatsData(data) ?? { results: [] };
  },

  /** GET /api/search/playlists?query= (verified live). */
  async searchPlaylists(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<AirbeatsPlaylistSearchData> {
    const data = await get<{ success?: boolean; data?: AirbeatsPlaylistSearchData }>(
      '/api/search/playlists',
      { query: query.trim(), limit: clampLimit(opts.limit ?? AIRBEATS_DEFAULT_LIMIT) },
      opts.signal,
    );
    return airbeatsData(data) ?? { results: [] };
  },

  /**
   * GET /api/songs/{id} (verified live — data is a one-element array).
   * Invalid ids return HTTP 404 { success: false, message: "song not found" }
   * which surfaces as null (callers treat it as "not found", not a crash).
   */
  async getSongById(id: string, signal?: AbortSignal): Promise<AirbeatsSong | null> {
    const clean = id.trim().replace(/^airbeats:/, '');
    if (!clean || /[\\/]/.test(clean) || clean.includes('..')) return null;
    let body: { success?: boolean; data?: AirbeatsSong[] };
    try {
      body = await get<{ success?: boolean; data?: AirbeatsSong[] }>(
        `/api/songs/${encodeURIComponent(clean)}`,
        {},
        signal,
      );
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
    const list = airbeatsData(body);
    const first = Array.isArray(list) ? list[0] : null;
    return first && typeof first.id === 'string' && first.id ? first : null;
  },

  /** GET /api/songs?link= (verified live — same detail shape). */
  async getSongByLink(link: string, signal?: AbortSignal): Promise<AirbeatsSong | null> {
    const clean = link.trim();
    if (!clean) return null;
    let body: { success?: boolean; data?: AirbeatsSong[] };
    try {
      body = await get<{ success?: boolean; data?: AirbeatsSong[] }>('/api/songs', { link: clean }, signal);
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
    const list = airbeatsData(body);
    const first = Array.isArray(list) ? list[0] : null;
    return first && typeof first.id === 'string' && first.id ? first : null;
  },

  /** GET /api/artists/{id} (verified live). Empty-name records mean "unknown". */
  async getArtistById(id: string, signal?: AbortSignal): Promise<AirbeatsArtistDetail | null> {
    const clean = id.trim().replace(/^airbeats:artist:/, '');
    if (!clean || /[\\/]/.test(clean) || clean.includes('..')) return null;
    const body = await get<{ success?: boolean; data?: AirbeatsArtistDetail }>(
      `/api/artists/${encodeURIComponent(clean)}`,
      {},
      signal,
    );
    const detail = airbeatsData(body);
    if (!detail || typeof detail.name !== 'string' || !detail.name.trim()) return null;
    return detail;
  },

  /** GET /api/artists/{id}/songs (verified live). */
  async getArtistSongs(id: string, signal?: AbortSignal): Promise<AirbeatsSong[]> {
    const clean = id.trim().replace(/^airbeats:artist:/, '');
    if (!clean || /[\\/]/.test(clean) || clean.includes('..')) return [];
    const body = await get<{ success?: boolean; data?: AirbeatsArtistSongsData }>(
      `/api/artists/${encodeURIComponent(clean)}/songs`,
      {},
      signal,
    );
    const data = airbeatsData(body);
    return Array.isArray(data?.songs) ? (data.songs as AirbeatsSong[]) : [];
  },

  /**
   * GET /api/albums?id= (QUERY param — verified live; the path form
   * /api/albums/{id} is 404). Empty-name records mean "unknown".
   */
  async getAlbumById(id: string, signal?: AbortSignal): Promise<AirbeatsAlbumDetail | null> {
    const clean = id.trim().replace(/^airbeats:album:/, '');
    if (!clean) return null;
    const body = await get<{ success?: boolean; data?: AirbeatsAlbumDetail }>('/api/albums', { id: clean }, signal);
    const detail = airbeatsData(body);
    if (!detail || typeof detail.name !== 'string' || !detail.name.trim()) return null;
    return detail;
  },

  /**
   * GET /api/playlists?id= (QUERY param — verified live; the path form
   * /api/playlists/{id} is 404). Invalid ids return HTTP 500.
   */
  async getPlaylistById(id: string, signal?: AbortSignal): Promise<AirbeatsPlaylistDetail | null> {
    const clean = id.trim().replace(/^airbeats:playlist:/, '');
    if (!clean) return null;
    let body: { success?: boolean; data?: AirbeatsPlaylistDetail };
    try {
      body = await get<{ success?: boolean; data?: AirbeatsPlaylistDetail }>('/api/playlists', { id: clean }, signal);
    } catch (e) {
      if (e instanceof ProviderError && (e.code === 'NOT_FOUND' || e.code === 'NETWORK')) {
        // Invalid playlist ids surface as HTTP 500 upstream — treat as
        // "not found", not a provider outage.
        return null;
      }
      throw e;
    }
    const detail = airbeatsData(body);
    if (!detail || typeof detail.name !== 'string' || !detail.name.trim()) return null;
    return detail;
  },
};
