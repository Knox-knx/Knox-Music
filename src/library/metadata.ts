import type { Song } from '../core/types';
import { stableId } from '../core/utils';

export const SUPPORTED_EXTENSIONS = ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'oga', 'webm'];

/**
 * Extensions the native decoder cannot handle on-device (no MSE/WASM
 * fallback ships with the app). Files with these extensions are rejected at
 * import with an explicit reason so the UI can explain + skip gracefully
 * instead of hitting a blocking decode error at tap time.
 * Minimum guaranteed set stays: MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis (+ Opus/WebM).
 */
export const UNSUPPORTED_EXTENSIONS = ['wma', 'amr', 'awb', 'aiff', 'aif', 'aifc', 'mid', 'midi', 'ra', 'ram'];

export function isSupportedAudioFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/** Lowercase extension without query/hash, '' when none. */
export function extensionOf(nameOrPath: string | undefined | null): string {
  if (!nameOrPath) return '';
  const clean = nameOrPath.split('?')[0].split('#')[0];
  const base = clean.split('/').pop() ?? clean;
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Explicit reason for an unsupported local extension (null when supported/unknown). */
export function unsupportedExtensionReason(nameOrPath: string | undefined | null): string | null {
  const ext = extensionOf(nameOrPath);
  if (!ext) return null;
  if (SUPPORTED_EXTENSIONS.includes(ext)) return null;
  if (UNSUPPORTED_EXTENSIONS.includes(ext)) {
    return `.${ext} is not decodable on this device (supported: MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis, Opus)`;
  }
  return `.${ext} is not a recognized audio format`;
}

/**
 * Codec/container label for diagnostics + user messages (never throws).
 * e.g. ".opus (audio/ogg)", ".mp3 (audio/mpeg, possibly corrupted header)".
 */
export function describeLocalCodec(nameOrPath: string | undefined | null, mimeHint?: string): string {
  const ext = extensionOf(nameOrPath);
  const mime = mimeHint || guessMimeForExtension(ext);
  return ext ? `.${ext}${mime ? ` (${mime})` : ''}` : (mime || 'unknown format');
}

function guessMimeForExtension(ext: string): string | null {
  switch (ext) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': case 'mp4': case 'm4b': case 'aac': return 'audio/mp4';
    case 'ogg': case 'oga': return 'audio/ogg';
    case 'opus': return 'audio/ogg; codecs=opus';
    case 'flac': return 'audio/flac';
    case 'wav': return 'audio/wav';
    case 'webm': case 'weba': return 'audio/webm';
    case 'wma': return 'audio/x-ms-wma';
    case 'amr': case 'awb': return 'audio/amr';
    default: return null;
  }
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

/** Clean a filename stem into a human title: strip extension, decode URI,
 *  turn underscores/pluses into spaces, collapse whitespace. Never empty. */
export function cleanFileStem(name: string): string {
  const noExt = name.replace(/\.[^.]+$/, '');
  let out = noExt;
  try { out = decodeURIComponent(out); } catch { /* keep raw */ }
  out = out.replace(/[_+]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return out || 'Unknown Title';
}

/** Split "Artist - Title" (also "Artist – Title" / "Artist — Title"). */
export function splitArtistTitle(stem: string): { artist?: string; title: string } {
  const m = /^(.+?)\s*[-–—]\s*(.+)$/.exec(stem.trim());
  if (m && m[1].trim() && m[2].trim()) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { title: stem.trim() || 'Unknown Title' };
}

/**
 * Probe real duration through a media element (fallback when the
 * container/tags carry no duration). Resolves 0 on timeout/error — never
 * rejects, never blocks the scan.
 */
export function probeDurationViaElement(objectUrl: string, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve) => {
    try {
      if (typeof Audio === 'undefined') { resolve(0); return; }
      const el = new Audio();
      el.preload = 'metadata';
      let done = false;
      const finish = (ms: number) => {
        if (done) return;
        done = true;
        try { el.removeAttribute('src'); el.load(); } catch { /* noop */ }
        clearTimeout(timer);
        resolve(ms);
      };
      const timer = setTimeout(() => finish(0), timeoutMs);
      el.onloadedmetadata = () => {
        const d = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
        finish(d > 0 ? d : 0);
      };
      el.onerror = () => finish(0);
      el.src = objectUrl;
      try { el.load(); } catch { finish(0); }
    } catch { resolve(0); }
  });
}

