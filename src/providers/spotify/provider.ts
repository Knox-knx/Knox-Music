// SpotifyProvider — in-app server provider for KNOX Music.
//
// Full in-app server capabilities:
//   - Public URL / URI metadata scraping (HTML OpenGraph/JSON-LD + oEmbed)
//   - Catalog search via Spotify Web API v1 (when token is set) or in-app
//     catalog server fallback (zero setup required)
//   - In-app streaming & permanent offline downloads via `ensureInAppProviderTrack`

import { ProviderError } from '../../core/errors';
import type { Album, Artist, Playlist, Song } from '../../core/types';
import type { MusicProvider, StreamResult } from '../types';
import { ensureInAppProviderTrack } from '../youtube/youtubeOffline';
import {
  mapSpotifyAlbum,
  mapSpotifyArtist,
  mapSpotifyPlaylist,
  mapSpotifyTrack,
  mapSpotifyTracks,
} from './mapper';
import {
  detectSpotifyUrlOrUri,
  fetchSpotifyRecommendations,
  isValidSpotifyId,
  scrapeSpotifyPageReference,
  searchSpotifyCatalog,
} from './scraper';
import { SPOTIFY_LICENSE, SPOTIFY_PROVIDER_ID, SPOTIFY_PROVIDER_NAME } from './types';

