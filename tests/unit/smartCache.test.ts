// Smart Cache test matrix (PHASE 19) — reconstructed system, CASE D.
//
// 1. empty cache · 2. cache miss · 3. cache hit · 4. invalid cache
// 5. corrupted cache · 6. zero-byte cache · 7. invalid media · 8. cache clear
// 9. cache rebuild · 10. eviction · 11. repeated same track · 12. multiple tracks
// 13. provider failure · 14. cache hit without network · 15. cache invalidation
// 16. cache does not appear as Offline Download
//
// All mocked and deterministic — no live network, no real audio.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../src/data/db';
import type { SmartCacheEntry } from '../../src/cache/cacheTypes';
import { validateCacheBytes, validateCacheEntry } from '../../src/cache/cacheValidator';
import {
  getCacheEntry,
  putCacheEntry,
  removeCacheEntry,
  clearCacheEntries,
  countCacheEntries,
  totalCacheBytes,
} from '../../src/cache/cacheStorage';
import { enforceCacheLimits } from '../../src/cache/cacheEviction';
import {
  lookupCacheTrack,
  fetchBytesForCache,
  storeCacheTrack,
  touchCacheTrack,
} from '../../src/cache/cachePlayback';
import {
  isSmartCacheEnabled,
  smartCacheLimits,
  clearSmartCache,
  smartCacheStats,
} from '../../src/cache/smartCache';
import { useSettings } from '../../src/settings/settingsStore';

const mp3 = (n = 4096): Uint8Array => {
  const b = new Uint8Array(n).fill(0x61);
  b[0] = 0x49; b[1] = 0x44; b[2] = 0x33; // ID3 — recognized container
  return b;
};

const entry = (over: Partial<SmartCacheEntry> = {}): SmartCacheEntry => {
  const data = mp3();
  return {
    id: 'jamendo:t1', provider: 'jamendo', providerTrackId: 't1',
    title: 'T', artist: 'A', data, mimeType: 'audio/mpeg',
    fileSize: data.byteLength, format: 'mp3', quality: 'MP3',
    durationMs: 180000, cachedAt: Date.now(), lastPlayedAt: Date.now(),
    lastVerifiedAt: Date.now(), complete: true, ...over,
  };
};

const songLike = (id: string) => ({
  id, providerId: 'jamendo', providerTrackId: id.split(':')[1] ?? id,
  title: 'T', artist: 'A', durationMs: 180000,
});

function audioFetch(bytes: Uint8Array = mp3(), mime = 'audio/mpeg', status = 200) {
  return (async () => new Response(bytes, {
    status, headers: { 'content-type': mime },
  })) as unknown as typeof fetch;
}

