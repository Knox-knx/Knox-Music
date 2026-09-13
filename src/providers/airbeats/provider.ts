// AirBeats provider — first-class KNOX MusicProvider (id: "airbeats").
//
// Observed capabilities (verified live 2026-09-09, no authentication):
// - Search: YES (songs, artists, albums, playlists — dedicated endpoints)
// - Metadata: YES (title, artists, album, artwork tiers, year, copyright)
// - Streaming: YES — full-length audio via the explicit `downloadUrl` tiers
//   (320kbps preferred; HEAD-verified audio/mp4, range requests, CORS *)
// - Download/offline: YES — the API explicitly provides `downloadUrl` files
//   (stable Azure blobs, no expiry tokens observed); per-track flag follows
//   whether a playable file exists. Streaming ≠ download is respected in the
//   mapping: a track without any file is streamable=false/downloadable=false.
// - Lyrics: NO — GET /api/songs/{id}/lyrics is 404 live ("route not found"),
//   even for hasLyrics=true tracks. getLyrics() returns null honestly.
// - Suggestions: NO — GET /api/songs/{id}/suggestions is HTTP 500 live.
//
// Album/playlist detail use the QUERY-param forms (/api/albums?id=,
// /api/playlists?id=) — the path forms (/api/albums/{id}) are 404 live.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { MusicProvider, StreamResult } from '../types';
import { fetchJson, requireSafeMediaUrl } from '../http';
import { providerEnv } from '../env';
import { inferMimeTypeFromUrl } from '../../audio/mediaDiagnostics';
import {
  AIRBEATS_DOWNLOAD_UNAVAILABLE,
  AIRBEATS_STREAM_UNAVAILABLE,
  airbeatsClient,
} from './client';
import {
  mapAirbeatsAlbum,
  mapAirbeatsArtist,
  mapAirbeatsPlaylist,
  mapAirbeatsSong,
  mapAirbeatsSongs,
} from './mapper';
import {
  AIRBEATS_PROVIDER_ID,
  AIRBEATS_PROVIDER_NAME,
  type AirbeatsAlbumDetail,
  type AirbeatsPlaylistDetail,
} from './types';

export const AIRBEATS_LICENSE = 'AirBeats catalog audio — rights belong to the label/copyright holder reported per track';

const SEARCH_LIMIT = 20;
const MAX_QUERY_LENGTH = 256;

