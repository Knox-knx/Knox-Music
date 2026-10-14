// YouTubeMusicProvider — in-app server provider for KNOX Music (YouTube Music / InnerTube).
//
// Architecture:
//   KNOX UI → ProviderManager → YouTubeMusicProvider → loopback sidecar / native InnerTube
//   Playback & Downloads → ensureInAppProviderTrack (shared permanent offline audio engine)

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { MusicProvider, StreamResult } from '../types';
import { providerEnv } from '../env';
import { ensureInAppProviderTrack } from '../youtube/youtubeOffline';
import { sidecarJson } from './client';
import {
  YOUTUBE_MUSIC_LICENSE,
  YOUTUBE_MUSIC_PROVIDER_ID,
  albumsFromSongs,
  artistsFromSongs,
  mapSearchResults,
  mapYouTubeMusicAlbum,
  mapYouTubeMusicArtist,
  mapYouTubeMusicTrack,
  playlistsFromSongs,
  videoIdFromQualified,
} from './mapper';
import { checkYouTubeMusicHealth } from './health';
import { searchYouTubeMusic } from './search';
import type {
  YouTubeMusicAlbumResponse,
  YouTubeMusicArtistResponse,
  YouTubeMusicSearchResponse,
  YouTubeMusicTrackResponse,
} from './types';

export { YOUTUBE_MUSIC_LICENSE, YOUTUBE_MUSIC_PROVIDER_ID };
export { checkYouTubeMusicHealth, searchYouTubeMusic };
export * from './mapper';
export * from './types';

