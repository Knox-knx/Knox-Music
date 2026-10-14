// YouTube provider mapper — converts YouTube search results to KNOX Song.

import type { Song } from '../../core/types';
import type { YouTubeSearchResult } from './types';

export const YOUTUBE_PROVIDER_ID = 'youtube';

export function youtubeVideoId(id: string): string {
  return id.replace(/^youtube:/, '');
}

export function mapYouTubeSearchResult(result: YouTubeSearchResult): Song {
  const videoId = youtubeVideoId(result.id);
  const durationMs = result.duration ? Math.round(result.duration * 1000) : 0;

  // Pick the smallest thumbnail (least bandwidth): song images in the
  // YouTube column stay lightweight; the player still falls back to the
  // generated placeholder when artwork fails.
  let artworkUrl: string | undefined;
  if (result.thumbnails && result.thumbnails.length > 0) {
    const withArea = result.thumbnails
      .filter((t) => t && t.url)
      .map((t) => ({ url: t.url, area: (t.width || 0) * (t.height || 0), width: t.width || 0 }));
    withArea.sort((a, b) => a.area - b.area || a.width - b.width);
    artworkUrl = withArea[0]?.url;
  }

  return {
    id: `${YOUTUBE_PROVIDER_ID}:${videoId}`,
    providerId: YOUTUBE_PROVIDER_ID,
    providerTrackId: videoId,
    title: result.title,
    artist: result.channel,
    album: '',
    durationMs,
    artworkUrl,
    streamUrl: undefined, // Will be resolved via offline/local file
    downloadUrl: undefined,
    downloadAllowed: true, // YouTube downloads are user-authorized
    license: 'YouTube Standard License',
    sourceUrl: result.url,
    genre: undefined,
    year: undefined,
    trackNo: undefined,
    isLocalFile: false,
    localPath: undefined,
    isOfflineAvailable: false,
    isFavorite: false,
    playCount: 0,
    lastPlayedAt: undefined,
    addedAt: Date.now(),
    capabilities: {
      searchable: true,
      streamable: true, // After download, it's locally streamable
      downloadable: true,
      offline: true,
      previewOnly: false,
    },
  };
}

export function mapYouTubeSearchResults(results: YouTubeSearchResult[]): Song[] {
  return results
    .filter((r) => r.id && !r.live) // Filter out live streams
    .map(mapYouTubeSearchResult);
}

export function createYouTubeSong(videoId: string, metadata: {
  title: string;
  channel: string;
  durationMs: number;
  artworkUrl?: string;
}): Song {
  return {
    id: `${YOUTUBE_PROVIDER_ID}:${videoId}`,
    providerId: YOUTUBE_PROVIDER_ID,
    providerTrackId: videoId,
    title: metadata.title,
    artist: metadata.channel,
    album: '',
    durationMs: metadata.durationMs,
    artworkUrl: metadata.artworkUrl,
    streamUrl: undefined,
    downloadUrl: undefined,
    downloadAllowed: true,
    license: 'YouTube Standard License',
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    genre: undefined,
    year: undefined,
    trackNo: undefined,
    isLocalFile: false,
    localPath: undefined,
    isOfflineAvailable: false,
    isFavorite: false,
    playCount: 0,
    lastPlayedAt: undefined,
    addedAt: Date.now(),
    capabilities: {
      searchable: true,
      streamable: true,
      downloadable: true,
      offline: true,
      previewOnly: false,
    },
  };
}