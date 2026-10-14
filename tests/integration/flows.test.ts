import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getDb } from '../../src/data/db';
import { downloadStateLabel, useDownloads } from '../../src/downloads/DownloadManager';
import { storageManager } from '../../src/storage/storageManager';
import { useSettings, DEFAULT_SETTINGS } from '../../src/settings/settingsStore';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { downloadRepo } from '../../src/data/repositories';
import type { Song } from '../../src/core/types';

const demoSong: Song = {
  id: 'stub:song-1', providerId: 'stub', providerTrackId: 'song-1',
  title: 'Stub Song', artist: 'Stub Artist', album: 'Stub Album',
  durationMs: 180000, addedAt: 0,
};

beforeEach(async () => {
  const db = getDb();
  await Promise.all([db.downloads.clear(), db.offline.clear(), db.cache.clear(), db.songs.clear()]);
  useSettings.setState({ ...DEFAULT_SETTINGS, wifiOnly: false, maxConcurrentDownloads: 2 });
  const pm = getProviderManager();
  if (!pm.get('stub')) {
    pm.register({
      id: 'stub', name: 'Stub',
      capabilities: {
        supportsSearch: true, supportsStreaming: true, supportsOffline: true,
        supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
      },
      searchSongs: async () => [demoSong],
      searchArtists: async () => [],
      searchAlbums: async () => [],
      searchPlaylists: async () => [],
      getSong: async () => demoSong,
      getArtist: async () => null,
      getAlbum: async () => null,
      getPlaylist: async () => null,
      getAlbumTracks: async () => [demoSong],
      getStream: async () => ({ url: 'https://example.com/stub.mp3', mimeType: 'audio/mpeg', quality: 'High', allowsOffline: true }),
      getArtwork: async () => null,
      getLyrics: async () => null,
    });
  }
  pm.setEnabled('stub', true);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('downloadStateLabel', () => {
  it('labels every explicit state', () => {
    expect(downloadStateLabel('QUEUED')).toBe('Waiting');
    expect(downloadStateLabel('DOWNLOADING')).toBe('Downloading');
    expect(downloadStateLabel('PAUSED')).toBe('Paused');
    expect(downloadStateLabel('COMPLETED')).toBe('Offline');
    expect(downloadStateLabel('FAILED')).toBe('Failed');
    expect(downloadStateLabel('CANCELLED')).toBe('Cancelled');
    expect(downloadStateLabel('REMOVED')).toBe('Removed');
  });
});

describe('DownloadManager (integration with stub provider)', () => {
  it('downloads atomically: no offline track until bytes validate', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
    })));

    const { getDb: gdb } = await import('../../src/data/db');
    await gdb().songs.put({ ...demoSong });
    const id = await useDownloads.getState().enqueue(demoSong);

    // poll for completion (background queue processor)
    for (let i = 0; i < 100; i++) {
      const rec = await downloadRepo.get(id);
      if (rec?.state === 'COMPLETED') break;
      if (rec?.state === 'FAILED') throw new Error(`download failed: ${rec.error}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const rec = (await downloadRepo.get(id))!;
    expect(rec.state).toBe('COMPLETED');
    expect(rec.progress).toBe(1);
    const { offlineRepo } = await import('../../src/data/repositories');
    expect(await offlineRepo.get(demoSong.id)).toBeDefined();
  });

  it('refuses sources that forbid offline storage', async () => {
    const pm = getProviderManager();
    pm.register({
      id: 'nooff', name: 'NoOff',
      capabilities: {
        supportsSearch: true, supportsStreaming: true, supportsOffline: false,
        supportsLyrics: false, supportsArtwork: false, supportsArtists: false, supportsAlbums: false,
      },
      searchSongs: async () => [], searchArtists: async () => [], searchAlbums: async () => [],
      searchPlaylists: async () => [], getSong: async () => null, getArtist: async () => null,
      getAlbum: async () => null, getPlaylist: async () => null, getAlbumTracks: async () => [],
      getStream: async () => { throw new Error('no'); }, getArtwork: async () => null, getLyrics: async () => null,
    });
    await expect(useDownloads.getState().enqueue({ ...demoSong, id: 'nooff:x', providerId: 'nooff' }))
      .rejects.toThrow(/unavailable/i);
  });

  it('enforces the storage limit instead of silently overfilling', async () => {
    useSettings.setState({ maxOfflineBytes: 10 });
    const check = await storageManager.canStore(999999);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/limit reached/);
    useSettings.setState({ maxOfflineBytes: -1 });
    expect((await storageManager.canStore(999999)).ok).toBe(true);
  });
});

describe('storage auto-cleanup', () => {
  it('removes expired cache but never favorite-linked entries', async () => {
    useSettings.setState({ autoCleanup: true, cacheTtlDays: 7 });
    const db = getDb();
    await db.cache.bulkPut([
      { key: 'expired', value: 'x', expiresAt: Date.now() - 1000, updatedAt: Date.now() - 1000 },
      { key: 'song:fav-1', value: 'x', expiresAt: Date.now() - 1000, updatedAt: Date.now() - 1000 },
      { key: 'fresh', value: 'x', expiresAt: Date.now() + 100000, updatedAt: Date.now() },
    ]);
    const { removedCache } = await storageManager.autoCleanup(new Set(['fav-1']));
    expect(removedCache).toBe(1);
    expect(await db.cache.get('song:fav-1')).toBeDefined();
    expect(await db.cache.get('fresh')).toBeDefined();
  });
});
