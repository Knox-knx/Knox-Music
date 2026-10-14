// Spotify in-app server provider types for KNOX Music.

export const SPOTIFY_PROVIDER_ID = 'spotify';
export const SPOTIFY_PROVIDER_NAME = 'Spotify';
export const SPOTIFY_LICENSE = 'Spotify Standard License';

export type SpotifyEntityKind = 'track' | 'album' | 'artist' | 'playlist' | 'unknown';

export interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}

export interface SpotifyOEmbedResponse {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  provider_name?: string;
  provider_url?: string;
  type?: string;
  html?: string;
}

export interface SpotifyArtistMetadata {
  id: string;
  name: string;
  artworkUrl?: string;
  genres?: string[];
  url?: string;
}

export interface SpotifyAlbumMetadata {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  releaseDate?: string;
  artworkUrl?: string;
  totalTracks?: number;
  url?: string;
}

export interface SpotifyTrackMetadata {
  id: string;
  title: string;
  artist: string;
  artists?: { id: string; name: string }[];
  album?: string;
  albumId?: string;
  durationMs?: number;
  year?: number;
  trackNumber?: number;
  artworkUrl?: string;
  streamUrl?: string;
  isrc?: string;
  url?: string;
}

export interface SpotifyPlaylistMetadata {
  id: string;
  name: string;
  description?: string;
  artworkUrl?: string;
  totalTracks?: number;
  url?: string;
  tracks?: SpotifyTrackMetadata[];
}
