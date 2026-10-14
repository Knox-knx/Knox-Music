// Spotify metadata → KNOX domain model mapper (playable & downloadable in-app server).

import type { Album, Artist, Playlist, Song } from '../../core/types';
import {
  SPOTIFY_LICENSE,
  SPOTIFY_PROVIDER_ID,
  type SpotifyAlbumMetadata,
  type SpotifyArtistMetadata,
  type SpotifyPlaylistMetadata,
  type SpotifyTrackMetadata,
} from './types';

export function spotifySongId(trackId: string): string {
  return `${SPOTIFY_PROVIDER_ID}:${trackId.replace(/^spotify:(track:)?/, '')}`;
}

export function mapSpotifyTrack(
  t: SpotifyTrackMetadata & { durationSec?: number; sourceUrl?: string },
): Song | null {
  if (!t || !t.id || !t.title) return null;
  const rawId = t.id.replace(/^spotify:(track:)?/, '').trim();
  if (!rawId) return null;

  const durationMs =
    typeof t.durationMs === 'number' && Number.isFinite(t.durationMs) && t.durationMs > 0
      ? Math.round(t.durationMs)
      : typeof t.durationSec === 'number' && Number.isFinite(t.durationSec) && t.durationSec > 0
        ? Math.round(t.durationSec * 1000)
        : 0;
  const artistNames = t.artists?.map((a) => a.name.trim()).filter(Boolean);

  return {
    id: spotifySongId(rawId),
    providerId: SPOTIFY_PROVIDER_ID,
    providerTrackId: rawId,
    title: t.title.trim() || 'Untitled',
    artist: t.artist.trim() || 'Unknown artist',
    artists: artistNames && artistNames.length > 0 ? artistNames : undefined,
    artistId: t.artists?.[0]?.id ? `${SPOTIFY_PROVIDER_ID}:artist:${t.artists[0].id}` : undefined,
    album: t.album?.trim() || '',
    albumId: t.albumId ? `${SPOTIFY_PROVIDER_ID}:album:${t.albumId}` : undefined,
    durationMs,
    artworkUrl: t.artworkUrl,
    streamUrl: t.streamUrl,
    downloadUrl: t.streamUrl,
    downloadAllowed: true,
    year: t.year,
    trackNo: t.trackNumber,
    license: SPOTIFY_LICENSE,
    sourceUrl: t.url || t.sourceUrl || `https://open.spotify.com/track/${rawId}`,
    capabilities: {
      searchable: true,
      streamable: true,
      downloadable: true,
      offline: true,
      previewOnly: false,
    },
    addedAt: Date.now(),
  };
}

export function mapSpotifyTracks(list: SpotifyTrackMetadata[]): Song[] {
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const item of list) {
    const s = mapSpotifyTrack(item);
    if (s) out.push(s);
  }
  return out;
}

export function mapSpotifyArtist(a: SpotifyArtistMetadata | null | undefined): Artist | null {
  if (!a || !a.id || !a.name?.trim()) return null;
  const cleanId = a.id.replace(/^spotify:artist:/, '').trim();
  return {
    id: `${SPOTIFY_PROVIDER_ID}:artist:${cleanId}`,
    providerId: SPOTIFY_PROVIDER_ID,
    providerArtistId: cleanId,
    name: a.name.trim(),
    artworkUrl: a.artworkUrl,
  };
}

export function mapSpotifyAlbum(a: SpotifyAlbumMetadata | null | undefined): Album | null {
  if (!a || !a.id || !a.title?.trim()) return null;
  const cleanId = a.id.replace(/^spotify:album:/, '').trim();
  return {
    id: `${SPOTIFY_PROVIDER_ID}:album:${cleanId}`,
    providerId: SPOTIFY_PROVIDER_ID,
    providerAlbumId: cleanId,
    title: a.title.trim(),
    artist: a.artist?.trim() || '',
    artistId: a.artistId ? `${SPOTIFY_PROVIDER_ID}:artist:${a.artistId}` : undefined,
    year: a.year,
    artworkUrl: a.artworkUrl,
    trackCount: a.totalTracks,
  };
}

export function mapSpotifyPlaylist(p: SpotifyPlaylistMetadata | null | undefined): Playlist | null {
  if (!p || !p.id || !p.name?.trim()) return null;
  const cleanId = p.id.replace(/^spotify:playlist:/, '').trim();
  const now = Date.now();
  const songs = Array.isArray(p.tracks) ? mapSpotifyTracks(p.tracks) : [];
  return {
    id: `${SPOTIFY_PROVIDER_ID}:playlist:${cleanId}`,
    name: p.name.trim(),
    description: p.description,
    coverUrl: p.artworkUrl,
    createdAt: now,
    updatedAt: now,
    trackIds: songs.map((s) => s.id),
    songs: songs.length > 0 ? songs : undefined,
    isUserPlaylist: false,
    providerId: SPOTIFY_PROVIDER_ID,
    providerPlaylistId: cleanId,
  };
}