export class SpotifyProvider implements MusicProvider {
  readonly id = SPOTIFY_PROVIDER_ID;
  readonly name = SPOTIFY_PROVIDER_NAME;
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
    supportsPlaybackCache: true,
  };
  readonly offlineNotice =
    'Spotify tracks are resolved and saved locally via the in-app server for offline playback.';

  async checkHealth(): Promise<boolean> {
    return true;
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const { tracks } = await searchSpotifyCatalog(q, { limit: 25, signal });
      return mapSpotifyTracks(tracks);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      throw new ProviderError('NETWORK', 'Spotify search is currently unavailable.');
    }
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const { artists } = await searchSpotifyCatalog(q, { limit: 20, signal });
      return artists.map(mapSpotifyArtist).filter((a): a is Artist => a !== null);
    } catch {
      return [];
    }
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const { albums } = await searchSpotifyCatalog(q, { limit: 20, signal });
      return albums.map(mapSpotifyAlbum).filter((a): a is Album => a !== null);
    } catch {
      return [];
    }
  }

  async searchPlaylists(query: string, signal?: AbortSignal): Promise<Playlist[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const { playlists } = await searchSpotifyCatalog(q, { limit: 20, signal });
      return playlists.map(mapSpotifyPlaylist).filter((p): p is Playlist => p !== null);
    } catch {
      return [];
    }
  }

  /**
   * Fetch a real-time Spotify station / recommendation mix for a seed track.
   */
  async getMixPlaylist(
    providerTrackId: string,
    signal?: AbortSignal,
    seed?: { title?: string; artist?: string; album?: string; queryHint?: string },
  ): Promise<Song[]> {
    const clean = (providerTrackId ?? '').trim().replace(/^spotify:(track:)?/, '');
    if (!clean || signal?.aborted) return [];
    try {
      const records = await fetchSpotifyRecommendations(clean, {
        ...seed,
        limit: 40,
        signal,
      });
      return mapSpotifyTracks(records);
    } catch {
      return [];
    }
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const raw = (providerTrackId ?? '').trim().replace(/^spotify:(track:)?/, '');
    if (!raw) return null;

    const targetUrl =
      raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('spotify:')
        ? raw
        : isValidSpotifyId(raw)
          ? `https://open.spotify.com/track/${raw}`
          : null;
    if (!targetUrl) return null;

    const detected = detectSpotifyUrlOrUri(targetUrl);
    const ref = await scrapeSpotifyPageReference(targetUrl);
    if (!ref || !ref.title) return null;

    return mapSpotifyTrack({
      id: detected?.id || ref.providerId || raw,
      title: ref.title,
      artist: ref.artist || 'Unknown artist',
      album: ref.album,
      durationMs: ref.durationMs,
      artworkUrl: ref.artwork,
      url: ref.canonicalUrl,
    });
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    const clean = (providerArtistId ?? '').trim().replace(/^spotify:artist:/, '');
    if (!clean) return null;
    const url = isValidSpotifyId(clean) ? `https://open.spotify.com/artist/${clean}` : clean;
    const ref = await scrapeSpotifyPageReference(url);
    return mapSpotifyArtist({
      id: clean,
      name: ref?.title || clean,
      artworkUrl: ref?.artwork,
      url: ref?.canonicalUrl || `https://open.spotify.com/artist/${clean}`,
    });
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    const clean = (providerAlbumId ?? '').trim().replace(/^spotify:album:/, '');
    if (!clean) return null;
    const url = isValidSpotifyId(clean) ? `https://open.spotify.com/album/${clean}` : clean;
    const ref = await scrapeSpotifyPageReference(url);
    return mapSpotifyAlbum({
      id: clean,
      title: ref?.title || clean,
      artist: ref?.artist || '',
      artworkUrl: ref?.artwork,
      url: ref?.canonicalUrl || `https://open.spotify.com/album/${clean}`,
    });
  }

  async getPlaylist(providerPlaylistId: string): Promise<Playlist | null> {
    const clean = (providerPlaylistId ?? '').trim().replace(/^spotify:(playlist:)?/, '');
    if (!clean) return null;
    if (clean.startsWith('mix:') || clean.startsWith('artist-mix:')) {
      const seedQuery = decodeURIComponent(clean.replace(/^(artist-)?mix:/, '')).trim();
      const { tracks } = await searchSpotifyCatalog(seedQuery, { limit: 35 }).catch(() => ({
        tracks: [],
      }));
      return mapSpotifyPlaylist({
        id: clean,
        name: `Spotify Real-Time Mix • ${seedQuery}`,
        artworkUrl: tracks[0]?.artworkUrl,
        totalTracks: tracks.length,
        tracks,
      });
    }
    const url = isValidSpotifyId(clean) ? `https://open.spotify.com/playlist/${clean}` : clean;
    const ref = await scrapeSpotifyPageReference(url);
    const seedTitle = ref?.title || clean;
    const { tracks } = await searchSpotifyCatalog(seedTitle, { limit: 30 }).catch(() => ({
      tracks: [],
    }));
    return mapSpotifyPlaylist({
      id: clean,
      name: seedTitle,
      artworkUrl: ref?.artwork ?? tracks[0]?.artworkUrl,
      url: ref?.canonicalUrl || `https://open.spotify.com/playlist/${clean}`,
      totalTracks: tracks.length,
      tracks,
    });
  }

  async getAlbumTracks(providerAlbumId: string): Promise<Song[]> {
    const clean = (providerAlbumId ?? '').trim().replace(/^spotify:album:/, '');
    if (!clean) return [];
    try {
      const { tracks } = await searchSpotifyCatalog(clean, { limit: 25 });
      return mapSpotifyTracks(tracks);
    } catch {
      return [];
    }
  }

  async getStream(song: Song): Promise<StreamResult> {
    try {
      const asset = await ensureInAppProviderTrack(song);
      return {
        url: asset.objectUrl,
        mimeType: asset.mimeType,
        quality: asset.fromCache ? 'Audio (Spotify) · Offline' : 'Audio (Spotify)',
        allowsOffline: true,
        downloadUrl: asset.objectUrl,
        license: song.license || SPOTIFY_LICENSE,
        sourceUrl: song.sourceUrl,
      };
    } catch (e) {
      if (song.streamUrl) {
        return {
          url: song.streamUrl,
          mimeType: 'audio/mpeg',
          quality: 'Audio (Spotify)',
          allowsOffline: true,
          downloadUrl: song.streamUrl,
          license: song.license || SPOTIFY_LICENSE,
          sourceUrl: song.sourceUrl,
        };
      }
      if (e instanceof ProviderError) throw e;
      const msg = e instanceof Error ? e.message : 'Spotify stream resolution failed';
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

  async getDownload(song: Song): Promise<{ url: string; mimeType: string } | null> {
    if (song.streamUrl) {
      return { url: song.streamUrl, mimeType: 'audio/mpeg' };
    }
    return null;
  }
}

export { SPOTIFY_LICENSE, SPOTIFY_PROVIDER_ID, SPOTIFY_PROVIDER_NAME };
