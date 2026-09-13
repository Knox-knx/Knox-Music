// YouTube Music result → KNOX Track mapping (discovery/metadata only).
//
// Every mapped track is explicitly UNPLAYABLE through KNOX:
//   streamable=false, downloadable=false, offline=false, no streamUrl.
// Licensed/authorized audio providers remain responsible for playback.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import type { YouTubeMusicTrackJson } from './types';

export const YOUTUBE_MUSIC_PROVIDER_ID = 'youtube-music';
export const YOUTUBE_MUSIC_LICENSE =
  'YouTube Music discovery metadata — search/browse only, no playback/download/offline license. Rights belong to the underlying service/labels.';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

export function videoIdFromQualified(id: string): string | null {
  const raw = (id ?? '').trim();
  const bare = raw.startsWith(`${YOUTUBE_MUSIC_PROVIDER_ID}:`)
    ? raw.slice(YOUTUBE_MUSIC_PROVIDER_ID.length + 1)
    : raw;
  const short = bare.includes(':') ? bare.split(':').pop() as string : bare;
  return VIDEO_ID_RE.test(short) ? short : null;
}

export function qualifiedId(videoId: string): string {
  return `${YOUTUBE_MUSIC_PROVIDER_ID}:${videoId}`;
}

function cleanStr(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || fallback;
}

export function mapYouTubeMusicTrack(t: YouTubeMusicTrackJson): Song | null {
  if (!t || typeof t !== 'object') return null;
  const videoId = typeof t.videoId === 'string' && VIDEO_ID_RE.test(t.videoId)
    ? t.videoId
    : videoIdFromQualified(typeof t.id === 'string' ? t.id : '');
  if (!videoId) return null;
  const secs = Number(t.duration ?? 0);
  const durationMs = Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0;
  const year = typeof t.year === 'number' && Number.isFinite(t.year) ? Math.trunc(t.year) : undefined;
  const artists = cleanStr(t.artist, 'Unknown artist') !== 'Unknown artist' ? [cleanStr(t.artist, '')] : undefined;
  return {
    id: qualifiedId(videoId),
    providerId: YOUTUBE_MUSIC_PROVIDER_ID,
    providerTrackId: videoId,
    title: cleanStr(t.title, 'Untitled'),
    artist: cleanStr(t.artist, 'Unknown artist'),
    artists: artists && artists[0] ? artists : undefined,
    album: typeof t.album === 'string' ? t.album.trim() : '',
    albumId: typeof t.albumId === 'string' && t.albumId.trim()
      ? t.albumId.trim()
      : undefined,
    durationMs,
    artworkUrl: typeof t.artwork === 'string' && t.artwork.trim() ? t.artwork.trim() : undefined,
    streamUrl: undefined,
    downloadUrl: undefined,
    downloadAllowed: false,
    year: year && year > 1000 && year < 2200 ? year : undefined,
    license: YOUTUBE_MUSIC_LICENSE,
    sourceUrl: `https://music.youtube.com/watch?v=${videoId}`,
    capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false },
    addedAt: Date.now(),
  };
}

export function mapYouTubeMusicArtist(a: { id?: string; name?: string } | null | undefined): Artist | null {
  if (!a || typeof a.name !== 'string' || !a.name.trim()) return null;
  const raw = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : a.name.trim();
  const id = raw.startsWith(`${YOUTUBE_MUSIC_PROVIDER_ID}:`) ? raw : `${YOUTUBE_MUSIC_PROVIDER_ID}:artist:${raw}`;
  return {
    id,
    providerId: YOUTUBE_MUSIC_PROVIDER_ID,
    providerArtistId: raw.includes(':') ? raw.split(':').pop() as string : raw,
    name: a.name.trim(),
  };
}

export function mapYouTubeMusicAlbum(a: { id?: string; title?: string; artist?: string } | null | undefined): Album | null {
  if (!a || typeof a.title !== 'string' || !a.title.trim()) return null;
  const raw = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : a.title.trim();
  const id = raw.startsWith(`${YOUTUBE_MUSIC_PROVIDER_ID}:`) ? raw : `${YOUTUBE_MUSIC_PROVIDER_ID}:album:${raw}`;
  return {
    id,
    providerId: YOUTUBE_MUSIC_PROVIDER_ID,
    providerAlbumId: raw.includes(':') ? raw.split(':').pop() as string : raw,
    title: a.title.trim(),
    artist: typeof a.artist === 'string' ? a.artist : '',
  };
}

export function mapSearchResults(list: unknown): Song[] {
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const r of list) {
    try {
      const s = mapYouTubeMusicTrack(r as YouTubeMusicTrackJson);
      if (s) out.push(s);
    } catch { continue; }
  }
  return out;
}

/** Derive artist/album/playlist views from song results (search-time only). */
export function artistsFromSongs(songs: Song[], query: string, limit = 20): Artist[] {
  const q = query.trim().toLowerCase();
  const map = new Map<string, Artist>();
  for (const s of songs) {
    if (!s.artist.toLowerCase().includes(q)) continue;
    const key = `${YOUTUBE_MUSIC_PROVIDER_ID}:artist:${s.artist}`;
    if (!map.has(key)) {
      map.set(key, { id: key, providerId: YOUTUBE_MUSIC_PROVIDER_ID, providerArtistId: s.artist, name: s.artist, artworkUrl: s.artworkUrl });
    }
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

export function albumsFromSongs(songs: Song[], query: string, limit = 20): Album[] {
  const q = query.trim().toLowerCase();
  const map = new Map<string, Album>();
  for (const s of songs) {
    if (!s.album || !s.album.toLowerCase().includes(q)) continue;
    const id = `${YOUTUBE_MUSIC_PROVIDER_ID}:album:${s.album}`;
    if (!map.has(id)) {
      map.set(id, { id, providerId: YOUTUBE_MUSIC_PROVIDER_ID, providerAlbumId: s.album, title: s.album, artist: s.artist });
    }
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

export function playlistsFromSongs(): Playlist[] {
  // Playlist audio is never imported — metadata only, and the sidecar
  // search surface is song-oriented. Return [] honestly.
  return [];
}
