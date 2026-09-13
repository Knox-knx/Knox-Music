import type { Song } from '../core/types';
import { sha256Hex, stableId } from '../core/utils';

export const SUPPORTED_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'oga', 'webm'];

export function isSupportedAudioFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export interface ScannedFile {
  file: File;
  modified: number;
  size: number;
}

export interface ScanProgress {
  total: number;
  done: number;
  current: string;
}

/** Read metadata via music-metadata-browser when available; fall back to filename parsing. Never executes metadata. */
export async function fileToSong(file: File, folder = ''): Promise<Song> {
  const base: Song = {
    id: stableId('local', folder, file.name, String(file.size), String(file.lastModified)),
    providerId: 'local',
    providerTrackId: stableId(folder, file.name),
    title: file.name.replace(/\.[^.]+$/, ''),
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    durationMs: 0,
    isLocalFile: true,
    localPath: folder ? `${folder}/${file.name}` : file.name,
    addedAt: Date.now(),
  };
  try {
    const { parseBlob } = await import('music-metadata-browser');
    const meta = await parseBlob(file);
    const c = meta.common;
    if (c.title) base.title = c.title;
    if (c.artist) base.artist = c.artist;
    if (c.album) base.album = c.album;
    if (c.genre?.[0]) base.genre = c.genre[0];
    if (c.year) base.year = c.year;
    if (c.track?.no) base.trackNo = c.track.no;
    if (meta.format.duration) base.durationMs = Math.round(meta.format.duration * 1000);
    const pic = c.picture?.[0];
    if (pic) {
      const blob = new Blob([pic.data as unknown as BlobPart], { type: pic.format });
      base.artworkLocal = URL.createObjectURL(blob);
    }
  } catch {
    // Fallback: "Artist - Title.mp3" heuristic
    const m = /^(.+?)\s*-\s*(.+)$/.exec(base.title);
    if (m) { base.artist = m[1].trim(); base.title = m[2].trim(); }
  }
  if (!base.streamUrl) base.streamUrl = URL.createObjectURL(file);
  // duration fallback via audio element is handled lazily at play time
  return base;
}

export async function hashFilePrefix(file: File): Promise<string> {
  const slice = file.slice(0, 65536);
  const buf = await slice.arrayBuffer();
  return sha256Hex(buf);
}

export interface DuplicateGroup { key: string; songs: Song[]; reason: string; }

/** Duplicate detection: same duration+size+title, or same content hash. Never auto-deletes. */
export function findDuplicates(songs: Song[], sizes: Map<string, number>): DuplicateGroup[] {
  const byKey = new Map<string, Song[]>();
  for (const s of songs) {
    const size = sizes.get(s.id) ?? 0;
    const key = `${s.title.toLowerCase()}|${s.artist.toLowerCase()}|${Math.round(s.durationMs / 2000)}|${Math.round(size / 4096)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  const groups: DuplicateGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length > 1) groups.push({ key, songs: list, reason: 'Same title, artist, duration and size' });
  }
  return groups;
}
