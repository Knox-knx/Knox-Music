// Internet Archive provider — public APIs, no key.
// Search:  https://archive.org/advancedsearch.php (mediatype:audio only)
// Metadata: https://archive.org/metadata/{identifier}
// Only public, playable audio files are ever returned. Restricted/private
// items never produce a stream — playback falls back to another provider.

import type { Album, Artist, Playlist, Song } from '../../core/types';
import type { MusicProvider, StreamResult } from '../types';
import { ProviderError } from '../../core/errors';
import { fetchJson, requireSafeMediaUrl } from '../http';
import { providerEnv } from '../env';
import { mimeTypeForFilename } from '../../audio/mediaDiagnostics';

interface IaSearchDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  album?: string | string[];
  date?: string;
  description?: string | string[];
  licenseurl?: string;
}

interface IaSearchResponse {
  response?: { docs?: IaSearchDoc[]; numFound?: number };
  /** Archive.org returns HTTP 200 + {error: ...} for malformed queries (e.g. unescaped `/`). */
  error?: string;
}

interface IaFile {
  name: string;
  format?: string;
  size?: string | number;
  private?: string | boolean;
  length?: string | number;
  title?: string;
  track?: string;
  creator?: string;
  album?: string;
}

interface IaMetadataResponse {
  metadata?: {
    identifier?: string;
    title?: string | string[];
    creator?: string | string[];
    album?: string | string[];
    date?: string;
    description?: string | string[];
    licenseurl?: string;
    mediatype?: string;
    'access-restricted-item'?: string | boolean;
  };
  files?: IaFile[];
  server?: string;
  dir?: string;
}

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function joinNames(v: string | string[] | undefined): string {
  if (!v) return '';
  return Array.isArray(v) ? v.join(', ') : v;
}

export function iaArtworkUrl(identifier: string): string {
  return `${providerEnv.iaBaseUrl}/services/img/${encodeURIComponent(identifier)}`;
}

export function iaItemUrl(identifier: string): string {
  return `${providerEnv.iaBaseUrl}/details/${encodeURIComponent(identifier)}`;
}

export function iaFileUrl(identifier: string, filename: string): string {
  return `${providerEnv.iaBaseUrl}/download/${encodeURIComponent(identifier)}/${encodeURI(filename)}`;
}

/**
 * Escape Lucene/solr special characters so user input can never break the
 * archive.org `advancedsearch.php` query. Without this, queries like `AC/DC`
 * make the backend return HTTP 200 + `{error: "[BACKEND_ERROR] ..."}` and the
 * provider silently returns zero results (looks like "online search broken").
 */
