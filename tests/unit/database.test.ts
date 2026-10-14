import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../src/data/db';
import {
  songRepo, favoriteRepo, playlistRepo, historyRepo, downloadRepo, settingsRepo, offlineRepo,
} from '../../src/data/repositories';
import type { Song } from '../../src/core/types';

const song = (id: string, over: Partial<Song> = {}): Song => ({
  id, providerId: 'sample', providerTrackId: id, title: `Title ${id}`,
  artist: 'Artist', album: 'Album', durationMs: 200000, addedAt: Date.now(), ...over,
});

beforeEach(async () => {
  const db = getDb();
  await Promise.all([
    db.songs.clear(), db.playlists.clear(), db.favorites.clear(), db.history.clear(),
    db.downloads.clear(), db.offline.clear(), db.settings.clear(), db.cache.clear(), db.lyrics.clear(),
  ]);
});

describe('songRepo', () => {
  it('upserts and searches locally (case-insensitive)', async () => {
    await songRepo.bulkUpsert([song('sample:1', { title: 'Tum Hi Ho' }), song('sample:2', { title: 'Other' })]);
    expect(await songRepo.count()).toBe(2);
    const hits = await songRepo.searchLocal('tum');
    expect(hits.map((s) => s.id)).toEqual(['sample:1']);
    expect(await songRepo.searchLocal('')).toEqual([]);
  });

  it('paginates instead of loading everything', async () => {
    await songRepo.bulkUpsert(Array.from({ length: 5 }, (_, i) => song(`s:${i}`, { title: `T${i}` })));
    const page = await songRepo.list(0, 2, 'title');
    expect(page).toHaveLength(2);
  });
});

describe('favorites', () => {
  it('adds, checks, lists and removes', async () => {
    await songRepo.upsert(song('sample:1'));
    await favoriteRepo.add('sample:1');
    expect(await favoriteRepo.isFavorite('sample:1')).toBe(true);
    expect((await favoriteRepo.listSongs()).map((s) => s.id)).toEqual(['sample:1']);
    await favoriteRepo.remove('sample:1');
    expect(await favoriteRepo.isFavorite('sample:1')).toBe(false);
  });
});

describe('playlists', () => {
  it('creates, reorders, exports and imports', async () => {
    const pl = await playlistRepo.create('Workout', 'desc', ['a', 'b', 'c']);
    await playlistRepo.addTrack(pl.id, 'd');
    await playlistRepo.reorder(pl.id, ['d', 'a', 'b', 'c']);
    const updated = (await playlistRepo.get(pl.id))!;
    expect(updated.trackIds).toEqual(['d', 'a', 'b', 'c']);
    await playlistRepo.removeTrack(pl.id, 'a');
    expect((await playlistRepo.get(pl.id))!.trackIds).not.toContain('a');

    const json = playlistRepo.exportJson(updated);
    const imported = playlistRepo.importJson(json);
    expect(imported.name).toBe('Workout');
    expect(imported.id).not.toBe(pl.id);
    expect(() => playlistRepo.importJson('{"nope":1}')).toThrow();
  });
});

describe('history', () => {
  it('records plays and clears', async () => {
    const s = song('sample:9');
    await songRepo.upsert(s);
    await historyRepo.record(s, 30000);
    const recent = await historyRepo.recent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].durationListenedMs).toBe(30000);
    await historyRepo.clear();
    expect(await historyRepo.recent(10)).toHaveLength(0);
  });
});

describe('downloads repo + states', () => {
  it('tracks explicit download states (no boolean flags)', async () => {
    await downloadRepo.put({
      id: 'dl1', songId: 'sample:1', title: 'T', artist: 'A',
      state: 'QUEUED', progress: 0, bytesReceived: 0, createdAt: 0, updatedAt: 0,
    });
    await downloadRepo.update('dl1', { state: 'DOWNLOADING', progress: 0.5 });
    expect((await downloadRepo.get('dl1'))!.state).toBe('DOWNLOADING');
    await downloadRepo.update('dl1', { state: 'COMPLETED', progress: 1 });
    await downloadRepo.put({
      id: 'dl2', songId: 'sample:2', title: 'T2', artist: 'A',
      state: 'FAILED', progress: 0, bytesReceived: 0, createdAt: 0, updatedAt: 0,
    });
    await downloadRepo.clearCompleted();
    expect(await downloadRepo.get('dl1')).toBeUndefined();
    expect((await downloadRepo.get('dl2'))!.state).toBe('FAILED');
  });
});

describe('settings repo', () => {
  it('round-trips values with fallback', async () => {
    expect(await settingsRepo.get('missing', 42)).toBe(42);
    await settingsRepo.set('k', { a: 1 });
    expect(await settingsRepo.get('k', {})).toEqual({ a: 1 });
  });
});

describe('offline repo', () => {
  it('stores blobs outside JSON rows and measures usage', async () => {
    const s = song('sample:1');
    await offlineRepo.put(s, new Blob(['x'.repeat(1000)], { type: 'audio/mpeg' }), 'High');
    expect((await offlineRepo.get('sample:1'))!.fileSize).toBe(1000);
    expect(await offlineRepo.totalBytes()).toBe(1000);
    await offlineRepo.remove('sample:1');
    expect(await offlineRepo.get('sample:1')).toBeUndefined();
  });
});