function cleanQuery(query: string): string {
  return (query ?? '').trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Honest quality label for the ACTUAL tier URL (§12): the mapper always
 * prefers the highest kbps tier, but a stale snapshot fallback may carry a
 * lower tier — the label must describe the bytes being played, not a wish.
 */
export function airbeatsQualityForUrl(url: string): string {
  const clean = (url ?? '').split('?')[0].split('#')[0];
  // Observed live tiers: …_<kbps>.mp4 (e.g. …_320.mp4, …_160.mp4).
  const tier = /_(\d+)\.mp4$/i.exec(clean);
  if (tier) return `${tier[1]}kbps (AirBeats)`;
  const m = /_(\d+)\s*kbps\.mp4$/i.exec(clean);
  if (m) return `${m[1]}kbps (AirBeats)`;
  const generic = /(\d+)\s*kbps/i.exec(url ?? '');
  if (generic) return `${generic[1]}kbps (AirBeats)`;
  return 'Audio (AirBeats)';
}

export class AirbeatsProvider implements MusicProvider {
  readonly id = AIRBEATS_PROVIDER_ID;
  readonly name = AIRBEATS_PROVIDER_NAME;
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true, // per-track: only when the API returns a playable file
    supportsLyrics: false, // /lyrics endpoint is 404 live — honestly disabled
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
    supportsMetadata: true,
    supportsDownloads: true, // explicit `downloadUrl` tiers in the contract
    // Local temp playback / offline: allowed where the API returns an authorized playable file (per-track gate).
    supportsPlaybackCache: true,
    cacheQuality: 'low' as const,
  };
  readonly offlineNotice =
    'AirBeats is an unofficial catalog mirror — offline files come from the provider-supplied download URLs; rights belong to the reported copyright holder.';

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = cleanQuery(query);
    if (!q) return [];
    if (signal?.aborted) return [];
    try {
      const data = await airbeatsClient.searchSongs(q, { limit: SEARCH_LIMIT, signal });
      const songs = mapAirbeatsSongs(data.results);
      logger.info('airbeats', `AIRBEATS_SEARCH songs ok (${songs.length})`);
      return songs;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      logger.warn('airbeats', 'AIRBEATS_SEARCH songs failed', String(e));
      throw e;
    }
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const q = cleanQuery(query);
    if (!q) return [];
    if (signal?.aborted) return [];
    try {
      const data = await airbeatsClient.searchArtists(q, { limit: SEARCH_LIMIT, signal });
      const out: Artist[] = [];
      for (const a of data.results ?? []) {
        try {
          const mapped = mapAirbeatsArtist(a);
          if (mapped) out.push(mapped);
        } catch {
          continue;
        }
      }
      return out;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      logger.warn('airbeats', 'AIRBEATS_SEARCH artists failed', String(e));
      throw e;
    }
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const q = cleanQuery(query);
    if (!q) return [];
    if (signal?.aborted) return [];
    try {
      const data = await airbeatsClient.searchAlbums(q, { limit: SEARCH_LIMIT, signal });
      const out: Album[] = [];
      for (const a of data.results ?? []) {
        try {
          const mapped = mapAirbeatsAlbum(a);
          if (mapped) out.push(mapped);
        } catch {
          continue;
        }
      }
      return out;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      logger.warn('airbeats', 'AIRBEATS_SEARCH albums failed', String(e));
      throw e;
    }
  }

  async searchPlaylists(query: string, signal?: AbortSignal): Promise<Playlist[]> {
    const q = cleanQuery(query);
    if (!q) return [];
    if (signal?.aborted) return [];
    try {
      const data = await airbeatsClient.searchPlaylists(q, { limit: SEARCH_LIMIT, signal });
      const out: Playlist[] = [];
      for (const p of data.results ?? []) {
        try {
          const mapped = mapAirbeatsPlaylist(p);
          if (mapped) out.push(mapped);
        } catch {
          continue;
        }
      }
      return out;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      logger.warn('airbeats', 'AIRBEATS_SEARCH playlists failed', String(e));
      throw e;
    }
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const id = (providerTrackId ?? '').trim().replace(/^airbeats:/, '');
    if (!id) return null;
    const raw = await airbeatsClient.getSongById(id).catch(() => null);
    if (!raw) return null;
    return mapAirbeatsSong(raw);
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    const id = (providerArtistId ?? '').trim().replace(/^airbeats:artist:/, '');
    if (!id) return null;
    const raw = await airbeatsClient.getArtistById(id).catch(() => null);
    if (!raw) return null;
    return mapAirbeatsArtist(raw);
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    const id = (providerAlbumId ?? '').trim().replace(/^airbeats:album:/, '');
    if (!id) return null;
    const raw = await airbeatsClient.getAlbumById(id).catch(() => null);
    if (!raw) return null;
    return mapAirbeatsAlbum(raw as AirbeatsAlbumDetail);
  }

  async getPlaylist(providerPlaylistId: string): Promise<Playlist | null> {
    const id = (providerPlaylistId ?? '').trim().replace(/^airbeats:playlist:/, '');
    if (!id) return null;
    const raw = await airbeatsClient.getPlaylistById(id).catch(() => null);
    if (!raw) return null;
    return mapAirbeatsPlaylist(raw as AirbeatsPlaylistDetail);
  }

  async getAlbumTracks(providerAlbumId: string): Promise<Song[]> {
    const id = (providerAlbumId ?? '').trim().replace(/^airbeats:album:/, '');
    if (!id) return [];
    const detail = await airbeatsClient.getAlbumById(id).catch(() => null);
    if (!detail || !Array.isArray(detail.songs)) return [];
    return mapAirbeatsSongs(detail.songs);
  }

  /** Provider-level stream resolver used by the player store (no UI logic). */
  async getStream(song: Song): Promise<StreamResult> {
    // Strict classification (Phase 5): AirBeats search → mapper → Track →
    // providerId=airbeats, referenceUrl=jiosaavn page, streamUrl=CDN audio tier.
    // A public music PAGE (jiosaavn.com/song/...) is sourceKind=web-reference,
    // playable=false and must NEVER enter AudioEngine. Only an authorized
    // audio tier (aac.saavncdn.com …_320.mp4, https) may become audio-stream.
    // Never weaken validation to make a page play.
    let src: Song = song;
    try {
      const fresh = await this.getSong(song.providerTrackId);
      if (fresh?.streamUrl) src = fresh;
    } catch {
      // Fall back to the search-time snapshot below.
    }
    if (!src.streamUrl) {
      throw new ProviderError(
        'NETWORK',
        `${AIRBEATS_STREAM_UNAVAILABLE}: AirBeats provided a web page rather than a playable audio source.`,
      );
    }
    // Defensive: if the snapshot is actually a music PAGE (not a CDN file),
    // reject as web-reference instead of handing HTML to the audio pipeline.
    // referenceUrl (page) must never become streamUrl by guessing.
    try {
      const host = new URL(src.streamUrl).hostname.toLowerCase();
      if (host === 'jiosaavn.com' || host.endsWith('.jiosaavn.com') || host === 'saavn.com' || host.endsWith('.saavn.com')) {
        throw new ProviderError(
          'NETWORK',
          `${AIRBEATS_STREAM_UNAVAILABLE}: AirBeats provided a web page rather than a playable audio source.`,
        );
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      // Unparseable streamUrl → fall through to requireSafeMediaUrl below.
    }
    // Scrubbed shape diagnostics (TEMP TESTING): on validation failure the
    // console shows protocol/host/length/whitespace — never the full URL
    // (tiers may carry signatures). This identifies WHAT leaked into
    // streamUrl without leaking tokens.
    const describeUrl = (u: unknown): string => {
      if (typeof u !== 'string' || !u) return 'missing';
      const s = u as string;
      let proto = '<unparseable>';
      let host = '-';
      try {
        const p = new URL(s);
        proto = p.protocol;
        host = p.hostname;
      } catch { /* keep defaults */ }
      return `proto=${proto} host=${host} len=${s.length} ws=${/\s/.test(s)}`;
    };
    // Scheme normalization (NOT guessing): a protocol-relative tier
    // (`//host/path`, as CDNs sometimes return) names the same host and
    // path — browsers resolve it against the page scheme. Inside the app
    // origin that would be `tauri:`, so pin it to `https:` explicitly,
    // then run the unchanged strict validator. Absolute URLs untouched.
    const pinScheme = (u: unknown): unknown => {
      if (typeof u !== 'string') return u;
      const t = u.trim();
      return t.startsWith('//') ? `https:${t}` : u;
    };
    src = { ...src, streamUrl: pinScheme(src.streamUrl) as string | undefined, downloadUrl: pinScheme(src.downloadUrl) as string | undefined };
    let url: string;
    try {
      url = requireSafeMediaUrl(src.streamUrl);
    } catch (e) {
      // Scrubbed shape travels WITH the error (no host path/query, no
      // tokens): the UI card + diagnostics then show WHY validation
      // failed (e.g. proto=tauri: means a schemeless URL resolved against
      // the app origin). Safe to display and log.
      const shape = describeUrl(src.streamUrl);
      try {
        console.error(
          `[knox:airbeats-temp-test] getStream URL REJECTED providerTrackId=${song.providerTrackId} ` +
            `stream=${shape} refreshed=${src !== song} ` +
            `downloadAllowed=${src.downloadAllowed} download=${describeUrl(src.downloadUrl)}`,
        );
      } catch { /* console best-effort */ }
      throw new ProviderError('NETWORK', `Provider returned an unsafe audio URL (${shape})`);
    }
    const downloadUrl = src.downloadAllowed && src.downloadUrl
      ? requireSafeMediaUrl(src.downloadUrl)
      : undefined;
    // Never assume every AirBeats media URL shares one container (§12):
    // infer the honest MIME from the actual tier URL (observed live:
    // aac.saavncdn.com …_320.mp4 → audio/mp4). Bytes are never altered.
    return {
      url,
      mimeType: inferMimeTypeFromUrl(url, 'audio/mp4'),
      quality: airbeatsQualityForUrl(url),
      allowsOffline: src.downloadAllowed === true,
      downloadUrl: src.downloadAllowed === true ? downloadUrl : undefined,
      license: src.license ?? AIRBEATS_LICENSE,
      sourceUrl: src.sourceUrl,
    };
  }

  async getArtwork(song: Song): Promise<string | null> {
    if (song.artworkUrl) return song.artworkUrl;
    // Artwork-only refresh (cheap metadata re-read, no audio involved).
    try {
      const fresh = await this.getSong(song.providerTrackId);
      return fresh?.artworkUrl ?? null;
    } catch {
      return null;
    }
  }

  /** Lyrics are not exposed by the live API (endpoint 404) — honest null. */
  async getLyrics(): Promise<null> {
    return null;
  }

  async canDownload(song: Song): Promise<boolean> {
    if (typeof song.downloadAllowed === 'boolean') return song.downloadAllowed;
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    return fresh?.downloadAllowed === true;
  }

  async getDownload(song: Song): Promise<{ url: string; mimeType: string } | null> {
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    const src = fresh ?? song;
    if (src.downloadAllowed !== true || !src.downloadUrl) {
      throw new ProviderError(
        'UNSUPPORTED',
        `${AIRBEATS_DOWNLOAD_UNAVAILABLE}: This AirBeats track cannot be saved offline.`,
      );
    }
    const url = requireSafeMediaUrl(src.downloadUrl);
    return { url, mimeType: inferMimeTypeFromUrl(url, 'audio/mp4') };
  }

  /** Raw reachability probe for diagnostics (never throws). */
  async checkHealth(): Promise<boolean> {
    const { checkAirbeatsHealth } = await import('./health');
    return checkAirbeatsHealth().then((s) => s === 'AVAILABLE').catch(() => false);
  }

  /** Validate that a link belongs to this catalog before resolving it. */
  async getSongByLink(link: string): Promise<Song | null> {
    const clean = (link ?? '').trim();
    if (!clean) return null;
    let host = '';
    try {
      host = new URL(clean).hostname.toLowerCase();
    } catch {
      return null;
    }
    // Observed live: track `url` values point at (subdomains of) jiosaavn.com.
    if (host !== 'jiosaavn.com' && !host.endsWith('.jiosaavn.com')) return null;
    const raw = await airbeatsClient.getSongByLink(clean).catch(() => null);
    return raw ? mapAirbeatsSong(raw) : null;
  }
}

/** Lightweight descriptor fetch used by caches/enrichment (no UI logic). */
export async function fetchAirbeatsTrackJson(id: string): Promise<unknown> {  const clean = (id ?? '').trim().replace(/^airbeats:/, '');
  if (!clean) return null;
  return fetchJson<unknown>(
    `${providerEnv.airbeatsBaseUrl}/api/songs/${encodeURIComponent(clean)}`,
    { timeoutMs: providerEnv.requestTimeoutMs, retries: 1 },
  ).catch(() => null);
}
