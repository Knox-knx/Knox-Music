// JioSaavnProvider — in-app server provider for KNOX Music.
//
// Full in-app server capabilities:
//   - Search & metadata lookup (tracks, albums, artists, URLs)
//   - In-app streaming & permanent offline downloads via direct AAC stream or
//     the in-app audio resolution engine (`ensureInAppProviderTrack`)

import { ProviderError } from '../../core/errors';
import type { Album, Artist, Playlist, Song } from '../../core/types';
import type { MusicProvider, StreamResult } from '../types';
import { ensureInAppProviderTrack } from '../youtube/youtubeOffline';
import {
  mapJioSaavnAlbum,
  mapJioSaavnArtist,
  mapJioSaavnPlaylist,
  mapJioSaavnTrack,
  mapJioSaavnTracks,
} from './mapper';
import {
  deriveJioSaavnAlbums,
  deriveJioSaavnArtists,
  fetchJioSaavnRecommendations,
  getJioSaavnPlaylistDetails,
  getJioSaavnTrackMetadata,
  resolveJioSaavnStreamUrl,
  scrapeJioSaavnPageReference,
  searchJioSaavnCatalog,
  searchJioSaavnPlaylists,
} from './scraper';
import { JIOSAAVN_LICENSE, JIOSAAVN_PROVIDER_ID, JIOSAAVN_PROVIDER_NAME } from './types';

export class JioSaavnProvider implements MusicProvider {
  readonly id = JIOSAAVN_PROVIDER_ID;
  readonly name = JIOSAAVN_PROVIDER_NAME;
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
    'JioSaavn tracks are streamed and saved locally via the in-app server for offline playback.';

