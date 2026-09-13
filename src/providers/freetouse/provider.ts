// FreeToUse provider — public API, no key (https://api.freetouse.com/v3).
// License: FreeToUse License (free use under conditions; commercial use
// requires a paid plan). Premium tracks stream but are NOT offered offline.
//
// NOTE (CORS): api.freetouse.com currently sends no
// `access-control-allow-origin` header, so direct browser fetch() calls are
// blocked by CORS and search degrades to partial results (Jamendo + Archive
// still work). For full results in dev, proxy same-origin via vite.config.ts:
//   VITE_FREETOUSE_API_BASE_URL=/api/freetouse
// (see .env.example). <audio> playback of data.freetouse.com MP3s is NOT
// affected by CORS — only fetch()/offline-download is.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import type { MusicProvider, StreamResult } from '../types';
import { fetchJson, requireSafeMediaUrl } from '../http';
import { providerEnv } from '../env';

interface FtuArtistRef { id: string; name: string }
type FtuArtistTuple = [number, FtuArtistRef];

interface FtuTrack {
  id: string;
  title: string;
  duration: number; // seconds (float)
  release_date?: string;
  genre?: string | null;
  /** Optional taxonomy the API may return — never required for validity. */
  categories?: (string | { name?: string })[] | null;
  tags?: (string | { name?: string })[] | null;
  is_premium?: boolean;
  artists?: FtuArtistTuple[];
  thumbnails?: { sm?: string; md?: string; lg?: string; xl?: string };
  files?: { mp3?: string };
}

interface FtuTrackDetail extends FtuTrack {
  record_label?: string;
}

interface FtuListResponse {
  ok?: boolean;
  data?: FtuTrack[];
}

interface FtuSingleResponse {
  ok?: boolean;
  data?: FtuTrackDetail | null;
}

interface FtuArtist {
  id: string;
  name: string;
  description?: string;
  thumbnails?: { sm?: string; md?: string; lg?: string; xl?: string };
}

export const FREETOUSE_LICENSE = 'FreeToUse License (free use under conditions; commercial requires a paid license)';

/** Public web base for canonical track links (never the dev-proxy path). */
export const FREETOUSE_PUBLIC_BASE = 'https://api.freetouse.com/v3';

/** Safe dev-only logging. Never logs secrets (this API uses none). */
function ftuLog(...args: unknown[]): void {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (env?.DEV) console.debug('[FreeToUse]', ...args);
  } catch {
    /* logging must never break search */
  }
}

export function artistNames(t: Pick<FtuTrack, 'artists'>): string {
  const list = (t.artists ?? []).map(([, a]) => a?.name).filter(Boolean);
  return list.length > 0 ? list.join(', ') : 'Unknown artist';
}

export function mapFreetouseTrack(t: FtuTrack): Song {
  const premium = t.is_premium === true;
  const art = t.thumbnails?.md || t.thumbnails?.lg || t.thumbnails?.sm || t.thumbnails?.xl;
  const firstArtist = t.artists?.[0]?.[1];
  // Genre fallback chain: genre → first category → first tag. Optional
  // metadata must never invalidate an otherwise playable track.
  const pickName = (v: unknown): string | undefined => {
    if (typeof v === 'string') {
      const s = v.trim();
      return s || undefined;
    }
    if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
      const s = ((v as { name: string }).name || '').trim();
      return s || undefined;
    }
    return undefined;
  };
  const firstCategory = Array.isArray(t.categories)
    ? t.categories.map(pickName).find(Boolean)
    : undefined;
  const firstTag = Array.isArray(t.tags) ? t.tags.map(pickName).find(Boolean) : undefined;
  const genre = (typeof t.genre === 'string' && t.genre.trim())
    ? t.genre.trim()
    : firstCategory || firstTag || undefined;
  return {
    id: `freetouse:${t.id}`,
    providerId: 'freetouse',
    providerTrackId: t.id,
    title: t.title || 'Untitled',
    artist: artistNames(t),
    artistId: firstArtist ? `freetouse:artist:${firstArtist.id}` : undefined,
    album: '',
    durationMs: Math.max(0, Math.round(Number(t.duration || 0) * 1000)),
    artworkUrl: art || undefined,
    streamUrl: t.files?.mp3 || undefined,
    downloadUrl: !premium && t.files?.mp3 ? t.files.mp3 : undefined,
    downloadAllowed: !premium,
    genre,
    year: t.release_date ? Number(String(t.release_date).slice(0, 4)) || undefined : undefined,
    license: FREETOUSE_LICENSE,
    sourceUrl: `${FREETOUSE_PUBLIC_BASE}/music/tracks/${t.id}`,
    addedAt: Date.now(),
  };
}

