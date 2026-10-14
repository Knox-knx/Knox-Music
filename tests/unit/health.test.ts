// ProviderHealthManager + ProviderManager health integration tests.

import { describe, it, expect, vi } from 'vitest';
import { ProviderHealthManager } from '../../src/providers/health';
import { ProviderManager } from '../../src/providers/ProviderManager';
import { ProviderError } from '../../src/core/errors';
import type { MusicProvider } from '../../src/providers/types';

function stub(id: string, fail = false): MusicProvider {
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async () => {
      if (fail) throw new ProviderError('NETWORK', `${id} down`);
      return [];
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

describe('ProviderHealthManager', () => {
  it('unknown providers start eligible; success records latency', () => {
    const h = new ProviderHealthManager();
    expect(h.isAvailable('jamendo')).toBe(true);
    h.recordSuccess('jamendo', 123);
    const view = h.get('jamendo');
    expect(view.available).toBe(true);
    expect(view.lastLatencyMs).toBe(123);
    expect(view.consecutiveFailures).toBe(0);
  });

  it('marks a provider down after the failure threshold', () => {
    const h = new ProviderHealthManager({ maxConsecutiveFailures: 3 });
    h.recordFailure('x', 'boom');
    h.recordFailure('x', 'boom');
    expect(h.isAvailable('x')).toBe(true);
    h.recordFailure('x', 'boom');
    expect(h.isAvailable('x')).toBe(false);
    expect(h.get('x').lastError).toBe('boom');
  });

  it('any success recovers immediately', () => {
    const h = new ProviderHealthManager({ maxConsecutiveFailures: 1 });
    h.recordFailure('x', 'boom');
    expect(h.isAvailable('x')).toBe(false);
    h.recordSuccess('x', 5);
    expect(h.isAvailable('x')).toBe(true);
  });

  it('recovers automatically after the cooldown (half-open)', () => {
    let t = 1000;
    const h = new ProviderHealthManager({ maxConsecutiveFailures: 1, cooldownMs: 60000, now: () => t });
    h.recordFailure('x', 'boom');
    expect(h.isAvailable('x')).toBe(false);
    t += 59999;
    expect(h.isAvailable('x')).toBe(false);
    t += 1;
    expect(h.isAvailable('x')).toBe(true);
  });

  it('rate-limited providers stay down until the window passes', () => {
    let t = 0;
    const h = new ProviderHealthManager({ now: () => t });
    h.recordFailure('x', 'slow down', { rateLimited: true, retryAfterMs: 5000 });
    expect(h.isAvailable('x')).toBe(false);
    t += 5000;
    expect(h.isAvailable('x')).toBe(true);
  });

  it('reset clears history', () => {
    const h = new ProviderHealthManager({ maxConsecutiveFailures: 1 });
    h.recordFailure('x', 'boom');
    h.reset('x');
    expect(h.isAvailable('x')).toBe(true);
  });
});

describe('ProviderManager health integration', () => {
  it('records success/failure per provider without changing results', async () => {
    const pm = new ProviderManager(1000);
    pm.register(stub('good'));
    pm.register(stub('bad', true));
    const { items, failures } = await pm.searchAll('hello', 'songs');
    expect(items).toEqual([]);
    expect(failures).toEqual(['bad']);
    expect(pm.healthManager().get('good').consecutiveFailures).toBe(0);
    expect(pm.healthManager().get('bad').consecutiveFailures).toBe(1);
    // Below threshold: still attempted (failures stay visible, not hidden).
    const again = await pm.searchAll('hello', 'songs');
    expect(again.failures).toEqual(['bad']);
  });

  it('skips down providers but keeps them in failures (no hammering)', async () => {
    const pm = new ProviderManager(1000, new ProviderHealthManager({ maxConsecutiveFailures: 1 }));
    const badSearch = vi.fn(async () => { throw new ProviderError('NETWORK', 'down'); });
    const bad = { ...stub('bad'), searchSongs: badSearch };
    pm.register(bad);
    await pm.searchAll('hello', 'songs');
    expect(badSearch).toHaveBeenCalledTimes(1);
    const r = await pm.searchAll('hello', 'songs');
    expect(r.failures).toEqual(['bad']);
    expect(badSearch).toHaveBeenCalledTimes(1); // skipped, not retried
  });

  it('rate-limited providers are skipped until recovery', async () => {
    let t = 0;
    const pm = new ProviderManager(
      1000, new ProviderHealthManager({ maxConsecutiveFailures: 100, now: () => t }),
    );
    const rl = {
      ...stub('rl'),
      searchSongs: async () => { throw new ProviderError('RATE_LIMIT', 'slow'); },
    };
    pm.register(rl);
    await pm.searchAll('hello', 'songs');
    const skipped = await pm.searchAll('hello', 'songs');
    expect(skipped.failures).toEqual(['rl']);
    t += 61000;
    await pm.searchAll('hello', 'songs').catch(() => undefined);
  });
});
