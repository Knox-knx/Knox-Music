// libraryApi — UI entry point for library/playlists/favorites/history.
//
// Local-first storage stays in IndexedDB on web and maps to the OS KNOX
// data directory on desktop (host owns the directory; this facade owns the
// records). No behavior change — repositories remain the source of truth.

import type { Playlist, Song } from '../core/types';
import { assertPlaylistId, assertTrackId } from './client';
import { favoriteRepo, historyRepo, playlistRepo, songRepo } from '../data/repositories';
import { songRepo as songRepoAlias } from '../data/repositories';

export const libraryApi = {
  async songs(offset = 0, limit = 100): Promise<Song[]> {
    return songRepo.list(offset, limit);
  },
  async count(): Promise<number> {
    return songRepo.count();
  },
  async getTrack(provider: string, id: string): Promise<Song | null> {
    void provider;
    const trackId = assertTrackId(id);
    // Library lookup by full song id; provider adapters resolve network
    // tracks through ProviderManager (see searchApi / playerApi).
    return (await songRepo.get(trackId)) ?? null;
  },
  async removeTrack(id: string): Promise<void> {
    await songRepo.remove(assertTrackId(id));
  },
};

export const playlistsApi = {
  async list(): Promise<Playlist[]> {
    return playlistRepo.list();
  },
  async get(id: string): Promise<Playlist | undefined> {
    return playlistRepo.get(assertPlaylistId(id)) as Promise<Playlist | undefined>;
  },
  async create(name: string, description = '', trackIds: string[] = []): Promise<Playlist> {
    const clean = name.trim().slice(0, 120) || 'Untitled';
    return playlistRepo.create(clean, description.slice(0, 500), trackIds.map(assertTrackId));
  },
  async update(pl: Playlist): Promise<void> {
    assertPlaylistId(pl.id);
    await playlistRepo.update(pl);
  },
  async remove(id: string): Promise<void> {
    await playlistRepo.remove(assertPlaylistId(id));
  },
  async addTrack(playlistId: string, song: Song): Promise<void> {
    await songRepoAlias.upsert(song).catch(() => undefined);
    await playlistRepo.addTrack(assertPlaylistId(playlistId), assertTrackId(song.id));
  },
  async removeTrack(playlistId: string, songId: string): Promise<void> {
    await playlistRepo.removeTrack(assertPlaylistId(playlistId), assertTrackId(songId));
  },
};

export const favoritesApi = {
  async list(): Promise<Song[]> {
    return favoriteRepo.listSongs();
  },
  async add(song: Song): Promise<void> {
    await songRepoAlias.upsert(song).catch(() => undefined);
    await favoriteRepo.add(assertTrackId(song.id));
  },
  async remove(songId: string): Promise<void> {
    await favoriteRepo.remove(assertTrackId(songId));
  },
  async isFavorite(songId: string): Promise<boolean> {
    return favoriteRepo.isFavorite(assertTrackId(songId));
  },
};

export const historyApi = {
  async recent(limit = 50): Promise<ReturnType<typeof historyRepo.recent>> {
    return historyRepo.recent(Math.min(Math.max(limit, 1), 200));
  },
  async clear(): Promise<void> {
    await historyRepo.clear();
  },
};