export class YouTubeMusicProvider implements MusicProvider {
  readonly id = YOUTUBE_MUSIC_PROVIDER_ID;
  readonly name = 'YouTube Music';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true,
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
    supportsMetadata: true,
    supportsDownloads: true,
    commercialCatalog: true,
    supportsPlaybackCache: false,
  };
  readonly offlineNotice =
    'YouTube Music tracks are downloaded and saved locally via the in-app server for offline playback.';

  private unavailable(): ProviderError {
    return new ProviderError(
      'NETWORK',
      'YouTube Music is unavailable (start the local service or disable the provider).',
    );
  }

  /** Sidecar health probe (short timeout). False = unavailable, never throws. */
  async checkHealth(): Promise<boolean> {
    const ok = await checkYouTubeMusicHealth();
    logger.info('youtube-music', ok ? 'YOUTUBE_MUSIC_READY' : 'YOUTUBE_MUSIC_ERROR health probe failed');
    return ok;
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = (query ?? '').trim();
    if (!q) return [];
    try {
      return await searchYouTubeMusic(q, signal);
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'UNSUPPORTED') throw e;
      if (e instanceof ProviderError) throw e;
      throw this.unavailable();
    }
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const songs = await this.searchSongs(query, signal).catch(() => [] as Song[]);
    return artistsFromSongs(songs, query);
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const songs = await this.searchSongs(query, signal).catch(() => [] as Song[]);
    return albumsFromSongs(songs, query);
  }

  async searchPlaylists(): Promise<Playlist[]> {
    return playlistsFromSongs();
  }

  /**
   * Fetch a real-time YouTube Music Mix / Radio playlist (`RDAMVM<videoId>`)
   * for a seed track.
   */
  async getMixPlaylist(providerTrackId: string, signal?: AbortSignal): Promise<Song[]> {
    const videoId = videoIdFromQualified(providerTrackId);
    if (!videoId || signal?.aborted) return [];
    try {
      const { getProviderManager } = await import('../ProviderManager');
      const yt = getProviderManager().get('youtube') as unknown as {
        getMixPlaylist?: (vid: string, s?: AbortSignal) => Promise<Song[]>;
      } | undefined;
      if (!yt || typeof yt.getMixPlaylist !== 'function') return [];
      const mixSongs = await yt.getMixPlaylist(videoId, signal);
      return mixSongs.map((s) => {
        const vid = String(s.providerTrackId || s.id).replace(/^youtube(-music)?:/, '');
        return {
          ...s,
          id: `${YOUTUBE_MUSIC_PROVIDER_ID}:${vid}`,
          providerId: YOUTUBE_MUSIC_PROVIDER_ID,
          providerTrackId: vid,
          license: YOUTUBE_MUSIC_LICENSE,
        };
      });
    } catch {
      return [];
    }
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const videoId = videoIdFromQualified(providerTrackId);
    if (!videoId) return null;
    const data = await sidecarJson<YouTubeMusicTrackResponse>(
      `track/${encodeURIComponent(videoId)}`,
      '',
      providerEnv.requestTimeoutMs,
    ).catch(() => undefined);
    if (!data) throw this.unavailable();
    const maybeErr = (data as unknown as { error?: { code?: string } }).error;
    if (maybeErr) {
      if (maybeErr.code === 'NOT_FOUND') return null;
      throw this.unavailable();
    }
    const raw = (data as YouTubeMusicTrackResponse).track;
    if (!raw) return null;
    try {
      return mapYouTubeMusicTrack(raw);
    } catch {
      return null;
    }
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    if (!providerArtistId || /[\\/]/.test(providerArtistId) || providerArtistId.includes('..')) return null;
    const clean = providerArtistId.replace(/^youtube-music:artist:/, '');
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(clean) || clean.includes(' ')) {
      return mapYouTubeMusicArtist({ id: providerArtistId, name: clean });
    }
    const data = await sidecarJson<YouTubeMusicArtistResponse>(
      `artist/${encodeURIComponent(clean)}`,
      '',
      providerEnv.requestTimeoutMs,
    ).catch(() => undefined);
    if (!data) return null;
    try {
      return mapYouTubeMusicArtist(data.artist ?? { id: providerArtistId, name: clean });
    } catch {
      return null;
    }
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    if (!providerAlbumId || /[\\/]/.test(providerAlbumId) || providerAlbumId.includes('..')) return null;
    const clean = providerAlbumId.replace(/^youtube-music:album:/, '');
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(clean) || clean.includes(' ')) {
      return mapYouTubeMusicAlbum({ id: providerAlbumId, title: clean });
    }
    const data = await sidecarJson<YouTubeMusicAlbumResponse>(
      `album/${encodeURIComponent(clean)}`,
      '',
      providerEnv.requestTimeoutMs,
    ).catch(() => undefined);
    if (!data) return null;
    try {
      return mapYouTubeMusicAlbum(data.album ? { id: providerAlbumId, title: data.album.title ?? clean } : null);
    } catch {
      return null;
    }
  }

  async getPlaylist(): Promise<Playlist | null> {
    return null;
  }

  async getAlbumTracks(): Promise<Song[]> {
    return [];
  }

  /** Resolve audio stream via the in-app permanent download-first engine. */
  async getStream(song: Song): Promise<StreamResult> {
    const videoId = videoIdFromQualified(song.providerTrackId || song.id);
    if (!videoId) {
      throw new ProviderError('UNSUPPORTED', 'YouTube Music download failed (invalid video).');
    }
    try {
      const asset = await ensureInAppProviderTrack(song);
      return {
        url: asset.objectUrl,
        mimeType: asset.mimeType,
        quality: asset.fromCache ? 'Audio (YouTube Music) · Offline' : 'Audio (YouTube Music)',
        allowsOffline: true,
        downloadUrl: asset.objectUrl,
        license: YOUTUBE_MUSIC_LICENSE,
        sourceUrl: song.sourceUrl,
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const msg = e instanceof Error ? e.message : 'YouTube Music download failed';
      throw new ProviderError('NETWORK', msg);
    }
  }

  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkUrl ?? null;
  }

  async getLyrics(): Promise<null> {
    return null;
  }

  async canDownload(_song?: Song): Promise<boolean> {
    return true;
  }

  async getDownload(): Promise<null> {
    return null;
  }

  /** Direct search-shape mapping helper (unit-test seam, shape-drift safe). */
  mapResponse(data: YouTubeMusicSearchResponse): Song[] {
    const results = (data as YouTubeMusicSearchResponse)?.results;
    if (!Array.isArray(results)) return [];
    return mapSearchResults(results);
  }
}
