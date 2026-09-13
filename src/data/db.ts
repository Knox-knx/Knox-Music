import Dexie, { type Table } from 'dexie';
import type { DownloadRecord, OfflineTrackRecord } from '../core/states';
import type { HistoryEntry, Lyrics, Playlist, Song } from '../core/types';
import type { SmartCacheEntry } from '../cache/cacheTypes';

export interface SongRow extends Song { fileModified?: number; fileSize?: number; fileHash?: string; folder?: string }
export interface SettingsRow { key: string; value: string }
export interface CacheRow { key: string; value: string; expiresAt: number; updatedAt: number }
export interface ArtworkRow { key: string; blob: Blob; mimeType: string; updatedAt: number }

/** Local-first database with explicit migrations. Large audio lives in `offline` (Blob store), never in JSON rows. */
export class KnoxDatabase extends Dexie {
  songs!: Table<SongRow, string>;
  playlists!: Table<Playlist, string>;
  favorites!: Table<{ songId: string; addedAt: number }, string>;
  history!: Table<HistoryEntry, string>;
  downloads!: Table<DownloadRecord, string>;
  offline!: Table<OfflineTrackRecord, string>;
  lyrics!: Table<Lyrics, string>;
  artwork!: Table<ArtworkRow, string>;
  cache!: Table<CacheRow, string>;
  settings!: Table<SettingsRow, string>;
  /** Smart Playback Cache (automatic low-quality playback cache).
   *  STRICTLY separate from `offline` (user-owned permanent downloads). */
  smartcache!: Table<SmartCacheEntry, string>;

  constructor() {
    super('knox-music');
    // v1 — initial schema
    this.version(1).stores({
      songs: 'id, providerId, artist, album, title, addedAt, lastPlayedAt',
      playlists: 'id, updatedAt',
      favorites: 'songId',
      history: 'id, songId, playedAt',
      downloads: 'id, songId, state, updatedAt',
      offline: 'id, provider, createdAt',
      lyrics: 'songId',
      artwork: 'key',
      cache: 'key, expiresAt',
      settings: 'key',
    });
    // v2 — index genre/year for library facets
    this.version(2).stores({
      songs: 'id, providerId, artist, album, title, genre, year, addedAt, lastPlayedAt',
    });
    // v3 — index favorites recency + cache updatedAt for auto-cleanup scans
    this.version(3).stores({
      favorites: 'songId, addedAt',
      cache: 'key, expiresAt, updatedAt',
    });
    // v4 — Smart Playback Cache table (additive; all existing data untouched).
    // Indexed for LRU eviction (lastPlayedAt) and provider stats.
    this.version(4).stores({
      smartcache: 'id, provider, lastPlayedAt, cachedAt',
    });
  }
}

let db: KnoxDatabase | null = null;
export function getDb(): KnoxDatabase {
  if (!db) db = new KnoxDatabase();
  return db;
}

/** Crash-safe startup: Dexie handles partial writes transactionally; prune stale transient states. */
export async function recoverTransientStates(): Promise<number> {
  const d = getDb();
  try {
    const stuck = await d.downloads.where('state').anyOf(['QUEUED', 'DOWNLOADING']).toArray();
    await Promise.all(
      stuck.map((r) => d.downloads.update(r.id, { state: 'PAUSED', updatedAt: Date.now(), error: 'Interrupted — resume to continue' })),
    );
    return stuck.length;
  } catch { return 0; /* first run: tables may not exist yet */ }
}
