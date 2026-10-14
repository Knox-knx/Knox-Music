// Audio root-cause diagnostics — TEST MATRIX (PHASE 11/12/14) + lifecycle.
//
// Isolates the repeated-play silence layer WITHOUT real audio (mocked
// fetch + stubbed engine wait/play — no live network):
//
//  TEST A: direct provider URL, no Blob, no temp file (debug bypass)
//  TEST B: Blob object URL path
//  TEST D: same song repeated (same provider URL 3x — element vs provider?)
//  TEST E: A → B → A
//  TEST F: A → B → C → A → B → A (PHASE 12 recording)
//  TEST G/H: pause→resume / next→previous keep/replace sessions correctly
//  Generation isolation: a superseded generation cannot touch element/state
//  Engine ownership: stale assign throws, older-gen release refuses,
//    per-generation diagnostics + full event trail (incl. emptied/seek)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Song } from '../../src/core/types';
import type { MusicProvider } from '../../src/providers/types';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { usePlayer } from '../../src/audio/playerStore';
import { clearSmartCache } from '../../src/cache/smartCache';
import { lookupCacheTrack } from '../../src/cache/cachePlayback';
import { countCacheEntries } from '../../src/cache/cacheStorage';
import { getDb } from '../../src/data/db';

function mkSong(id: string, over: Partial<Song> = {}): Song {
  const sep = id.indexOf(':');
  return {
    id,
    providerId: sep > 0 ? id.slice(0, sep) : 'jamendo',
    providerTrackId: sep > 0 ? id.slice(sep + 1) : id,
    title: `Title ${id}`, artist: 'Test Artist', album: 'Test Album',
    durationMs: 180000, addedAt: 0,
    ...over,
  } as Song;
}

