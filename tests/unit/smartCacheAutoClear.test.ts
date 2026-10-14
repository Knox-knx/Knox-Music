// Smart Cache auto-clear after playback — policy matrix.
//
// Covers: immediate natural end deletes; pause/resume/skip/error retain;
// replay HITs; A→B→A stale protection; 1h/6h/24h scheduling; never;
// restart persistence; radio; offline/library; manual clear; delete failure;
// HIT/MISS unchanged. All mocked — no live network, no real audio.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../src/data/db';
import type { SmartCacheEntry } from '../../src/cache/cacheTypes';
import { SMART_CACHE_AUTO_CLEAR_DEFAULT } from '../../src/cache/cacheTypes';
import {
  getCacheEntry,
  putCacheEntry,
} from '../../src/cache/cacheStorage';
import {
  lookupCacheTrack,
  fetchBytesForCache,
  storeCacheTrack,
} from '../../src/cache/cachePlayback';
import {
  clearSmartCache,
} from '../../src/cache/smartCache';
import {
  cancelSmartCacheAutoClear,
  getSmartCacheAutoClear,
  handleSmartCacheNaturalEnded,
  normalizeSmartCacheAutoClear,
  runSmartCacheAutoClearMaintenance,
  smartCacheAutoClearDelayMs,
  verifyNaturalEndedForAutoClear,
} from '../../src/cache/smartCacheAutoClear';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { useSettings, DEFAULT_SETTINGS } from '../../src/settings/settingsStore';