/** Read metadata via music-metadata-browser when available; fall back to filename parsing. Never executes metadata. */
export async function fileToSong(file: File, folder = ''): Promise<Song> {
  const stem = cleanFileStem(file.name);
  const split = splitArtistTitle(stem);
  const base: Song = {
    id: stableId('local', folder, file.name, String(file.size), String(file.lastModified)),
    providerId: 'local',
    providerTrackId: stableId(folder, file.name),
    title: split.title,
    artist: split.artist ?? 'Unknown Artist',
    album: 'Unknown Album',
    durationMs: 0,
    isLocalFile: true,
    localPath: folder ? `${folder}/${file.name}` : file.name,
    addedAt: Date.now(),
  };
  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    base.streamUrl = objectUrl;
  } catch { /* blob URLs unavailable (tests) */ }

  try {
    const { parseBlob } = await import('music-metadata-browser');
    const meta = await parseBlob(file);
    const c = meta.common;
    // Tags win over filename — never leave "Unknown Artist" when a tag exists.
    if (c.title?.trim()) base.title = c.title.trim();
    // music-metadata joins multiple artists; keep the display string.
    const tagArtist = (c.artist?.trim() || (c.artists ?? []).join(', ').trim()) || '';
    if (tagArtist) base.artist = tagArtist;
    else if (!split.artist) base.artist = 'Unknown Artist';
    if (c.album?.trim()) base.album = c.album.trim();
    if (c.genre?.[0]?.trim()) base.genre = c.genre[0].trim();
    if (c.year) base.year = c.year;
    if (c.track?.no) base.trackNo = c.track.no;
    if (meta.format.duration && Number.isFinite(meta.format.duration) && meta.format.duration > 0) {
      base.durationMs = Math.round(meta.format.duration * 1000);
    }
    const pic = c.picture?.[0];
    if (pic?.data) {
      try {
        const blob = new Blob([pic.data as unknown as BlobPart], { type: pic.format || 'image/jpeg' });
        base.artworkLocal = URL.createObjectURL(blob);
      } catch { /* art is best-effort */ }
    }
  } catch {
    // Filename heuristic already applied above — nothing more to do.
  }

  // Duration fallback: real codec/container info via the element. Fixes the
  // permanent 0:00 rows when tags carry no duration.
  if (!(base.durationMs > 0) && objectUrl) {
    try {
      const probed = await probeDurationViaElement(objectUrl);
      if (probed > 0) base.durationMs = probed;
    } catch { /* keep 0 — repair pass retries at play time */ }
  }
  return base;
}

export async function hashFilePrefix(file: File): Promise<string> {
  const slice = file.slice(0, 65536);
  const buf = await slice.arrayBuffer();
  const { sha256Hex } = await import('../core/utils');
  return sha256Hex(buf);
}

export interface DuplicateGroup { key: string; songs: Song[]; reason: string; }

function normalizeDupToken(v: string): string {
  return (v || '')
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/g, '')
    .replace(/\s*[-_]\s*copy\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Duplicate detection: same duration+size+title, or same normalized title+artist. Never auto-deletes. */
export function findDuplicates(songs: Song[], sizes: Map<string, number>): DuplicateGroup[] {
  const byKey = new Map<string, Song[]>();
  for (const s of songs) {
    const size = sizes.get(s.id) ?? 0;
    const normTitle = normalizeDupToken(s.title);
    const normArtist = normalizeDupToken(s.artist);
    const key = `${normTitle}|${normArtist}|${Math.round(s.durationMs / 2000)}|${Math.round(size / 4096)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(s);
  }
  const groups: DuplicateGroup[] = [];
  const groupedIds = new Set<string>();
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      groups.push({ key, songs: list, reason: 'Same title, artist, duration and size' });
      for (const s of list) groupedIds.add(s.id);
    }
  }

  // Secondary pass: catch duplicates with same title & artist whose duration/size
  // metadata differed slightly or had a (1)/(2) filename suffix.
  const byTitleArtist = new Map<string, Song[]>();
  for (const s of songs) {
    if (groupedIds.has(s.id)) continue;
    const normTitle = normalizeDupToken(s.title);
    const normArtist = normalizeDupToken(s.artist);
    if (!normTitle || normTitle === 'unknown title') continue;
    const tk = `${normTitle}|${normArtist}`;
    if (!byTitleArtist.has(tk)) byTitleArtist.set(tk, []);
    byTitleArtist.get(tk)!.push(s);
  }
  for (const [tk, list] of byTitleArtist) {
    if (list.length > 1) {
      const baseDur = list[0].durationMs;
      const closeEnough = list.every(
        (s) =>
          baseDur === 0 ||
          s.durationMs === 0 ||
          Math.abs(s.durationMs - baseDur) <= 5000,
      );
      if (closeEnough) {
        groups.push({ key: `ta:${tk}`, songs: list, reason: 'Same title and artist' });
      }
    }
  }

  return groups;
}