export class FreetouseProvider implements MusicProvider {
  readonly id = 'freetouse';
  readonly name = 'FreeToUse';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true, // per-track: false for premium tracks
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: false,
    // Local temp playback / offline: non-premium tracks only (per-track gate).
    supportsPlaybackCache: true,
    cacheQuality: 'low' as const,
  };
  readonly offlineNotice = 'Offline only for non-premium tracks (premium requires a paid license).';

  private base(): string {
    // Guard against `/api/freetouse/v3` style misconfiguration: the Vite dev
    // proxy already points at `/v3`, so appending `/music/...` must never
    // produce `/api/freetouse/v3/music/...`.
    const raw = providerEnv.freetouseBaseUrl.replace(/\/+$/, '');
    if (raw === '/api/freetouse/v3' || raw.endsWith('/api/freetouse/v3')) {
      return raw.replace(/\/v3$/, '');
    }
    return raw;
  }

  /** Canonical public track URL (absolute — never the relative proxy path). */
  private trackUrl(id: string): string {
    return `${FREETOUSE_PUBLIC_BASE}/music/tracks/${encodeURIComponent(id)}`;
  }

  private mapTrack(t: FtuTrack): Song {
    const s = mapFreetouseTrack(t);
    s.sourceUrl = this.trackUrl(t.id);
    return s;
  }

  async searchSongs(query: string, signal?: AbortSignal, offset = 0): Promise<Song[]> {
    const q = query.trim();
    if (!q) return [];
    ftuLog(`query=${JSON.stringify(q)}`);
    // URLSearchParams handles encoding (spaces, unicode, `&`, …).
    const params = new URLSearchParams({ query: q, limit: '20', offset: String(Math.max(0, offset)) });
    const url = `${this.base()}/music/tracks/search?${params.toString()}`;
    ftuLog(`request=${url}`);
    const data = await fetchJson<FtuListResponse>(url, {
      timeoutMs: providerEnv.requestTimeoutMs,
      retries: 2,
      signal,
    });
    // Official shape: { ok, data: [...], pagination }. Parse `data`, never
    // `results`. Tolerate `ok: false` / missing data as empty (not a throw —
    // isolation in ProviderManager turns real throws into partial results).
    const ok = (data as FtuListResponse | null)?.ok;
    const list = Array.isArray((data as FtuListResponse | null)?.data)
      ? ((data as FtuListResponse).data as FtuTrack[])
      : [];
    ftuLog(`status=ok=${String(ok)}`, `resultCount=${list.length}`);
    if (ok === false && list.length === 0) return [];
    // Never discard valid tracks for missing OPTIONAL metadata — only skip
    // entries without an id (unaddressable).
    return list
      .filter((t) => t && typeof (t as FtuTrack).id === 'string' && (t as FtuTrack).id)
      .map((t) => this.mapTrack(t));
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    // No dedicated artist-search endpoint: group real track results by artist.
    const songs = await this.searchSongs(query, signal);
    const q = query.trim().toLowerCase();
    const map = new Map<string, Artist>();
    for (const s of songs) {
      if (!s.artist.toLowerCase().includes(q)) continue;
      const key = s.artistId || `freetouse:artist:${s.artist}`;
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          providerId: 'freetouse',
          providerArtistId: key.replace(/^freetouse:artist:/, ''),
          name: s.artist,
          artworkUrl: s.artworkUrl,
        });
      }
      if (map.size >= 20) break;
    }
    return [...map.values()];
  }

  async searchAlbums(): Promise<Album[]> { return []; }
  async searchPlaylists(): Promise<Playlist[]> { return []; }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const data = await fetchJson<FtuSingleResponse>(
      `${this.base()}/music/tracks/${encodeURIComponent(providerTrackId)}`,
      { timeoutMs: providerEnv.requestTimeoutMs, retries: 2 },
    );
    if (!data.data) return null;
    return mapFreetouseTrack(data.data);
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    const data = await fetchJson<{ ok?: boolean; data?: FtuArtist | null }>(
      `${this.base()}/music/artists/${encodeURIComponent(providerArtistId)}`,
      { timeoutMs: providerEnv.requestTimeoutMs, retries: 2 },
    );
    const a = data.data;
    if (!a) return null;
    return {
      id: `freetouse:artist:${a.id}`,
      providerId: 'freetouse',
      providerArtistId: a.id,
      name: a.name,
      artworkUrl: a.thumbnails?.md || a.thumbnails?.lg || undefined,
      bio: a.description || undefined,
    };
  }

  async getAlbum(): Promise<Album | null> { return null; }
  async getPlaylist(): Promise<Playlist | null> { return null; }
  async getAlbumTracks(): Promise<Song[]> { return []; }

  async getStream(song: Song): Promise<StreamResult> {
    // Stream URL is stable (data.freetouse.com MP3); revalidate per-track
    // permission so premium tracks never become offline-eligible.
    let src: Song = song;
    try {
      const fresh = await this.getSong(song.providerTrackId);
      if (fresh) src = fresh;
    } catch {
      // Fall back to the search-time snapshot.
    }
    if (!src.streamUrl) throw new Error('No playable stream for this FreeToUse track');
    const url = requireSafeMediaUrl(src.streamUrl);
    const allowsOffline = src.downloadAllowed === true;
    return {
      url,
      mimeType: 'audio/mpeg',
      quality: 'MP3 (FreeToUse)',
      allowsOffline,
      downloadUrl: allowsOffline && src.downloadUrl ? requireSafeMediaUrl(src.downloadUrl) : undefined,
      license: FREETOUSE_LICENSE,
      sourceUrl: src.sourceUrl,
    };
  }

  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkUrl ?? null;
  }

  async getLyrics(): Promise<null> { return null; }

  async canDownload(song: Song): Promise<boolean> {
    if (typeof song.downloadAllowed === 'boolean') return song.downloadAllowed;
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    return fresh?.downloadAllowed === true;
  }

  async getDownload(song: Song): Promise<{ url: string; mimeType: string } | null> {
    const fresh = await this.getSong(song.providerTrackId).catch(() => song);
    if (!fresh || fresh.downloadAllowed !== true || !fresh.downloadUrl) return null;
    return { url: requireSafeMediaUrl(fresh.downloadUrl), mimeType: 'audio/mpeg' };
  }
}
