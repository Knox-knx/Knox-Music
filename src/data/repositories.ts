import { getDb } from './db';
import type { HistoryEntry, Playlist, Song } from '../core/types';
import type { DownloadRecord } from '../core/states';
import { uid } from '../core/utils';
import type { SongRow } from './db';

export const PAGE_SIZE = 100;

export const songRepo = {
  async upsert(song: Song, extra?: Partial<SongRow>): Promise<void> {
    await getDb().songs.put({ ...song, ...extra } as SongRow);
  },
  async bulkUpsert(songs: Song[]): Promise<void> {
    await getDb().songs.bulkPut(songs as SongRow[]);
  },
  async get(id: string): Promise<Song | undefined> {
    return getDb().songs.get(id) as Promise<Song | undefined>;
  },
  async list(offset = 0, limit = PAGE_SIZE, sort: 'recent' | 'title' | 'artist' | 'played' = 'recent'): Promise<Song[]> {
    const table = getDb().songs;
    let query = table.orderBy(sort === 'title' ? 'title' : sort === 'artist' ? 'artist' : sort === 'played' ? 'lastPlayedAt' : 'addedAt');
    if (sort === 'recent' || sort === 'played') query = query.reverse();
    return (await query.offset(offset).limit(limit).toArray()) as Song[];
  },
  async count(): Promise<number> { return getDb().songs.count(); },
  async searchLocal(query: string, limit = 50): Promise<Song[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Indexed prefix scan on title + in-memory filter for artist/album (keeps 50k libraries responsive via pagination)
    const byTitle = await getDb().songs.where('title').startsWithIgnoreCase(q).limit(limit).toArray();
    if (byTitle.length >= limit) return byTitle as Song[];
    const extra = await getDb().songs
      .filter((s) => s.artist.toLowerCase().includes(q) || s.album.toLowerCase().includes(q))
      .limit(limit - byTitle.length)
      .toArray();
    return [...(byTitle as Song[]), ...(extra as Song[])];
  },
  async remove(id: string): Promise<void> { await getDb().songs.delete(id); },
  async clear(): Promise<void> { await getDb().songs.clear(); },
};

export const favoriteRepo = {
  async add(songId: string): Promise<void> {
    await getDb().favorites.put({ songId, addedAt: Date.now() });
  },
  async remove(songId: string): Promise<void> { await getDb().favorites.delete(songId); },
  async isFavorite(songId: string): Promise<boolean> {
    return (await getDb().favorites.get(songId)) !== undefined;
  },
  async listSongIds(): Promise<string[]> {
    return (await getDb().favorites.orderBy('addedAt').reverse().toArray()).map((f) => f.songId);
  },
  async listSongs(): Promise<Song[]> {
    const ids = new Set(await this.listSongIds());
    if (ids.size === 0) return [];
    return ((await getDb().songs.bulkGet([...ids])) .filter(Boolean)) as Song[];
  },
};

export const playlistRepo = {
  async create(name: string, description = '', trackIds: string[] = []): Promise<Playlist> {
    const now = Date.now();
    const pl: Playlist = { id: uid('pl'), name: name.trim() || 'Untitled', description, createdAt: now, updatedAt: now, trackIds, isUserPlaylist: true };
    await getDb().playlists.put(pl);
    return pl;
  },
  async get(id: string) { return getDb().playlists.get(id); },
  async list(): Promise<Playlist[]> {
    return getDb().playlists.orderBy('updatedAt').reverse().toArray();
  },
  async update(pl: Playlist): Promise<void> {
    await getDb().playlists.put({ ...pl, updatedAt: Date.now() });
  },
  async remove(id: string): Promise<void> { await getDb().playlists.delete(id); },
  async addTrack(playlistId: string, songId: string): Promise<void> {
    const pl = await this.get(playlistId);
    if (!pl) return;
    if (!pl.trackIds.includes(songId)) await this.update({ ...pl, trackIds: [...pl.trackIds, songId] });
  },
  async removeTrack(playlistId: string, songId: string): Promise<void> {
    const pl = await this.get(playlistId);
    if (!pl) return;
    await this.update({ ...pl, trackIds: pl.trackIds.filter((t) => t !== songId) });
  },
  async reorder(playlistId: string, trackIds: string[]): Promise<void> {
    const pl = await this.get(playlistId);
    if (!pl) return;
    await this.update({ ...pl, trackIds });
  },
  exportJson(pl: Playlist) {
    return JSON.stringify({ app: 'knox-music', version: 1, playlist: pl }, null, 2);
  },
  importJson(json: string): Playlist {
    const parsed = JSON.parse(json) as { playlist?: Playlist };
    if (!parsed.playlist || !Array.isArray(parsed.playlist.trackIds) || typeof parsed.playlist.name !== 'string') {
      throw new Error('Invalid playlist backup');
    }
    const now = Date.now();
    return { ...parsed.playlist, id: uid('pl'), createdAt: now, updatedAt: now, isUserPlaylist: true };
  },
};