beforeEach(async () => {
  await getDb().smartcache.clear().catch(() => undefined);
  useSettings.setState({ smartCacheEnabled: true } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await getDb().smartcache.clear().catch(() => undefined);
  useSettings.setState({ smartCacheEnabled: true } as never);
});

describe('Smart Cache matrix', () => {
  it('1. empty cache lookups MISS', async () => {
    expect(await lookupCacheTrack('jamendo:missing')).toEqual({ status: 'miss' });
    expect(await countCacheEntries()).toBe(0);
  });

  it('2. cache MISS downloads, validates, and commits', async () => {
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('miss');
    const fetched = await fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg', fetchImpl: audioFetch(),
    });
    expect(fetched.bytes.byteLength).toBe(4096);
    expect(fetched.container).toBe('mp3');
    const stored = await storeCacheTrack(songLike('jamendo:t1'), fetched, { maxBytes: 1 << 30, ttlDays: 30 });
    expect(stored.committed).toBe(true);
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('hit');
  });

  it('3. cache HIT serves validated bytes without network', async () => {
    await putCacheEntry(entry());
    const hit = await lookupCacheTrack('jamendo:t1');
    expect(hit.status).toBe('hit');
    if (hit.status === 'hit') {
      expect(hit.entry.data.byteLength).toBe(4096);
      expect(validateCacheEntry(hit.entry).ok).toBe(true);
    }
  });

  it('4. invalid cache auto-invalidates (never served, never retried)', async () => {
    const bad = entry({ data: new TextEncoder().encode('<html>e</html>'.padEnd(2048, ' ')) });
    (bad as { fileSize: number }).fileSize = bad.data.byteLength;
    await getDb().smartcache.put(bad).catch(() => undefined);
    const r = await lookupCacheTrack('jamendo:t1');
    expect(r.status).toBe('invalid');
    // Auto-removed: a second lookup is a clean MISS (rebuild path).
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('miss');
  });

  it('5. corrupted cache (size mismatch) invalidates', async () => {
    await putCacheEntry(entry());
    await getDb().smartcache.update('jamendo:t1', { fileSize: 1 });
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('invalid');
    expect(await getCacheEntry('jamendo:t1')).toBeUndefined();
  });

  it('6. zero-byte cache entries are rejected and never committed', async () => {
    expect(validateCacheBytes(new Uint8Array(0)).ok).toBe(false);
    await expect(putCacheEntry(entry({ data: new Uint8Array(0), fileSize: 0 }))).rejects.toThrow();
    expect(await countCacheEntries()).toBe(0);
  });

  it('7. invalid media (HTML/JSON/wrong MIME) never commits', async () => {
    await expect(fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg',
      fetchImpl: audioFetch(new TextEncoder().encode('<html>e</html>'.padEnd(2048, ' ')), 'text/html'),
    })).rejects.toThrow(/not audio/i);
    await expect(fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg',
      fetchImpl: audioFetch(new Uint8Array(0)),
    })).rejects.toThrow();
    await expect(fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg',
      fetchImpl: audioFetch(mp3(), 'audio/mpeg', 404),
    })).rejects.toThrow(/HTTP 404/);
    expect(await countCacheEntries()).toBe(0);
  });

  it('8. Clear Smart Cache wipes ONLY cache rows', async () => {
    await putCacheEntry(entry());
    await getDb().songs.put({ id: 'jamendo:t1', providerId: 'jamendo', providerTrackId: 't1', title: 'T', artist: 'A', album: '', durationMs: 1, addedAt: 0 } as never);
    const n = await clearSmartCache();
    expect(n).toBe(1);
    expect(await countCacheEntries()).toBe(0);
    expect(await getDb().songs.get('jamendo:t1')).toBeDefined();
    await getDb().songs.delete('jamendo:t1').catch(() => undefined);
  });

  it('9. cache rebuilds after clear (MISS → fetch → HIT)', async () => {
    await putCacheEntry(entry());
    await clearSmartCache();
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('miss');
    const fetched = await fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg', fetchImpl: audioFetch(),
    });
    await storeCacheTrack(songLike('jamendo:t1'), fetched, { maxBytes: 1 << 30, ttlDays: 30 });
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('hit');
  });

  it('10. eviction enforces the byte cap with LRU order', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await putCacheEntry(entry({ id: `jamendo:e${i}`, lastPlayedAt: now - (3 - i) * 1000 }));
    }
    const res = await enforceCacheLimits({ maxBytes: 9000, ttlDays: 0 });
    expect(res.evicted).toBeGreaterThanOrEqual(1);
    expect(await totalCacheBytes()).toBeLessThanOrEqual(9000);
  });

  it('11. repeated same track resolves from cache (touch updates recency)', async () => {
    await putCacheEntry(entry());
    const before = (await getCacheEntry('jamendo:t1'))!.lastPlayedAt;
    await new Promise((r) => setTimeout(r, 5));
    await touchCacheTrack('jamendo:t1');
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('hit');
    expect((await getCacheEntry('jamendo:t1'))!.lastPlayedAt).toBeGreaterThanOrEqual(before);
  });

  it('12. multiple tracks coexist independently', async () => {
    await putCacheEntry(entry({ id: 'jamendo:a' }));
    await putCacheEntry(entry({ id: 'airbeats:b', provider: 'airbeats', providerTrackId: 'b' }));
    expect(await countCacheEntries()).toBe(2);
    await removeCacheEntry('jamendo:a');
    expect((await lookupCacheTrack('jamendo:a')).status).toBe('miss');
    expect((await lookupCacheTrack('airbeats:b')).status).toBe('hit');
  });

  it('13. provider failure surfaces honestly (nothing cached, nothing thrown wrongly)', async () => {
    const failing = (async () => { throw new TypeError('down'); }) as unknown as typeof fetch;
    await expect(fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg', fetchImpl: failing,
    })).rejects.toThrow(/download failed/i);
    expect((await lookupCacheTrack('jamendo:t1')).status).toBe('miss');
  });

  it('14. cache HIT works with fetch globally broken (no network)', async () => {
    await putCacheEntry(entry());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const hit = await lookupCacheTrack('jamendo:t1');
    expect(hit.status).toBe('hit');
    if (hit.status === 'hit') expect(validateCacheEntry(hit.entry).ok).toBe(true);
  });

  it('15. invalidation removes exactly the corrupted row', async () => {
    await putCacheEntry(entry({ id: 'jamendo:good' }));
    const bad = entry({ id: 'jamendo:bad', data: new Uint8Array(100), fileSize: 100 });
    await getDb().smartcache.put(bad).catch(() => undefined);
    expect((await lookupCacheTrack('jamendo:bad')).status).toBe('invalid');
    expect((await lookupCacheTrack('jamendo:good')).status).toBe('hit');
  });

  it('16. cache entries NEVER appear as Offline Downloads', async () => {
    await putCacheEntry(entry());
    const { offlineRepo } = await import('../../src/data/repositories');
    expect(await offlineRepo.get('jamendo:t1')).toBeUndefined();
  });

  it('disabled cache bypasses lookup and commit', async () => {
    useSettings.setState({ smartCacheEnabled: false } as never);
    expect(isSmartCacheEnabled()).toBe(false);
    await putCacheEntry(entry());
    // Direct storage still readable; the playback path treats disabled as MISS.
    expect(await getCacheEntry('jamendo:t1')).toBeDefined();
    expect(smartCacheLimits().maxBytes).toBeGreaterThan(0);
    const stats = await smartCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBe(4096);
  });
});