  async checkHealth(): Promise<boolean> {
    return true;
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const records = await searchJioSaavnCatalog(q, { limit: 25, signal });
      return mapJioSaavnTracks(records);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return [];
      throw new ProviderError('NETWORK', 'JioSaavn search is currently unavailable.');
    }
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const records = await searchJioSaavnCatalog(q, { limit: 20, signal });
      return deriveJioSaavnArtists(records, q)
        .map(mapJioSaavnArtist)
        .filter((a): a is Artist => a !== null);
    } catch {
      return [];
    }
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const records = await searchJioSaavnCatalog(q, { limit: 20, signal });
      return deriveJioSaavnAlbums(records, q)
        .map(mapJioSaavnAlbum)
        .filter((a): a is Album => a !== null);
    } catch {
      return [];
    }
  }

  async searchPlaylists(query: string, signal?: AbortSignal): Promise<Playlist[]> {
    const q = (query ?? '').trim();
    if (!q || signal?.aborted) return [];
    try {
      const records = await searchJioSaavnPlaylists(q, { limit: 15, signal });
      return records
        .map(mapJioSaavnPlaylist)
        .filter((p): p is Playlist => p !== null);
    } catch {
      return [];
    }
  }

  /**
   * Fetch a real-time JioSaavn station / recommendation mix for a seed track.
   */
  async getMixPlaylist(providerTrackId: string, signal?: AbortSignal): Promise<Song[]> {
    const clean = (providerTrackId ?? '').trim().replace(/^jiosaavn:/, '');
    if (!clean || signal?.aborted) return [];
    try {
      const records = await fetchJioSaavnRecommendations(clean, { limit: 40, signal });
      return mapJioSaavnTracks(records);
    } catch {
      return [];
    }
  }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const raw = (providerTrackId ?? '').trim();
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const ref = await scrapeJioSaavnPageReference(raw);
      if (!ref || !ref.title) return null;
      return mapJioSaavnTrack({
        id: ref.providerId || raw,
        title: ref.title,
        artist: ref.artist || 'Unknown artist',
        album: ref.album,
        durationSec: ref.durationMs ? Math.round(ref.durationMs / 1000) : undefined,
        artworkUrl: ref.artwork,
        url: ref.canonicalUrl,
      });
    }
    const meta = await getJioSaavnTrackMetadata(raw);
    return meta ? mapJioSaavnTrack(meta) : null;
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    const clean = (providerArtistId ?? '').trim().replace(/^jiosaavn:artist:/, '');
    if (!clean) return null;
    return mapJioSaavnArtist({ id: clean, name: clean });
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    const clean = (providerAlbumId ?? '').trim().replace(/^jiosaavn:album:/, '');
    if (!clean) return null;
    return mapJioSaavnAlbum({ id: clean, title: clean, artist: '' });
  }

  async getPlaylist(providerPlaylistId: string): Promise<Playlist | null> {
    const clean = (providerPlaylistId ?? '').trim().replace(/^jiosaavn:/, '');
    if (!clean) return null;
    try {
      const details = await getJioSaavnPlaylistDetails(clean);
      return details ? mapJioSaavnPlaylist(details) : null;
    } catch {
      return null;
    }
  }

  async getAlbumTracks(providerAlbumId: string): Promise<Song[]> {
    const clean = (providerAlbumId ?? '').trim().replace(/^jiosaavn:album:/, '');
    if (!clean) return [];
    try {
      const records = await searchJioSaavnCatalog(clean, { limit: 20 });
      return mapJioSaavnTracks(records);
    } catch {
      return [];
    }
  }

  async getStream(song: Song): Promise<StreamResult> {
    let targetSong = song;
    if (!targetSong.streamUrl && targetSong.providerTrackId) {
      const details = await getJioSaavnTrackMetadata(targetSong.providerTrackId).catch(() => null);
      if (details?.streamUrl) {
        targetSong = { ...targetSong, streamUrl: details.streamUrl };
      }
    }

    const upgradedDirect = resolveJioSaavnStreamUrl(targetSong.streamUrl, '320') ?? targetSong.streamUrl;
    if (upgradedDirect && upgradedDirect !== targetSong.streamUrl) {
      targetSong = { ...targetSong, streamUrl: upgradedDirect };
    }

    const { canUseNativeYouTube } = await import('../youtube/device');
    const preferNativeInApp = canUseNativeYouTube() || !upgradedDirect;

    if (!preferNativeInApp && upgradedDirect) {
      return {
        url: upgradedDirect,
        mimeType: 'audio/mp4',
        quality: '320kbps AAC (JioSaavn)',
        allowsOffline: true,
        downloadUrl: upgradedDirect,
        license: song.license || JIOSAAVN_LICENSE,
        sourceUrl: song.sourceUrl,
      };
    }

    // On Android / Desktop Tauri (or when no direct CDN URL is present),
    // resolve via ensureInAppProviderTrack so native reqwest downloads
    // the 320kbps AAC stream (or falls back to YouTube audio engine) without CORS errors.
    try {
      const asset = await ensureInAppProviderTrack(targetSong);
      return {
        url: asset.objectUrl,
        mimeType: asset.mimeType,
        quality: asset.fromCache ? '320kbps AAC (JioSaavn) · Offline' : '320kbps AAC (JioSaavn)',
        allowsOffline: true,
        downloadUrl: asset.objectUrl,
        license: song.license || JIOSAAVN_LICENSE,
        sourceUrl: song.sourceUrl,
      };
    } catch (e) {
      if (upgradedDirect && /^https?:\/\//i.test(upgradedDirect)) {
        return {
          url: upgradedDirect,
          mimeType: 'audio/mp4',
          quality: '320kbps AAC (JioSaavn)',
          allowsOffline: true,
          downloadUrl: upgradedDirect,
          license: song.license || JIOSAAVN_LICENSE,
          sourceUrl: song.sourceUrl,
        };
      }
      if (e instanceof ProviderError) throw e;
      const msg = e instanceof Error ? e.message : 'JioSaavn stream resolution failed';
      throw new ProviderError('NETWORK', msg);
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

  async getDownload(song: Song): Promise<{ url: string; mimeType: string } | null> {
    try {
      const asset = await ensureInAppProviderTrack(song);
      return { url: asset.objectUrl, mimeType: asset.mimeType };
    } catch {
      const upgraded = resolveJioSaavnStreamUrl(song.streamUrl, '320') ?? song.streamUrl;
      if (upgraded) {
        return { url: upgraded, mimeType: 'audio/mp4' };
      }
      return null;
    }
  }
}

export { JIOSAAVN_LICENSE, JIOSAAVN_PROVIDER_ID, JIOSAAVN_PROVIDER_NAME };