export const historyRepo = {
  async record(song: Song, durationListenedMs: number): Promise<void> {
    const entry: HistoryEntry = {
      id: uid('h'),
      songId: song.id,
      title: song.title,
      artist: song.artist,
      playedAt: Date.now(),
      durationListenedMs,
    };
    await getDb().history.put(entry);
    await getDb().songs.update(song.id, { lastPlayedAt: Date.now(), playCount: (song.playCount ?? 0) + 1 } as Partial<SongRow>);
    // Bound history to 2000 entries
    const count = await getDb().history.count();
    if (count > 2000) {
      const oldest = await getDb().history.orderBy('playedAt').limit(count - 2000).toArray();
      await getDb().history.bulkDelete(oldest.map((o) => o.id));
    }
  },
  async recent(limit = 50): Promise<HistoryEntry[]> {
    return getDb().history.orderBy('playedAt').reverse().limit(limit).toArray();
  },
  async clear(): Promise<void> { await getDb().history.clear(); },
};

export const downloadRepo = {
  async put(r: DownloadRecord) { await getDb().downloads.put(r); },
  async get(id: string) { return getDb().downloads.get(id); },
  async list(): Promise<DownloadRecord[]> {
    return getDb().downloads.orderBy('updatedAt').reverse().toArray();
  },
  async update(id: string, patch: Partial<DownloadRecord>) {
    await getDb().downloads.update(id, { ...patch, updatedAt: Date.now() });
  },
  async remove(id: string) { await getDb().downloads.delete(id); },
  async clearCompleted() {
    // Keep FAILED entries visible under "Needs attention" so users can retry.
    await getDb().downloads.where('state').anyOf(['COMPLETED', 'CANCELLED', 'REMOVED']).delete();
  },
};

export const settingsRepo = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await getDb().settings.get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  },
  async set(key: string, value: unknown): Promise<void> {
    await getDb().settings.put({ key, value: JSON.stringify(value) });
  },
};

export const offlineRepo = {
  async put(song: Song, blob: Blob, quality: string) {
    await getDb().offline.put({
      id: song.id,
      provider: song.providerId,
      providerTrackId: song.providerTrackId,
      title: song.title,
      artist: song.artist,
      album: song.album,
      durationMs: song.durationMs,
      blob,
      mimeType: blob.type || 'audio/mpeg',
      fileSize: blob.size,
      quality,
      createdAt: Date.now(),
      isFavorite: false,
    });
    await getDb().songs.update(song.id, { isOfflineAvailable: true } as Partial<SongRow>);
  },
  async get(songId: string) { return getDb().offline.get(songId); },
  async list() { return getDb().offline.orderBy('createdAt').reverse().toArray(); },
  async remove(songId: string) {
    await getDb().offline.delete(songId);
    await getDb().songs.update(songId, { isOfflineAvailable: false } as Partial<SongRow>);
  },
  async totalBytes(): Promise<number> {
    const all = await getDb().offline.toArray();
    return all.reduce((n, r) => n + r.fileSize, 0);
  },
  objectUrl(songId: string, blob: Blob): string {
    void songId;
    return URL.createObjectURL(blob);
  },
};
