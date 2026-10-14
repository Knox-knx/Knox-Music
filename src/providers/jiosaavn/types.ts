// JioSaavn in-app server provider types for KNOX Music.

export const JIOSAAVN_PROVIDER_ID = 'jiosaavn';
export const JIOSAAVN_PROVIDER_NAME = 'JioSaavn';
export const JIOSAAVN_LICENSE = 'JioSaavn Standard License';

export type JioSaavnPageKind = 'song' | 'album' | 'artist' | 'playlist' | 'unknown';

export interface JioSaavnImage {
  quality?: string;
  url: string;
}

export interface JioSaavnArtistRef {
  id: string;
  name: string;
  role?: string;
  image?: JioSaavnImage[] | string;
  url?: string;
}

export interface JioSaavnTrackMetadata {
  id: string;
  title: string;
  subtitle?: string;
  artist: string;
  artists?: JioSaavnArtistRef[];
  album?: string;
  albumId?: string;
  durationSec?: number;
  year?: number;
  language?: string;
  copyright?: string;
  artworkUrl?: string;
  streamUrl?: string;
  encryptedMediaUrl?: string;
  url?: string;
  hasLyrics?: boolean;
}

export interface JioSaavnAlbumMetadata {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  artworkUrl?: string;
  songCount?: number;
  url?: string;
  songs?: JioSaavnTrackMetadata[];
}

export interface JioSaavnArtistMetadata {
  id: string;
  name: string;
  artworkUrl?: string;
  bio?: string;
  url?: string;
}

export interface JioSaavnPlaylistMetadata {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  artworkUrl?: string;
  songCount?: number;
  trackCount?: number;
  url?: string;
  songs?: JioSaavnTrackMetadata[];
  tracks?: JioSaavnTrackMetadata[];
}