/** Provider returning a CONSTANT url per track id (PHASE 11: same-URL repeat). */
function stubFixedUrlProvider(): MusicProvider {
  return {
    id: 'jamendo', name: 'jamendo',
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async () => [],
    searchArtists: async () => [],
    searchAlbums: async () => [],
    searchPlaylists: async () => [],
    getSong: async () => null,
    getArtist: async () => null,
    getAlbum: async () => null,
    getPlaylist: async () => null,
    getAlbumTracks: async () => [],
    getStream: async (song: Song) => ({
      url: `https://example.com/${song.providerTrackId}.mp3`,
      mimeType: 'audio/mpeg', quality: 'MP3', allowsOffline: false,
    }),
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

function audioFetch() {
  const body = new Uint8Array(8192).fill(0x61);
  return (async () => new Response(body, {
    status: 200, headers: { 'content-type': 'audio/mpeg' },
  })) as unknown as typeof fetch;
}

let urlCounter = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  const pm = getProviderManager();
  pm.register(stubFixedUrlProvider(), true);
  pm.setEnabled('jamendo', true);
  try { pm.healthManager().reset('jamendo'); } catch { /* ignore */ }
  usePlayer.getState().hydrateFromEngine();
  vi.spyOn(getAudioEngine(), 'loadTempSource').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'play').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'awaitClockAdvance').mockResolvedValue(true);
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(audioFetch()));
  urlCounter = 0;
  URL.createObjectURL = vi.fn(() => `blob:matrix-${++urlCounter}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  try { localStorage.removeItem('knox.dbg.directPlayback'); } catch { /* ignore */ }
  try { localStorage.removeItem('knox.dbg.tempCleanup'); } catch { /* ignore */ }
  usePlayer.setState({ volume: 0.9, muted: false, error: null, queue: [], index: -1, current: null } as never);
  await clearSmartCache().catch(() => undefined);
  await getDb().offline.clear().catch(() => undefined);
});

afterEach(() => {
  try { localStorage.removeItem('knox.dbg.directPlayback'); } catch { /* ignore */ }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TEST A — direct provider playback bypass (no Blob, no temp)', () => {
  it('routes the provider URL straight to the element with no temp session', async () => {
    try { localStorage.setItem('knox.dbg.directPlayback', '1'); } catch { /* ignore */ }
    const assignSpy = vi.spyOn(getAudioEngine(), 'assignSourceForGeneration').mockResolvedValue(undefined);
    try {
      const a = mkSong('jamendo:directA');
      expect(await usePlayer.getState().playSong(a)).toBe(true);
      // Element received the PROVIDER url (not a blob: URL).
      expect(assignSpy).toHaveBeenCalled();
      const [gen, url, meta] = assignSpy.mock.calls[assignSpy.mock.calls.length - 1];
      expect(typeof gen).toBe('number');
      expect(url).toContain('https://example.com/directA.mp3');
      expect(meta.kind).toBe('direct');
      // No Blob created, nothing cached on the bypass path.
      expect(URL.createObjectURL).not.toHaveBeenCalled();
      expect(await countCacheEntries()).toBe(0);
      expect(usePlayer.getState().qualityLabel).toContain('Direct debug');
    } finally {
      assignSpy.mockRestore();
    }
  });

  it('TEST F on the direct path: A → B → A → C → B → A all play', async () => {
    try { localStorage.setItem('knox.dbg.directPlayback', '1'); } catch { /* ignore */ }
    const assignSpy = vi.spyOn(getAudioEngine(), 'assignSourceForGeneration').mockResolvedValue(undefined);
    try {
      const seq = ['A', 'B', 'A', 'C', 'B', 'A'].map((t) => mkSong(`jamendo:mx${t}`, { title: `Song ${t}` }));
      for (const s of seq) {
        expect(await usePlayer.getState().playSong(s)).toBe(true);
        expect(usePlayer.getState().error).toBeNull();
      }
      // Every playback assigned a fresh provider URL (never a reused blob).
      expect(assignSpy.mock.calls.length).toBe(6);
      const urls = assignSpy.mock.calls.map((c) => c[1] as string);
      expect(new Set(urls).size).toBe(3); // 3 distinct tracks, provider URLs stable
      expect(urls.every((u) => u.startsWith('https://'))).toBe(true);
      expect(await countCacheEntries()).toBe(0);
    } finally {
      assignSpy.mockRestore();
    }
  });
});

describe('TEST B/D/E/F — Smart Cache matrix', () => {
  it('TEST D: same song 3x with the SAME provider URL — MISS then HITs, fresh URL every play', async () => {
    const a = mkSong('jamendo:repeatA');
    const createSpy = vi.mocked(URL.createObjectURL);
    const issued: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(await usePlayer.getState().playSong(a)).toBe(true);
      issued.push(String(createSpy.mock.results[createSpy.mock.results.length - 1].value));
    }
    // Same provider URL in, but never a reused object URL out.
    expect(new Set(issued).size).toBe(3);
    // One persistent row serves all three plays.
    expect((await lookupCacheTrack(a.id)).status).toBe('hit');
    expect(await countCacheEntries()).toBe(1);
  });

  it('TEST E: A → B → A all play (replay is a HIT)', async () => {
    const mk = (t: string) => mkSong(`jamendo:ex${t}`, { title: `Song ${t}` });
    const [A, B] = [mk('A'), mk('B')];
    expect(await usePlayer.getState().playSong(A)).toBe(true);
    expect(await usePlayer.getState().playSong(B)).toBe(true);
    expect(await usePlayer.getState().playSong(A)).toBe(true);
    expect((await lookupCacheTrack(A.id)).status).toBe('hit');
    expect((await lookupCacheTrack(B.id)).status).toBe('hit');
  });

  it('TEST F (PHASE 12): A → B → C → A → B → A — every playback recorded', async () => {
    const mk = (t: string) => mkSong(`jamendo:fx${t}`, { title: `Song ${t}` });
    const seq = ['A', 'B', 'C', 'A', 'B', 'A'].map(mk);
    for (const s of seq) {
      const ok = await usePlayer.getState().playSong(s);
      expect(ok).toBe(true);
      expect(usePlayer.getState().current?.id).toBe(s.id);
    }
    // Three persistent rows (one per track); replays were HITs.
    expect(await countCacheEntries()).toBe(3);
  });
});

describe('generation isolation (PHASE 4)', () => {
  it('a superseded generation cannot touch element assignment or state', async () => {
    const resolvers: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => {
      resolvers.push(res);
    })));
    const body = () => new Response(new Uint8Array(8192).fill(0x61), {
      status: 200, headers: { 'content-type': 'audio/mpeg' },
    });
    const a = mkSong('jamendo:genA');
    const b = mkSong('jamendo:genB');
    const pA = usePlayer.getState().playSong(a);
    await tick();
    await tick();
    // A is now pending inside its cache download.
    const pB = usePlayer.getState().playSong(b);
    await tick();
    await tick();
    // Resolve A's download first (stale), then B's.
    resolvers[0](body());
    await tick();
    await tick();
    resolvers[1](body());
    const [okA, okB] = await Promise.all([pA, pB]);
    expect(okA).toBe(false);
    expect(okB).toBe(true);
    expect(usePlayer.getState().current?.id).toBe(b.id);
    // B committed its row; A's superseded playback never hijacked the element.
    expect((await lookupCacheTrack(b.id)).status).toBe('hit');
  });
});

describe('engine generation ownership (PHASE 3/4/5)', () => {
  it('stale generation assign throws; older-gen release refuses', async () => {
    const engine = getAudioEngine();
    // Start clean regardless of earlier tests in this file.
    await engine.releaseCurrentSource(0).catch(() => undefined);
    const waitSpy = vi.spyOn(engine, 'waitForCanPlay').mockResolvedValue(undefined);
    const loadSpy = vi.spyOn(
      (engine as unknown as { audio: HTMLAudioElement }).audio, 'load',
    ).mockImplementation(() => undefined);
    try {
      engine.claimGeneration(50);
      await expect(engine.assignSourceForGeneration(
        49, 'https://example.com/old.mp3', { trackId: 'old', kind: 'direct' },
      )).rejects.toThrow(/stale/i);
      const revoked: string[] = [];
      await engine.assignSourceForGeneration(50, 'https://example.com/new.mp3', {
        trackId: 'new', kind: 'direct', revoker: (u) => { revoked.push(u); },
      });
      expect(engine.getOwnedSource()?.trackId).toBe('new');
      // Older generation must not release or revoke the current source.
      const refused = await engine.releaseCurrentSource(49);
      expect(refused.released).toBe(false);
      expect(revoked).toHaveLength(0);
      expect(engine.getOwnedSource()?.trackId).toBe('new');
      // Owning generation releases cleanly with owner revoker.
      const done = await engine.releaseCurrentSource(50);
      expect(done.released).toBe(true);
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toContain('https://example.com/new.mp3');
      expect(engine.getOwnedSource()).toBeNull();
    } finally {
      waitSpy.mockRestore();
      loadSpy.mockRestore();
      await engine.releaseCurrentSource(0).catch(() => undefined);
    }
  });

  it('per-generation diagnostics expose state, clock, error, and trail', async () => {
    const engine = getAudioEngine();
    await engine.releaseCurrentSource(0).catch(() => undefined);
    const waitSpy = vi.spyOn(engine, 'waitForCanPlay').mockResolvedValue(undefined);
    const audio = (engine as unknown as { audio: HTMLAudioElement }).audio;
    const loadSpy = vi.spyOn(audio, 'load').mockImplementation(() => undefined);
    try {
      engine.claimGeneration(60);
      await engine.assignSourceForGeneration(60, 'https://example.com/d.mp3', {
        trackId: 'jamendo:d', kind: 'direct',
      });
      audio.dispatchEvent(new Event('loadstart'));
      audio.dispatchEvent(new Event('loadedmetadata'));
      audio.dispatchEvent(new Event('canplay'));
      audio.dispatchEvent(new Event('seeking'));
      audio.dispatchEvent(new Event('seeked'));
      audio.dispatchEvent(new Event('emptied'));
      const d = engine.getSourceDiagnostics();
      expect(d.generation).toBe(60);
      expect(d.trackId).toBe('jamendo:d');
      expect(d.sourceKind).toBe('direct');
      expect(d.srcHost).toContain('example.com');
      expect(d.eventTrail).toContain('loadstart');
      expect(d.eventTrail).toContain('seeking');
      expect(d.eventTrail).toContain('seeked');
      expect(d.eventTrail).toContain('emptied');
      expect(typeof d.currentTimeMs).toBe('number');
      expect(typeof d.readyState).toBe('number');
    } finally {
      waitSpy.mockRestore();
      loadSpy.mockRestore();
      await engine.releaseCurrentSource(0).catch(() => undefined);
    }
  });
});
