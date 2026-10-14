// YouTubeMusicProvider — discovery/metadata only (YouTube Music / InnerTube).
//
// Architecture: KNOX never talks to InnerTube endpoints directly.
// All traffic goes to a bundled/local sidecar on loopback:
//
//   KNOX UI → ProviderManager → YouTubeMusicProvider → http://127.0.0.1:<port> → InnerTube
//
// - Enabled by default; disabling never affects other providers.
// - Sidecar down → honest ProviderError (isolated by ProviderManager, health
//   manager marks it down, app continues normally). Never crashes KNOX.
// - Capabilities are discovery-only: search/metadata YES, streaming NO,
//   download NO, offline NO. No stream URLs are invented, no audio is
//   extracted, no DRM/access-control bypass is attempted anywhere.
// - No Google login, no API key, no cookies for basic public search.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { MusicProvider, StreamResult } from '../types';
import { providerEnv } from '../env';
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
    supportsStreaming: false, // discovery only — no audio access
    supportsOffline: false,
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
    supportsMetadata: true,
    supportsDownloads: false,
    commercialCatalog: true,
    // Discovery-only: NEVER cached, downloaded, or stored. The manager
    // additionally refuses any provider with supportsStreaming === false.
    supportsPlaybackCache: false,
  };
  readonly offlineNotice =
    'YouTube Music is discovery-only in KNOX — playback, download, and offline storage are not available from this source.';

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
      // Validation errors (empty/over-long) surface honestly; transport
      // failures become the standard unavailable error. Either way the
      // ProviderManager isolates the failure — global search continues.
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
    // Derived name-ids (from song subtitles) have no browse page — the
    // search-time view is already honest. Only browse-backed ids resolve.
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

  /** Discovery-only: there is no authorized audio URL — always rejects. */
  async getStream(_song: Song): Promise<StreamResult> {
    throw new ProviderError(
      'UNSUPPORTED',
      'Playback isn\u2019t available for this source. This result is for discovery only.',
    );
  }

  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkUrl ?? null;
  }

  async getLyrics(): Promise<null> {
    // Lyrics resolve centrally via LRCLIB from title/artist/album/duration.
    return null;
  }

  async canDownload(): Promise<boolean> {
    return false;
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
