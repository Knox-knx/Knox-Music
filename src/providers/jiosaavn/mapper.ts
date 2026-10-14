// JioSaavn metadata → KNOX domain model mapper (playable & downloadable in-app server).

import type { Album, Artist, Playlist, Song } from '../../core/types';
import { resolveJioSaavnStreamUrl, upscaleJioSaavnImage } from './scraper';
import {
  JIOSAAVN_LICENSE,
  JIOSAAVN_PROVIDER_ID,
  type JioSaavnAlbumMetadata,
  type JioSaavnArtistMetadata,
  type JioSaavnPlaylistMetadata,
  type JioSaavnTrackMetadata,
} from './types';

export function jioSaavnSongId(trackId: string): string {
  return `${JIOSAAVN_PROVIDER_ID}:${trackId.replace(/^jiosaavn:/, '')}`;
}

export function mapJioSaavnTrack(
  t: JioSaavnTrackMetadata & { sourceUrl?: string },
): Song | null {
  if (!t || !t.id || !t.title) return null;
  const rawId = t.id.replace(/^jiosaavn:/, '').trim();
  if (!rawId) return null;

  const durationMs =
    typeof t.durationSec === 'number' && Number.isFinite(t.durationSec) && t.durationSec > 0
      ? Math.round(t.durationSec * 1000)
      : 0;
  const artistNames = t.artists?.map((a) => a.name.trim()).filter(Boolean);
  const upgradedStream = resolveJioSaavnStreamUrl(t.streamUrl);

  return {
    id: jioSaavnSongId(rawId),
    providerId: JIOSAAVN_PROVIDER_ID,
    providerTrackId: rawId,
    title: t.title.trim() || 'Untitled',
    artist: t.artist.trim() || 'Unknown artist',
    artists: artistNames && artistNames.length > 0 ? artistNames : undefined,
    artistId: t.artists?.[0]?.id ? `${JIOSAAVN_PROVIDER_ID}:artist:${t.artists[0].id}` : undefined,
    album: t.album?.trim() || '',
    albumId: t.albumId ? `${JIOSAAVN_PROVIDER_ID}:album:${t.albumId}` : undefined,
    durationMs,
    artworkUrl: upscaleJioSaavnImage(t.artworkUrl),
    streamUrl: upgradedStream,
    downloadUrl: upgradedStream,
    downloadAllowed: true,
    year: t.year,
    license: t.copyright || JIOSAAVN_LICENSE,
    sourceUrl: t.url || t.sourceUrl || `https://www.jiosaavn.com/song/_/${rawId}`,
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

export const mapJioSaavnSong = mapJioSaavnTrack;

export function mapJioSaavnTracks(list: JioSaavnTrackMetadata[]): Song[] {
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const item of list) {
    const s = mapJioSaavnTrack(item);
    if (s) out.push(s);
  }
  return out;
}

export function mapJioSaavnArtist(a: JioSaavnArtistMetadata | null | undefined): Artist | null {
  if (!a || !a.id || !a.name?.trim()) return null;
  const cleanId = a.id.replace(/^jiosaavn:artist:/, '').trim();
  return {
    id: `${JIOSAAVN_PROVIDER_ID}:artist:${cleanId}`,
    providerId: JIOSAAVN_PROVIDER_ID,
    providerArtistId: cleanId,
    name: a.name.trim(),
    artworkUrl: a.artworkUrl,
    bio: a.bio,
  };
}

export function mapJioSaavnAlbum(a: JioSaavnAlbumMetadata | null | undefined): Album | null {
  if (!a || !a.id || !a.title?.trim()) return null;
  const cleanId = a.id.replace(/^jiosaavn:album:/, '').trim();
  return {
    id: `${JIOSAAVN_PROVIDER_ID}:album:${cleanId}`,
    providerId: JIOSAAVN_PROVIDER_ID,
    providerAlbumId: cleanId,
    title: a.title.trim(),
    artist: a.artist?.trim() || '',
    artistId: a.artistId ? `${JIOSAAVN_PROVIDER_ID}:artist:${a.artistId}` : undefined,
    year: a.year,
    artworkUrl: a.artworkUrl,
    trackCount: a.songCount,
  };
}

export function mapJioSaavnPlaylist(p: JioSaavnPlaylistMetadata | null | undefined): Playlist | null {
  if (!p || !p.id || !p.title?.trim()) return null;
  const cleanId = p.id.replace(/^jiosaavn:playlist:/, '').trim();
  const now = Date.now();
  const rawTracks = Array.isArray(p.songs) ? p.songs : Array.isArray(p.tracks) ? p.tracks : [];
  const songs = mapJioSaavnTracks(rawTracks);
  return {
    id: `${JIOSAAVN_PROVIDER_ID}:playlist:${cleanId}`,
    name: p.title.trim(),
    description: p.description || p.subtitle,
    coverUrl: p.artworkUrl,
    createdAt: now,
    updatedAt: now,
    trackIds: songs.map((s) => s.id),
    songs: songs.length > 0 ? songs : undefined,
    isUserPlaylist: false,
    providerId: JIOSAAVN_PROVIDER_ID,
    providerPlaylistId: cleanId,
  };
}
