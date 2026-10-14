import { describe, it, expect, vi } from 'vitest';
import { ProviderManager } from '../../src/providers/ProviderManager';
import { SampleCatalogProvider } from '../../src/providers/SampleCatalogProvider';
import { ProviderError } from '../../src/core/errors';
import type { MusicProvider } from '../../src/providers/types';

function stub(id: string, songs: string[], fail?: 'throw' | 'hang'): MusicProvider {
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async (q: string) => {
      if (fail === 'throw') throw new ProviderError('NETWORK', 'down');
      if (fail === 'hang') await new Promise(() => undefined);
      return songs.filter((s) => s.toLowerCase().includes(q.toLowerCase())).map((title, i) => ({
        id: `${id}:${i}`, providerId: id, providerTrackId: String(i),
        title, artist: 'A', album: 'B', durationMs: 1000, addedAt: 0,
      }));
    },
    searchArtists: async () => [],
    searchAlbums: async () => [],
    searchPlaylists: async () => [],
    getSong: async () => null,
    getArtist: async () => null,
    getAlbum: async () => null,
    getPlaylist: async () => null,
    getAlbumTracks: async () => [],
    getStream: async () => { throw new ProviderError('UNSUPPORTED', 'no'); },
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

describe('ProviderManager', () => {
  it('aggregates results across providers', async () => {
    const pm = new ProviderManager(1000);
    pm.register(stub('a', ['Imagine Peace']));
    pm.register(stub('b', ['Imagine Dragons Hit']));
    const { items, failures } = await pm.searchAll('imagine', 'songs');
    expect(items).toHaveLength(2);
    expect(failures).toEqual([]);
  });

  it('isolates provider failures and keeps partial results', async () => {
    const pm = new ProviderManager(1000);
    pm.register(stub('good', ['Hello Song']));
    pm.register(stub('bad', [], 'throw'));
    const { items, failures } = await pm.searchAll('hello', 'songs');
    expect(items).toHaveLength(1);
    expect(failures).toEqual(['bad']);
  });

  it('times out hanging providers instead of hanging search', async () => {
    const pm = new ProviderManager(50);
    pm.register(stub('slow', [], 'hang'));
    pm.register(stub('fast', ['Quick Song']));
    const { items, failures } = await pm.searchAll('quick', 'songs');
    expect(failures).toEqual(['slow']);
    expect(items).toHaveLength(1);
  });

  it('respects enabled/disabled providers', async () => {
    const pm = new ProviderManager(1000);
    pm.register(stub('a', ['Song One']), false);
    const { items } = await pm.searchAll('song', 'songs');
    expect(items).toHaveLength(0);
    pm.setEnabled('a', true);
    const again = await pm.searchAll('song', 'songs');
    expect(again.items).toHaveLength(1);
  });
});

describe('SampleCatalogProvider', () => {
  it('declares honest capabilities (offline allowed for demo tracks)', () => {
    const p = new SampleCatalogProvider();
    expect(p.capabilities.supportsSearch).toBe(true);
    expect(p.capabilities.supportsOffline).toBe(true);
    expect(p.capabilities.supportsLyrics).toBe(false);
  });

  it('searches demo tracks', async () => {
    const p = new SampleCatalogProvider();
    expect(await p.searchSongs('soundhelix')).toHaveLength(12);
    expect(await p.searchSongs('song 3')).toHaveLength(1);
    expect(await p.searchSongs('zzz-no-match')).toHaveLength(0);
  });

  it('returns an offline-permitted stream', async () => {
    const p = new SampleCatalogProvider();
    const song = (await p.searchSongs('song 1'))[0];
    const stream = await p.getStream(song);
    expect(stream.allowsOffline).toBe(true);
    expect(stream.url.startsWith('https://')).toBe(true);
  });
});

describe('In-app server providers (real implementation)', () => {
  it('declares streaming + offline capabilities for jiosaavn, spotify, and youtube-music', async () => {
    const { JioSaavnProvider } = await import('../../src/providers/jiosaavn/provider');
    const { SpotifyProvider } = await import('../../src/providers/spotify/provider');
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    for (const p of [new JioSaavnProvider(), new SpotifyProvider(), new YouTubeMusicProvider()]) {
      expect(p.capabilities.supportsSearch).toBe(true);
      expect(p.capabilities.supportsStreaming).toBe(true);
      expect(p.capabilities.supportsOffline).toBe(true);
    }
  });
});