const mp3 = (n = 4096): Uint8Array => {
  const b = new Uint8Array(n).fill(0x61);
  b[0] = 0x49; b[1] = 0x44; b[2] = 0x33;
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

/** Drive the real engine singleton into a deterministic playback snapshot. */
function setEnginePlayback(opts: { trackId: string | null; generation: number; ended: boolean }) {
  const engine = getAudioEngine();
  const anyEng = engine as unknown as Record<string, unknown>;
  anyEng['latestGeneration'] = opts.generation;
  anyEng['owned'] = opts.trackId
    ? { generation: opts.generation, url: 'blob:mock-audio', trackId: opts.trackId, kind: 'temp-blob', revoker: null }
    : null;
  vi.spyOn(engine, 'getOwnedSource').mockImplementation(() => {
    if (!opts.trackId) return null;
    return { generation: opts.generation, trackId: opts.trackId, kind: 'temp-blob' };
  });
  vi.spyOn(engine, 'getLatestGeneration').mockReturnValue(opts.generation);
  vi.spyOn(engine, 'isCurrentGeneration').mockImplementation((g: number) => {
    if (g === 0) return true;
    return g === opts.generation;
  });
  vi.spyOn(engine, 'getDiagnostics').mockReturnValue({
    hasSrc: true, srcHost: 'blob://<local>', readyState: 4, networkState: 1,
    paused: !opts.ended, ended: opts.ended, muted: false, volume: 0.9,
    playbackRate: 1, durationMs: 180000, positionMs: opts.ended ? 180000 : 1000,
    bufferedMs: 180000, errorCode: null, audible: true,
  });
}

function audioFetch(bytes: Uint8Array = mp3(), mime = 'audio/mpeg', status = 200) {
  return (async () => new Response(bytes, {
    status, headers: { 'content-type': mime },
  })) as unknown as typeof fetch;
}

beforeEach(async () => {
  await getDb().smartcache.clear().catch(() => undefined);
  await getDb().offline.clear().catch(() => undefined);
  useSettings.setState({ smartCacheEnabled: true, smartCacheAutoClear: 'immediate' } as never);
  URL.createObjectURL = vi.fn(() => 'blob:mock-audio') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await getDb().smartcache.clear().catch(() => undefined);
  await getDb().offline.clear().catch(() => undefined);
  try {
    const eng = getAudioEngine() as unknown as Record<string, unknown>;
    eng['owned'] = null;
  } catch { /* ignore */ }
  useSettings.setState({ smartCacheEnabled: true, smartCacheAutoClear: 'immediate' } as never);
});

describe('settings default + migration', () => {
  it('default is Immediately after song ends for new installs', () => {
    expect(DEFAULT_SETTINGS.smartCacheAutoClear).toBe('immediate');
    expect(SMART_CACHE_AUTO_CLEAR_DEFAULT).toBe('immediate');
  });

  it('existing installs without a value migrate to immediate', () => {
    expect(normalizeSmartCacheAutoClear(undefined)).toBe('immediate');
    expect(normalizeSmartCacheAutoClear(null)).toBe('immediate');
    expect(normalizeSmartCacheAutoClear('')).toBe('immediate');
    expect(normalizeSmartCacheAutoClear('bogus')).toBe('immediate');
    expect(normalizeSmartCacheAutoClear('1h')).toBe('1h');
    expect(normalizeSmartCacheAutoClear('never')).toBe('never');
  });

  it('setting persists across reads and does not reset unrelated settings', async () => {
    useSettings.setState({ smartCacheAutoClear: '6h', smartCacheTtlDays: 30 } as never);
    expect(getSmartCacheAutoClear()).toBe('6h');
    expect(useSettings.getState().smartCacheTtlDays).toBe(30);
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    expect(getSmartCacheAutoClear()).toBe('immediate');
  });

  it('delay mapping is exact', () => {
    expect(smartCacheAutoClearDelayMs('immediate')).toBe(0);
    expect(smartCacheAutoClearDelayMs('1h')).toBe(3_600_000);
    expect(smartCacheAutoClearDelayMs('6h')).toBe(6 * 3_600_000);
    expect(smartCacheAutoClearDelayMs('24h')).toBe(24 * 3_600_000);
    expect(smartCacheAutoClearDelayMs('never')).toBeNull();
  });
});

describe('Smart Cache auto-clear matrix', () => {
  it('1. Immediate + natural ended → cache deleted (with diagnostics)', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:t1' }));
    expect(await getCacheEntry('jamendo:t1')).toBeDefined();
    setEnginePlayback({ trackId: 'jamendo:t1', generation: 7, ended: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const r = await handleSmartCacheNaturalEnded(
        { trackId: 'jamendo:t1', generation: 7, playerMode: 'track' },
      );
      expect(r.action).toBe('deleted');
      expect(r.policy).toBe('immediate');
    } finally {
      info.mockRestore();
    }
    // Flush the void async path used by the player store (same function, awaited here already).
    expect(await getCacheEntry('jamendo:t1')).toBeUndefined();
  });

  it('immediate deletion logs KNOX_SMART_CACHE_AUTO_CLEAR natural-ended deleted', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:log1' }));
    setEnginePlayback({ trackId: 'jamendo:log1', generation: 3, ended: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await handleSmartCacheNaturalEnded({ trackId: 'jamendo:log1', generation: 3, playerMode: 'track' });
      const lines = info.mock.calls.map((c) => String(c[0]) + ' ' + String(c[1] ?? ''));
      expect(lines.some((l) => l.includes('KNOX_SMART_CACHE_AUTO_CLEAR') && l.includes('policy=immediate') && l.includes('natural-ended') && l.includes('deleted'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('2. Immediate + pause → cache retained (ended=false is not natural completion)', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:pause1' }));
    // Paused: element reports ended=false.
    setEnginePlayback({ trackId: 'jamendo:pause1', generation: 1, ended: false });
    expect(verifyNaturalEndedForAutoClear({ trackId: 'jamendo:pause1', generation: 1, playerMode: 'track' })).toBe(false);
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:pause1', generation: 1, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:pause1')).toBeDefined();
  });

  it('3. Immediate + resume → cache retained (still not ended)', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:resume1' }));
    setEnginePlayback({ trackId: 'jamendo:resume1', generation: 2, ended: false });
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:resume1', generation: 2, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:resume1')).toBeDefined();
    // Resume plays from the same cache row → HIT.
    expect((await lookupCacheTrack('jamendo:resume1')).status).toBe('hit');
  });

  it('4. Immediate + manual skip → skipped track cache retained', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:A' }));
    await putCacheEntry(entry({ id: 'jamendo:B', providerTrackId: 'B' }));
    // A was playing (gen 1); user pressed Next → B now owns the engine (gen 2, playing).
    // A stale ended for A must not delete anything; B has not naturally ended either.
    setEnginePlayback({ trackId: 'jamendo:B', generation: 2, ended: false });
    // Stale A event (wrong track for current ownership).
    expect(verifyNaturalEndedForAutoClear({ trackId: 'jamendo:A', generation: 1, playerMode: 'track' })).toBe(false);
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:A', generation: 1, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:A')).toBeDefined();
    expect(await getCacheEntry('jamendo:B')).toBeDefined();
  });

  it('5. Immediate + playback error → cache retained', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:err1' }));
    // Error: element did not naturally end.
    setEnginePlayback({ trackId: 'jamendo:err1', generation: 4, ended: false });
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:err1', generation: 4, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:err1')).toBeDefined();
  });

  it('6. Immediate + replay → Smart Cache HIT (no premature deletion)', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    const fetched = await fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg', fetchImpl: audioFetch(),
    });
    await storeCacheTrack(songLike('jamendo:replay1'), fetched, { maxBytes: 1 << 30, ttlDays: 30 });
    expect((await lookupCacheTrack('jamendo:replay1')).status).toBe('hit');
    // Replay without natural end: still HIT (nothing deleted mid-playback).
    expect((await lookupCacheTrack('jamendo:replay1')).status).toBe('hit');
  });

  it('6b. replay cancels a pending delayed deadline', async () => {
    useSettings.setState({ smartCacheAutoClear: '1h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:cancel1' }));
    setEnginePlayback({ trackId: 'jamendo:cancel1', generation: 1, ended: true });
    const s = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:cancel1', generation: 1, playerMode: 'track' });
    expect(s.action).toBe('scheduled');
    expect((await getCacheEntry('jamendo:cancel1'))?.autoClearAt).toBeGreaterThan(Date.now());
    await cancelSmartCacheAutoClear('jamendo:cancel1');
    expect((await getCacheEntry('jamendo:cancel1'))?.autoClearAt ?? null).toBeNull();
    expect((await lookupCacheTrack('jamendo:cancel1')).status).toBe('hit');
  });

  it('7. A → B → A stale ended event never deletes the wrong entry', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:A' }));
    await putCacheEntry(entry({ id: 'jamendo:B', providerTrackId: 'B' }));
    // Current: second A (gen 3) playing, not ended. Stale first-A ended (gen 1) arrives.
    setEnginePlayback({ trackId: 'jamendo:A', generation: 3, ended: false });
    // Event carries the STALE generation → superseded → ignored.
    expect(verifyNaturalEndedForAutoClear({ trackId: 'jamendo:A', generation: 1, playerMode: 'track' })).toBe(false);
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:A', generation: 1, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:A')).toBeDefined();
    expect(await getCacheEntry('jamendo:B')).toBeDefined();
    // Also: stale cross-track (owned B, event for A) ignored.
    setEnginePlayback({ trackId: 'jamendo:B', generation: 2, ended: false });
    const r2 = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:A', generation: 1, playerMode: 'track' });
    expect(r2.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:A')).toBeDefined();
    expect(await getCacheEntry('jamendo:B')).toBeDefined();
  });

  it('8. 1h → cleanup scheduled correctly (20:00 ends → 21:00 delete)', async () => {
    useSettings.setState({ smartCacheAutoClear: '1h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:h1' }));
    setEnginePlayback({ trackId: 'jamendo:h1', generation: 1, ended: true });
    const t0 = 1_700_000_000_000; // fixed clock
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:h1', generation: 1, playerMode: 'track' }, { now: t0 });
    expect(r.action).toBe('scheduled');
    const row = await getCacheEntry('jamendo:h1');
    expect(row).toBeDefined();
    expect(row?.autoClearAt).toBe(t0 + 3_600_000);
    expect(row?.autoClearPolicy).toBe('1h');
  });

  it('9. 6h → cleanup scheduled correctly (20:00 ends → 02:00 delete)', async () => {
    useSettings.setState({ smartCacheAutoClear: '6h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:h6' }));
    setEnginePlayback({ trackId: 'jamendo:h6', generation: 1, ended: true });
    const t0 = 1_700_000_000_000;
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:h6', generation: 1, playerMode: 'track' }, { now: t0 });
    expect(r.action).toBe('scheduled');
    expect((await getCacheEntry('jamendo:h6'))?.autoClearAt).toBe(t0 + 6 * 3_600_000);
  });

  it('10. 24h → cleanup scheduled correctly (20:00 ends → next day 20:00)', async () => {
    useSettings.setState({ smartCacheAutoClear: '24h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:h24' }));
    setEnginePlayback({ trackId: 'jamendo:h24', generation: 1, ended: true });
    const t0 = 1_700_000_000_000;
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:h24', generation: 1, playerMode: 'track' }, { now: t0 });
    expect(r.action).toBe('scheduled');
    expect((await getCacheEntry('jamendo:h24'))?.autoClearAt).toBe(t0 + 24 * 3_600_000);
  });

  it('delayed scheduling logs action=scheduled (no JS timer kept)', async () => {
    useSettings.setState({ smartCacheAutoClear: '1h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:schedlog' }));
    setEnginePlayback({ trackId: 'jamendo:schedlog', generation: 1, ended: true });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await handleSmartCacheNaturalEnded({ trackId: 'jamendo:schedlog', generation: 1, playerMode: 'track' });
      const lines = info.mock.calls.map((c) => String(c[0]) + ' ' + String(c[1] ?? ''));
      expect(lines.some((l) => l.includes('KNOX_SMART_CACHE_AUTO_CLEAR') && l.includes('action=scheduled'))).toBe(true);
    } finally {
      info.mockRestore();
    }
    // Entry retained until its deadline (persistent timestamp, not a timer).
    expect(await getCacheEntry('jamendo:schedlog')).toBeDefined();
  });

  it('11. Never → natural ended does not delete cache', async () => {
    useSettings.setState({ smartCacheAutoClear: 'never' } as never);
    await putCacheEntry(entry({ id: 'jamendo:never1' }));
    setEnginePlayback({ trackId: 'jamendo:never1', generation: 9, ended: true });
    const r = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:never1', generation: 9, playerMode: 'track' });
    expect(r.action).toBe('ignored');
    expect((await lookupCacheTrack('jamendo:never1')).status).toBe('hit');
  });

  it('12. Restart → delayed cleanup survives restart (persistent deadline)', async () => {
    useSettings.setState({ smartCacheAutoClear: '1h' } as never);
    await putCacheEntry(entry({ id: 'jamendo:restart1' }));
    setEnginePlayback({ trackId: 'jamendo:restart1', generation: 1, ended: true });
    const t0 = 1_700_000_000_000;
    await handleSmartCacheNaturalEnded({ trackId: 'jamendo:restart1', generation: 1, playerMode: 'track' }, { now: t0 });
    // "Restart": deadline still on the row; early sweep keeps it.
    const early = await runSmartCacheAutoClearMaintenance({ now: t0 + 1000, excludeId: 'other' });
    expect(early.cleaned).toBe(0);
    expect(await getCacheEntry('jamendo:restart1')).toBeDefined();
    // Late sweep (after 1h) deletes it — same DB, no timer needed.
    const late = await runSmartCacheAutoClearMaintenance({ now: t0 + 3_600_001, excludeId: 'other' });
    expect(late.cleaned).toBe(1);
    expect(await getCacheEntry('jamendo:restart1')).toBeUndefined();
  });

  it('maintenance never evicts the currently playing entry', async () => {
    useSettings.setState({ smartCacheAutoClear: '1h' } as never);
    const t0 = 1_700_000_000_000;
    await putCacheEntry(entry({ id: 'jamendo:playing', autoClearAt: t0 - 1, autoClearPolicy: '1h' }));
    const r = await runSmartCacheAutoClearMaintenance({ now: t0, excludeId: 'jamendo:playing' });
    expect(r.cleaned).toBe(0);
    expect(await getCacheEntry('jamendo:playing')).toBeDefined();
  });

  it('13. Radio → auto-clear policy does not affect radio', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:radio1' }));
    setEnginePlayback({ trackId: 'jamendo:radio1', generation: 1, ended: true });
    const r1 = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:radio1', generation: 1, playerMode: 'radio' });
    expect(r1.action).toBe('ignored');
    const r2 = await handleSmartCacheNaturalEnded({ trackId: 'jamendo:radio1', generation: 1, playerMode: 'track', isLive: true });
    expect(r2.action).toBe('ignored');
    expect(await getCacheEntry('jamendo:radio1')).toBeDefined();
  });

  it('14. Offline/library files remain untouched', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:lib1' }));
    const { offlineRepo, songRepo, favoriteRepo, playlistRepo } = await import('../../src/data/repositories');
    const song = { id: 'jamendo:lib1', providerId: 'jamendo', providerTrackId: 'lib1', title: 'T', artist: 'A', album: '', durationMs: 1, addedAt: 0 };
    await songRepo.upsert(song as never);
    await offlineRepo.put(song as never, new Blob(['audio'], { type: 'audio/mpeg' }), 'MP3');
    await favoriteRepo.add('jamendo:lib1');
    const pl = await playlistRepo.create('P', '', ['jamendo:lib1']);
    setEnginePlayback({ trackId: 'jamendo:lib1', generation: 1, ended: true });
    await handleSmartCacheNaturalEnded({ trackId: 'jamendo:lib1', generation: 1, playerMode: 'track' });
    expect(await getCacheEntry('jamendo:lib1')).toBeUndefined();
    // Everything else untouched.
    expect(await offlineRepo.get('jamendo:lib1')).toBeDefined();
    expect(await songRepo.get('jamendo:lib1')).toBeDefined();
    expect(await favoriteRepo.isFavorite('jamendo:lib1')).toBe(true);
    expect((await playlistRepo.get(pl.id))?.trackIds).toContain('jamendo:lib1');
    await offlineRepo.remove('jamendo:lib1').catch(() => undefined);
    await songRepo.remove('jamendo:lib1').catch(() => undefined);
    await favoriteRepo.remove('jamendo:lib1').catch(() => undefined);
    await playlistRepo.remove(pl.id).catch(() => undefined);
  });

  it('15. Manual Clear Smart Cache → only Smart Cache is removed', async () => {
    await putCacheEntry(entry({ id: 'jamendo:m1' }));
    const { offlineRepo, songRepo } = await import('../../src/data/repositories');
    const song = { id: 'jamendo:m1', providerId: 'jamendo', providerTrackId: 'm1', title: 'T', artist: 'A', album: '', durationMs: 1, addedAt: 0 };
    await songRepo.upsert(song as never);
    await offlineRepo.put(song as never, new Blob(['audio'], { type: 'audio/mpeg' }), 'MP3');
    const n = await clearSmartCache();
    expect(n).toBe(1);
    expect(await getCacheEntry('jamendo:m1')).toBeUndefined();
    expect(await songRepo.get('jamendo:m1')).toBeDefined();
    expect(await offlineRepo.get('jamendo:m1')).toBeDefined();
    await offlineRepo.remove('jamendo:m1').catch(() => undefined);
    await songRepo.remove('jamendo:m1').catch(() => undefined);
  });

  it('16. IndexedDB deletion failure → playback remains successful (best-effort warn)', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate' } as never);
    await putCacheEntry(entry({ id: 'jamendo:fail1' }));
    setEnginePlayback({ trackId: 'jamendo:fail1', generation: 1, ended: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const del = vi.spyOn(getDb().smartcache, 'delete').mockRejectedValueOnce(new Error('quota'));
    const del2 = vi.spyOn(getDb().smartcache, 'get').mockResolvedValueOnce(entry({ id: 'jamendo:fail1' }));
    try {
      let threw = false;
      try {
        await handleSmartCacheNaturalEnded({ trackId: 'jamendo:fail1', generation: 1, playerMode: 'track' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      const lines = warn.mock.calls.map((c) => String(c[0]) + ' ' + String(c[1] ?? ''));
      expect(lines.some((l) => l.includes('KNOX_SMART_CACHE_AUTO_CLEAR') && l.includes('result=failed'))).toBe(true);
    } finally {
      warn.mockRestore();
      del.mockRestore();
      del2.mockRestore();
    }
  });

  it('17. Existing cache HIT/MISS behavior unchanged', async () => {
    useSettings.setState({ smartCacheAutoClear: 'immediate', smartCacheEnabled: true } as never);
    expect((await lookupCacheTrack('jamendo:miss17')).status).toBe('miss');
    const fetched = await fetchBytesForCache('https://example.com/t.mp3', {
      sourceMimeType: 'audio/mpeg', fetchImpl: audioFetch(),
    });
    const stored = await storeCacheTrack(songLike('jamendo:miss17'), fetched, { maxBytes: 1 << 30, ttlDays: 30 });
    expect(stored.committed).toBe(true);
    expect((await lookupCacheTrack('jamendo:miss17')).status).toBe('hit');
  });
});
