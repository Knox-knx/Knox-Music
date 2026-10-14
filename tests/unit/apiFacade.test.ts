// Frontend API abstraction + input validation.
//
// Pins the Phase-5 contract: components call these facades, malformed ids
// fail fast, and every facade degrades honestly (empty results, never a
// crash or a second audio element).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertProviderId,
  assertTrackId,
  assertPlaylistId,
  assertQuery,
  transportInfo,
} from '../../src/api/client';
import { searchApi } from '../../src/api/search';
import { lyricsApi } from '../../src/api/lyrics';
import { libraryApi, playlistsApi, favoritesApi, historyApi } from '../../src/api/library';
import { downloadsApi } from '../../src/api/downloads';
import { settingsApi } from '../../src/api/settings';
import { radioApi } from '../../src/api/radio';
import { useSettings, DEFAULT_SETTINGS } from '../../src/settings/settingsStore';
import { getProviderManager } from '../../src/providers/ProviderManager';
import type { Song } from '../../src/core/types';

const song = (id: string, title = 'T'): Song => ({
  id,
  providerId: 'sample',
  providerTrackId: id,
  title,
  artist: 'A',
  album: 'B',
  durationMs: 1000,
  addedAt: Date.now(),
});

beforeEach(() => {
  useSettings.setState({ ...DEFAULT_SETTINGS, providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('client validation', () => {
  it('accepts well-formed ids and rejects hostile ones', () => {
    expect(assertProviderId('jamendo')).toBe('jamendo');
    expect(assertTrackId('jamendo:123')).toBe('jamendo:123');
    expect(assertPlaylistId('pl_abc-1')).toBe('pl_abc-1');
    expect(() => assertProviderId('../../etc/passwd')).toThrow(/invalid provider/);
    expect(() => assertProviderId('EVIL')).toThrow(/invalid provider/);
    expect(() => assertTrackId('../../etc/passwd')).toThrow(/invalid track/);
    expect(() => assertTrackId('')).toThrow(/invalid track/);
    expect(() => assertPlaylistId('')).toThrow(/invalid playlist/);
    expect(() => assertQuery('   ')).toThrow(/empty/);
    expect(assertQuery('  hello  ')).toBe('hello');
  });

  it('reports browser transport without a host', async () => {
    await expect(transportInfo()).resolves.toEqual({ mode: 'browser', apiOk: false });
  });
});

describe('searchApi', () => {
  it('returns empty results for blank queries without touching providers', async () => {
    const r = await searchApi.search('   ');
    expect(r).toEqual({ songs: [], artists: [], albums: [], playlists: [], failures: [], hasExactMatch: false });
  });

  it('searches the local library in offline mode', async () => {
    const { songRepo } = await import('../../src/data/repositories');
    await songRepo.upsert(song('sample:offline-1', 'Offline Anthem'));
    const r = await searchApi.search('Offline Anthem', { offlineOnly: true });
    expect(r.songs.length).toBeGreaterThanOrEqual(1);
    await songRepo.remove('sample:offline-1');
  });

  it('suggests from the local library without network', async () => {
    const { songRepo } = await import('../../src/data/repositories');
    await songRepo.upsert(song('sample:sug-1', 'Suggestible Tune'));
    const s = await searchApi.suggestions('Suggest');
    expect(s).toContain('Suggestible Tune');
    expect(await searchApi.suggestions('   ')).toEqual([]);
    await songRepo.remove('sample:sug-1');
  });
});

describe('library/playlists/favorites/history facades', () => {
  it('creates, updates and removes playlists with id validation', async () => {
    const pl = await playlistsApi.create('  Road Trip  ');
    expect(pl.name).toBe('Road Trip');
    await playlistsApi.addTrack(pl.id, song('sample:pl-1', 'Road Song'));
    const got = await playlistsApi.get(pl.id);
    expect(got?.trackIds).toContain('sample:pl-1');
    await expect(playlistsApi.get('../../x')).rejects.toThrow(/invalid playlist/);
    await playlistsApi.remove(pl.id);
    expect(await playlistsApi.get(pl.id)).toBeUndefined();
  });

  it('manages favorites honestly', async () => {
    const s = song('sample:fav-1', 'Fav Song');
    await favoritesApi.add(s);
    expect(await favoritesApi.isFavorite(s.id)).toBe(true);
    expect((await favoritesApi.list()).map((x) => x.id)).toContain(s.id);
    await favoritesApi.remove(s.id);
    expect(await favoritesApi.isFavorite(s.id)).toBe(false);
    await expect(favoritesApi.isFavorite('')).rejects.toThrow();
  });

  it('reads library + history without throwing on empty state', async () => {
    expect(Array.isArray(await libraryApi.songs(0, 5))).toBe(true);
    expect(typeof (await libraryApi.count())).toBe('number');
    expect(await libraryApi.getTrack('sample', 'missing-id')).toBeNull();
    expect(Array.isArray(await historyApi.recent(5))).toBe(true);
  });
});

describe('downloadsApi', () => {
  it('loads an (initially empty) download list', async () => {
    const items = await downloadsApi.list();
    expect(Array.isArray(items)).toBe(true);
  });

  it('rejects enqueue for tracks that forbid offline (capability-aware)', async () => {
    const bad: Song = {
      ...song('custom-preview:1', 'No Dl'),
      providerId: 'custom-preview',
      downloadAllowed: false,
      capabilities: { searchable: true, streamable: true, downloadable: false, offline: false, previewOnly: false },
    };
    await expect(downloadsApi.create(bad)).rejects.toThrow();
  });
});

describe('settingsApi', () => {
  it('round-trips settings and syncs the ProviderManager', async () => {
    const { registerProviders } = await import('../../src/core/knox');
    registerProviders();
    const before = await settingsApi.get();
    expect(typeof before.theme).toBe('string');
    await settingsApi.patch({ theme: 'light' });
    expect(useSettings.getState().theme).toBe('light');
    await settingsApi.patch({ theme: before.theme });
    // Toggling a provider toggle propagates to the live manager.
    await settingsApi.patch({ providersEnabled: { ...useSettings.getState().providersEnabled, jiosaavn: false } });
    expect(getProviderManager().list().find((p) => p.id === 'jiosaavn')?.enabled).toBe(false);
    await settingsApi.patch({ providersEnabled: { ...useSettings.getState().providersEnabled, jiosaavn: true } });
    expect(getProviderManager().list().find((p) => p.id === 'jiosaavn')?.enabled).toBe(true);
  });
});

describe('lyricsApi', () => {
  it('returns null for songs without identity (honest empty state)', async () => {
    expect(await lyricsApi.get({ ...song('x'), title: '  ', artist: '' })).toBeNull();
  });

  it('search resolves to a list (empty when offline), never throws', async () => {
    const r = await lyricsApi.search('nonexistent query xyz');
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('radioApi', () => {
  it('returns [] when the radio service is disabled (no network)', async () => {
    await settingsApi.patch({ providersEnabled: { ...useSettings.getState().providersEnabled, 'radio-browser': false } });
    expect(await radioApi.popular()).toEqual([]);
    expect(await radioApi.search('jazz')).toEqual([]);
    await settingsApi.patch({ providersEnabled: { ...useSettings.getState().providersEnabled, 'radio-browser': true } });
  });

  it('checkStation rejects blank uuids without network', async () => {
    expect(await radioApi.checkStation('   ')).toBe(false);
  });
});