export function escapeIaQuery(q: string): string {
  const escaped = q.replace(/([+\-=&|><!(){}[\]^"~*?:\\/])/g, '\\$1');
  return escaped.trim();
}

const PLAYABLE_FORMAT_SCORE: [RegExp, number][] = [
  [/vbr\s*mp3/i, 100],
  [/\bmp3\b/i, 90],
  [/ogg|vorbis|opus/i, 80],
  [/flac/i, 70],
  [/m4a|mp4.*audio|aac/i, 60],
  [/wav|aiff?/i, 50],
];

function isPrivateFile(f: IaFile): boolean {
  return f.private === true || f.private === 'true';
}

/** Pick the best public audio file, or null when nothing is playable. */
export function pickPlayableFile(files: IaFile[] | undefined): IaFile | null {
  if (!files || files.length === 0) return null;
  let best: IaFile | null = null;
  let bestScore = -1;
  for (const f of files) {
    if (!f.name || isPrivateFile(f)) continue;
    const fmt = f.format ?? '';
    let score = -1;
    for (const [re, s] of PLAYABLE_FORMAT_SCORE) {
      if (re.test(fmt) || re.test(f.name)) { score = s; break; }
    }
    if (score < 0) continue;
    const size = Number(f.size ?? 0);
    // Prefer higher-score format; break ties by larger (full-length) file.
    const tiebreak = Number.isFinite(size) ? Math.min(size / 1e7, 5) : 0;
    const total = score + tiebreak;
    if (total > bestScore) { bestScore = total; best = f; }
  }
  return best;
}

/**
 * Honest MIME type for the SELECTED Archive file (§15). Individual items mix
 * containers (VBR MP3 beside FLAC/OGG/WAV/M4A) — hardcoding audio/mpeg for
 * every pick poisons the temp blob type and misleads the element.
 * The picked file's own name/format decides; bytes are never altered.
 */
export function mimeTypeForIaFile(file: IaFile | null | undefined): string {
  if (!file?.name) return 'audio/mpeg';
  return mimeTypeForFilename(file.name, file.format, 'audio/mpeg');
}

export function isRestricted(meta: IaMetadataResponse['metadata']): boolean {
  const v = meta?.['access-restricted-item'];
  return v === true || v === 'true';
}

export function mapIaDocToSong(doc: IaSearchDoc): Song {
  const identifier = doc.identifier;
  const title = first(doc.title) || identifier;
  const artist = joinNames(doc.creator) || 'Unknown artist';
  return {
    id: `internet-archive:${identifier}`,
    providerId: 'internet-archive',
    providerTrackId: identifier,
    title,
    artist,
    album: first(doc.album) || '',
    durationMs: 0, // resolved via metadata in getSong/getStream
    artworkUrl: iaArtworkUrl(identifier),
    genre: undefined,
    year: doc.date ? Number(String(doc.date).slice(0, 4)) || undefined : undefined,
    license: doc.licenseurl || undefined,
    sourceUrl: iaItemUrl(identifier),
    addedAt: Date.now(),
  };
}

export class InternetArchiveProvider implements MusicProvider {
  readonly id = 'internet-archive';
  readonly name = 'Internet Archive';
  readonly capabilities = {
    supportsSearch: true,
    supportsStreaming: true,
    supportsOffline: true, // per-item: only when files/rights permit
    supportsLyrics: false,
    supportsArtwork: true,
    supportsArtists: true,
    supportsAlbums: true,
    // Local temp playback / offline: allowed where item rights/license permit (per-track gate).
    supportsPlaybackCache: true,
    cacheQuality: 'low' as const,
  };
  readonly offlineNotice = 'Offline only when the item is public and its rights/license permit storage.';

  private async metadata(identifier: string, signal?: AbortSignal): Promise<IaMetadataResponse> {
    const url = `${providerEnv.iaBaseUrl}/metadata/${encodeURIComponent(identifier)}`;
    return fetchJson<IaMetadataResponse>(url, {
      timeoutMs: providerEnv.requestTimeoutMs,
      retries: 2,
      signal,
    });
  }

  async searchSongs(query: string, signal?: AbortSignal): Promise<Song[]> {
    const q = query.trim();
    if (!q) return [];
    const safe = escapeIaQuery(q);
    if (!safe) return [];
    // Restrict to audio items; search title/creator/description.
    const params = new URLSearchParams({
      q: `mediatype:audio AND (${safe})`,
      'fl[]': 'identifier',
      rows: '20',
      page: '1',
      output: 'json',
    });
    // advancedsearch wants repeated fl[] params — append the rest manually.
    for (const fl of ['title', 'creator', 'album', 'date', 'description', 'licenseurl']) {
      params.append('fl[]', fl);
    }
    const data = await fetchJson<IaSearchResponse>(
      `${providerEnv.iaBaseUrl}/advancedsearch.php?${params.toString()}`,
      { timeoutMs: providerEnv.requestTimeoutMs, retries: 2, signal },
    );
    if (data.error) {
      throw new ProviderError('NETWORK', `Internet Archive search failed: ${data.error}`);
    }
    const docs = data.response?.docs ?? [];
    return docs.filter((d) => d.identifier).map(mapIaDocToSong);
  }

  async searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]> {
    const songs = await this.searchSongs(query, signal);
    const q = query.trim().toLowerCase();
    const map = new Map<string, Artist>();
    for (const s of songs) {
      if (!s.artist.toLowerCase().includes(q)) continue;
      const id = `internet-archive:artist:${s.artist}`;
      if (!map.has(id)) {
        map.set(id, {
          id, providerId: 'internet-archive',
          providerArtistId: s.artist, name: s.artist,
        });
      }
      if (map.size >= 20) break;
    }
    return [...map.values()];
  }

  async searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]> {
    const songs = await this.searchSongs(query, signal);
    const q = query.trim().toLowerCase();
    const map = new Map<string, Album>();
    for (const s of songs) {
      if (!s.album || !s.album.toLowerCase().includes(q)) continue;
      const id = `internet-archive:album:${s.album}::${s.artist}`;
      if (!map.has(id)) {
        map.set(id, {
          id, providerId: 'internet-archive', providerAlbumId: s.album,
          title: s.album, artist: s.artist,
        });
      }
      if (map.size >= 20) break;
    }
    return [...map.values()];
  }

  async searchPlaylists(): Promise<Playlist[]> { return []; }

  async getSong(providerTrackId: string): Promise<Song | null> {
    const meta = await this.metadata(providerTrackId);
    const md = meta.metadata;
    if (!md || (md.mediatype && md.mediatype !== 'audio')) return null;
    const restricted = isRestricted(md);
    const file = restricted ? null : pickPlayableFile(meta.files);
    const identifier = md.identifier || providerTrackId;
    const secs = file?.length ? Number(file.length) : NaN;
    return {
      id: `internet-archive:${identifier}`,
      providerId: 'internet-archive',
      providerTrackId: identifier,
      title: file?.title || first(md.title) || identifier,
      artist: file?.creator || joinNames(md.creator) || 'Unknown artist',
      album: file?.album || first(md.album) || '',
      durationMs: Number.isFinite(secs) ? Math.round(secs * 1000) : 0,
      artworkUrl: iaArtworkUrl(identifier),
      streamUrl: file ? iaFileUrl(identifier, file.name) : undefined,
      downloadUrl: file ? iaFileUrl(identifier, file.name) : undefined,
      downloadAllowed: file ? true : false,
      year: md.date ? Number(String(md.date).slice(0, 4)) || undefined : undefined,
      license: md.licenseurl || undefined,
      sourceUrl: iaItemUrl(identifier),
      addedAt: Date.now(),
    };
  }

  async getArtist(providerArtistId: string): Promise<Artist | null> {
    return {
      id: `internet-archive:artist:${providerArtistId}`,
      providerId: 'internet-archive',
      providerArtistId,
      name: providerArtistId,
    };
  }

  async getAlbum(providerAlbumId: string): Promise<Album | null> {
    return {
      id: `internet-archive:album:${providerAlbumId}`,
      providerId: 'internet-archive',
      providerAlbumId,
      title: providerAlbumId,
      artist: '',
    };
  }

  async getPlaylist(): Promise<Playlist | null> { return null; }

  async getAlbumTracks(): Promise<Song[]> { return []; }

  async getStream(song: Song): Promise<StreamResult> {
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    const src = fresh ?? song;
    if (!src.streamUrl) {
      throw new Error('No playable audio file for this Internet Archive item (restricted or non-audio)');
    }
    const url = requireSafeMediaUrl(src.streamUrl);
    // Per-file MIME (§15): never claim audio/mpeg for an OGG/FLAC/WAV/M4A
    // pick. Derive from the authorized file backing this stream.
    const pickedName = url.split('?')[0].split('#')[0].split('/').pop() ?? '';
    return {
      url,
      mimeType: mimeTypeForFilename(pickedName, undefined, 'audio/mpeg'),
      quality: 'Original (Internet Archive)',
      allowsOffline: src.downloadAllowed === true,
      downloadUrl: src.downloadAllowed ? url : undefined,
      license: src.license,
      sourceUrl: src.sourceUrl,
    };
  }

  async getArtwork(song: Song): Promise<string | null> {
    return song.artworkUrl ?? iaArtworkUrl(song.providerTrackId);
  }

  async getLyrics(): Promise<null> { return null; }

  async canDownload(song: Song): Promise<boolean> {
    if (typeof song.downloadAllowed === 'boolean' && song.downloadAllowed) return true;
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    return fresh?.downloadAllowed === true;
  }

  async getDownload(song: Song): Promise<{ url: string; mimeType: string } | null> {
    const fresh = await this.getSong(song.providerTrackId).catch(() => null);
    const src = fresh ?? song;
    if (src.downloadAllowed !== true || !src.downloadUrl) return null;
    const url = requireSafeMediaUrl(src.downloadUrl);
    const pickedName = url.split('?')[0].split('#')[0].split('/').pop() ?? '';
    return { url, mimeType: mimeTypeForFilename(pickedName, undefined, 'audio/mpeg') };
  }
}
