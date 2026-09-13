// Jamendo provider — real API (https://api.jamendo.com/v3.0).
// Public client_id only (VITE_JAMENDO_CLIENT_ID or default). No secrets.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { ProviderError } from '../../core/errors';
import type { MusicProvider, StreamResult } from '../types';
import { fetchJson, requireSafeMediaUrl } from '../http';
import { providerEnv } from '../env';

interface JamendoTrack {
  id: string;
  name: string;
  duration: number; // seconds
  artist_id: string;
  artist_name: string;
  artist_idstr?: string;
  album_name?: string;
  album_id?: string;
  license_ccurl?: string;
  releasedate?: string;
  album_image?: string;
  image?: string;
  audio?: string;
  audiodownload?: string;
  audiodownload_allowed?: boolean;
  shareurl?: string;
  shorturl?: string;
}

interface JamendoResponse<T> {
  headers?: { status?: string; code?: number; error_message?: string };
  results?: T[];
}

interface JamendoArtist {
  id: string;
  name: string;
  website?: string;
  image?: string;
}

interface JamendoAlbum {
  id: string;
  name: string;
  artist_id?: string;
  artist_name?: string;
  image?: string;
  releasedate?: string;
}

function clientIdOrThrow(): string {
  const id = providerEnv.jamendoClientId;
  if (!id) throw new ProviderError('UNSUPPORTED', 'Jamendo is not configured. Add a client_id in Providers settings.');
  return id;
}

export function mapJamendoTrack(t: JamendoTrack): Song {
  const year = t.releasedate ? Number(String(t.releasedate).slice(0, 4)) : undefined;
  const allowed = t.audiodownload_allowed === true;
  return {
    id: `jamendo:${t.id}`,
    providerId: 'jamendo',
    providerTrackId: String(t.id),
    title: t.name || 'Untitled',
    artist: t.artist_name || 'Unknown artist',
    artistId: t.artist_id ? `jamendo:artist:${t.artist_id}` : undefined,
    album: t.album_name || '',
    albumId: t.album_id ? `jamendo:album:${t.album_id}` : undefined,
    durationMs: Math.max(0, Math.round(Number(t.duration || 0) * 1000)),
    artworkUrl: t.album_image || t.image || undefined,
    streamUrl: t.audio || undefined,
    downloadUrl: allowed && t.audiodownload ? t.audiodownload : undefined,
    downloadAllowed: allowed,
    genre: undefined,
    year: Number.isFinite(year) ? year : undefined,
    license: t.license_ccurl || undefined,
    sourceUrl: t.shareurl || t.shorturl || undefined,
    addedAt: Date.now(),
  };
}

export class JamendoProvider implements MusicProvider {
  readonly id = 'jamendo';
  readonly name = 'Jamendo';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    // Provider-level switch stays on; per-track audiodownload_allowed decides.
    supportsOffline: true,
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
    // Local temp playback / offline: allowed where audiodownload_allowed permits (per-track gate).
    supportsPlaybackCache: true,
    cacheQuality: 'low' as const,
  };
  readonly offlineNotice = 'Offline storage only where Jamendo reports audiodownload_allowed.';

  private base(): string {
    return providerEnv.jamendoBaseUrl;
  }

  private async get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<T[]> {
    const cid = clientIdOrThrow();
    const qs = new URLSearchParams({ client_id: cid, format: 'json', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    const data = await fetchJson<JamendoResponse<T>>(`${this.base()}${path}?${qs.toString()}`, {
      timeoutMs: providerEnv.requestTimeoutMs,
      retries: 2,
      signal,
    });
    if (data.headers && data.headers.status === 'failed') {
      throw new ProviderError('NETWORK', data.headers.error_message || 'Jamendo request failed');
    }
    return data.results ?? [];
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.get<JamendoTrack>('/tracks/', {
      search: q, limit: 20, audioformat: 'mp32', imagesize: 300,
    }, signal);
    return rows.map(mapJamendoTrack);
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const q = query.trim();
    if (!q) return [];
    // NOTE: /artists/ does not accept `imagesize` (API warns) — image URLs
    // come back sized by default.
    const rows = await this.get<JamendoArtist>('/artists/', { namesearch: q, limit: 20 }, signal);
    return rows.map((a) => ({
      id: `jamendo:artist:${a.id}`,
      providerId: 'jamendo',
      providerArtistId: String(a.id),
      name: a.name,
      artworkUrl: a.image || undefined,
    }));
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const q = query.trim();
    if (!q) return [];
    const rows = await this.get<JamendoAlbum>('/albums/', { namesearch: q, limit: 20, imagesize: 300 }, signal);
    return rows.map((a) => ({
      id: `jamendo:album:${a.id}`,
      providerId: 'jamendo',
      providerAlbumId: String(a.id),
      title: a.name,
      artist: a.artist_name || '',
      artistId: a.artist_id ? `jamendo:artist:${a.artist_id}` : undefined,
      artworkUrl: a.image || undefined,
      year: a.releasedate ? Number(String(a.releasedate).slice(0, 4)) : undefined,
    }));
  }

  async searchPlaylists(query: string, signal?: AbortSignal): Promise<Playlist[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const rows = await this.get<{ id: string | number; name: string }>(
        '/playlists/', { namesearch: q, limit: 10 }, signal,
      );
      const now = Date.now();
      return rows.map((p) => ({
        id: `jamendo:playlist:${p.id}`,
        name: p.name,
        createdAt: now,
        updatedAt: now,
        trackIds: [],
        isUserPlaylist: false,
        providerId: 'jamendo',
        providerPlaylistId: String(p.id),
      }));
    } catch {
      return [];
    }
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const rows = await this.get<JamendoTrack>('/tracks/', { id: providerTrackId, audioformat: 'mp32', imagesize: 300 });
    const first = rows[0];
    return first ? mapJamendoTrack(first) : null;
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    const rows = await this.get<JamendoArtist>('/artists/', { id: providerArtistId, imagesize: 300 });
    const a = rows[0];
    if (!a) return null;
    return {
      id: `jamendo:artist:${a.id}`, providerId: 'jamendo',
      providerArtistId: String(a.id), name: a.name, artworkUrl: a.image || undefined,
    };
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    const rows = await this.get<JamendoAlbum>('/albums/', { id: providerAlbumId, imagesize: 300 });
    const a = rows[0];
    if (!a) return null;
    return {
      id: `jamendo:album:${a.id}`, providerId: 'jamendo', providerAlbumId: String(a.id),
      title: a.name, artist: a.artist_name || '', artworkUrl: a.image || undefined,
    };
  }

  async getPlaylist(): Promise<Playlist | null> { return null; }

  async getAlbumTracks(providerAlbumId: string): Promise<Song[]> {
    const rows = await this.get<JamendoTrack>('/tracks/', {
      album_id: providerAlbumId.replace(/^jamendo:album:/, ''), limit: 50, audioformat: 'mp32', imagesize: 300,
    });
    return rows.map(mapJamendoTrack);
  }

  async getStream(song: Song): Promise<StreamResult> {
    // Refresh so expiring signed audio URLs never go stale.
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    const src = fresh ?? song;
    const url = requireSafeMediaUrl((fresh?.streamUrl ?? song.streamUrl ?? (src as Song).streamUrl) || (src as unknown as JamendoTrack).audio);
    const allowsOffline = (src as Song).downloadAllowed === true;
    const downloadUrl = (src as Song).downloadUrl
      ? requireSafeMediaUrl((src as Song).downloadUrl)
      : undefined;
    return {
      url,
      mimeType: 'audio/mpeg',
      quality: 'MP3 (Jamendo)',
      allowsOffline,
      downloadUrl: allowsOffline ? downloadUrl : undefined,
      license: (src as Song).license,
      sourceUrl: (src as Song).sourceUrl,
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
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    const src = fresh ?? song;
    if (src.downloadAllowed !== true || !src.downloadUrl) return null;
    return { url: requireSafeMediaUrl(src.downloadUrl), mimeType: 'audio/mpeg' };
  }
}
