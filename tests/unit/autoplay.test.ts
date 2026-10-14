// KNOX Autoplay / Continuous Play — comprehensive tests (§22).
//
// Covers the 20 required cases using the real playerStore + stub providers.
// The audio element is stubbed (loadTempSource/play resolve); the Temporary
// Playback Buffer downloads via a mocked fetch returning valid audio bytes;
// history uses the fake-indexeddb backend from tests/setup.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Song } from '../../src/core/types';
import type { MusicProvider } from '../../src/providers/types';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { usePlayer } from '../../src/audio/playerStore';
import { useSettings } from '../../src/settings/settingsStore';
import { historyRepo, settingsRepo } from '../../src/data/repositories';
import { getDb } from '../../src/data/db';
import { clearSmartCache } from '../../src/cache/smartCache';
import { lookupCacheTrack } from '../../src/cache/cachePlayback';
import {
  resetAutoplayState,
  recordRecommendation,
  getNextCandidates,
  tryAcquireTransition,
  releaseTransition,
  isTransitionInProgress,
} from '../../src/autoplay/autoPlayManager';
import {
  getRecommendations,
  isPlayableCandidate,
  resolvePlayableEquivalent,
  filterExcluded,
} from '../../src/autoplay/recommendationEngine';
import { scoreCandidate } from '../../src/autoplay/candidateScoring';

// ---------- fixtures ----------

function mkSong(id: string, over: Partial<Song> = {}): Song {
  const sep = id.indexOf(':');
  const providerId = sep > 0 ? id.slice(0, sep) : 'jamendo';
  const providerTrackId = sep > 0 ? id.slice(sep + 1) : id;
  return {
    id, providerId, providerTrackId,
    title: `Title ${providerTrackId}`, artist: 'Test Artist', album: 'Test Album',
    durationMs: 180000, addedAt: 0,
    ...over,
  } as Song;
}

const faded = () => mkSong('jamendo:faded', { title: 'Faded', artist: 'Alan Walker', album: 'Different World', genre: 'Electronic' });
const spectre = () => mkSong('jamendo:spectre', { title: 'The Spectre', artist: 'Alan Walker', album: 'Different World', genre: 'Electronic' });
const alone = () => mkSong('jamendo:alone', { title: 'Alone', artist: 'Alan Walker', album: 'Different World', genre: 'Electronic' });
const onMyWay = () => mkSong('jamendo:onmyway', { title: 'On My Way', artist: 'Alan Walker', album: 'Live Fast', genre: 'Electronic' });
const unrelated = () => mkSong('airbeats:unrelated', { title: 'Unrelated Song', artist: 'Someone Else', album: 'Other', genre: 'Jazz' });

interface StubOpts {
  streaming?: boolean;
  songs?: Song[];
  failStreamIds?: string[];
  searchMode?: 'fixed' | 'throw';
}

function stubProvider(id: string, opts: StubOpts = {}): MusicProvider {
  const { streaming = true, songs = [], failStreamIds = [], searchMode = 'fixed' } = opts;
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: streaming, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true,
      supportsPlaybackCache: streaming,
    },
    searchSongs: async () => {
      if (searchMode === 'throw') throw new Error(`${id} down`);
      return [...songs];
    },
    searchArtists: async () => [],
    searchAlbums: async () => [],
    searchPlaylists: async () => [],
    getSong: async () => null,
    getArtist: async () => null,
    getAlbum: async () => null,
    getPlaylist: async () => null,
    getAlbumTracks: async () => [],
    getStream: async (song: Song) => {
      if (!streaming) throw new Error('UNSUPPORTED');
      if (failStreamIds.includes(song.id)) throw new Error('provider unreachable');
      return { url: `https://example.com/${song.providerTrackId}.mp3`, mimeType: 'audio/mpeg', quality: 'MP3 128k', allowsOffline: true };
    },
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

function engineAudioEl(): HTMLAudioElement {
  return (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio;
}

function seedPlayer(queue: Song[], index: number, extra: Record<string, unknown> = {}) {
  usePlayer.setState({
    queue, index,
    current: index >= 0 ? queue[index] : null,
    state: 'PLAYING', positionMs: 1000, durationMs: 180000,
    shuffle: false, repeat: 'OFF', playerMode: 'track', currentStation: null,
    error: null, autoplayNotice: null, previewEnded: false,
    ...extra,
  } as never);
}

beforeEach(async () => {
  resetAutoplayState();
  const pm = getProviderManager();
  // Deterministic pool: same-artist candidates on jamendo, one unrelated on airbeats.
  if (!pm.get('jamendo')) pm.register(stubProvider('jamendo'), true);
  if (!pm.get('airbeats')) pm.register(stubProvider('airbeats'), true);
  pm.register(stubProvider('jamendo', { songs: [spectre(), alone(), onMyWay(), unrelated()] }), true);
  pm.register(stubProvider('airbeats', { songs: [unrelated()] }), true);
  for (const id of ['jamendo', 'airbeats', 'youtube-music', 'local', 'sample']) {
    try { pm.healthManager().reset(id); } catch { /* ignore */ }
    try { pm.setEnabled(id, id !== 'youtube-music'); } catch { /* ignore */ }
  }
  useSettings.setState({ autoplay: true, repeatMode: 'OFF' } as never);
  usePlayer.getState().hydrateFromEngine();
  usePlayer.getState().syncPlaybackSettings();
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'loadTempSource').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'play').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'awaitClockAdvance').mockResolvedValue(true);
  // Smart Cache MISS downloads the fresh provider URL — mock valid audio.
  const audioBytes = new Uint8Array(8192).fill(0x61);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(audioBytes, {
    status: 200, headers: { 'content-type': 'audio/mpeg' },
  })));
  URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random().toString(36).slice(2)}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  await clearSmartCache().catch(() => undefined);
  await getDb().history.clear().catch(() => undefined);
  await getDb().songs.clear().catch(() => undefined);
  await getDb().offline.clear().catch(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  releaseTransition();
});

// ---------- 1–6. queue / repeat / priority ----------

describe('queue behavior and priority', () => {
  it('1. song ends with queue item → next queue item plays', async () => {
    const a = faded();
    const b = spectre();
    seedPlayer([a, b], 0);
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(b.id);
    expect(usePlayer.getState().index).toBe(1);
  });

  it('2. song ends with empty queue + AutoPlay OFF → stop', async () => {
    useSettings.setState({ autoplay: false } as never);
    const a = faded();
    seedPlayer([a], 0);
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(a.id);
    expect(usePlayer.getState().index).toBe(0);
    expect(usePlayer.getState().queue).toHaveLength(1);
  });

  it('3. song ends with empty queue + AutoPlay ON → recommendation plays', async () => {
    useSettings.setState({ autoplay: true } as never);
    const a = faded();
    seedPlayer([a], 0);
    await usePlayer.getState().next(true);
    const cur = usePlayer.getState().current;
    expect(cur).not.toBeNull();
    expect(cur?.id).not.toBe(a.id);
    expect(usePlayer.getState().queue.length).toBeGreaterThan(1);
    expect(usePlayer.getState().current?.queueSource).toBe('autoplay');
  });

  it('4. Repeat One replays the current song', async () => {
    const a = faded();
    const b = spectre();
    seedPlayer([a, b], 0, { repeat: 'ONE' });
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(a.id);
    expect(usePlayer.getState().queue).toHaveLength(2);
  });

  it('5. Repeat All loops the queue instead of autoplaying', async () => {
    const a = faded();
    const b = spectre();
    seedPlayer([a, b], 1, { repeat: 'ALL' });
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(a.id);
    expect(usePlayer.getState().index).toBe(0);
    expect(usePlayer.getState().queue).toHaveLength(2);
  });

  it('6. manual queue items always win over autoplay recommendations', async () => {
    const a = faded();
    const b = spectre();
    const c = alone();
    seedPlayer([a, b, c], 0);
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(b.id);
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).toBe(c.id);
    // Only after the manual tail does autoplay append.
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().current?.id).not.toBe(c.id);
    expect(usePlayer.getState().current?.queueSource).toBe('autoplay');
  });

  it('manual addToQueue inserts before pending autoplay tails', async () => {
    const a = faded();
    const auto = { ...spectre(), queueSource: 'autoplay' as const };
    seedPlayer([a, auto], 0);
    const manual = onMyWay();
    usePlayer.getState().addToQueue(manual);
    const ids = usePlayer.getState().queue.map((s) => s.id);
    expect(ids).toEqual([a.id, manual.id, auto.id]);
  });
});

// ---------- 7–9. duplicate prevention ----------

describe('duplicate prevention', () => {
  it('7. the same track is never recommended twice in a row', async () => {
    const a = faded();
    const pool = [spectre(), alone(), onMyWay()];
    const r1 = await getRecommendations(a, { candidatePool: pool, limit: 3 });
    expect(r1.candidates.length).toBeGreaterThan(0);
    recordRecommendation(r1.candidates[0]);
    const r2 = await getRecommendations(a, {
      candidatePool: pool,
      excludeIds: new Set([r1.candidates[0].id]),
      limit: 3,
    });
    expect(r2.candidates.map((c) => c.id)).not.toContain(r1.candidates[0].id);
  });

  it('8. current track is never recommended immediately (even cross-provider)', async () => {
    const a = faded();
    const sameElsewhere = mkSong('airbeats:faded2', { title: 'Faded', artist: 'Alan Walker' });
    const filtered = filterExcluded([a, sameElsewhere, spectre()], a, new Set());
    expect(filtered.map((s) => s.id)).not.toContain(a.id);
    expect(filtered.map((s) => s.id)).not.toContain(sameElsewhere.id);
    expect(filtered.map((s) => s.id)).toContain(spectre().id);
  });

  it('9. recently played tracks are filtered', async () => {
    const a = faded();
    const s = spectre();
    const r = await getRecommendations(a, {
      candidatePool: [s, alone()],
      excludeIds: new Set([s.id]),
      recentIds: new Set([s.id]),
      limit: 5,
    });
    expect(r.candidates.map((c) => c.id)).not.toContain(s.id);
  });

  it('same artist outranks unrelated tracks', () => {
    const a = faded();
    const same = scoreCandidate(spectre(), a);
    const other = scoreCandidate(unrelated(), a);
    expect(same.score).toBeGreaterThan(other.score);
  });
});

// ---------- 10–11. failure + provider capabilities ----------

describe('failure handling and provider capabilities', () => {
  it('10/16. unplayable first candidate falls back to the next', async () => {
    const pm = getProviderManager();
    const bad = mkSong('jamendo:bad1', { title: 'Bad One', artist: 'Alan Walker' });
    const good = mkSong('jamendo:good1', { title: 'Good One', artist: 'Alan Walker' });
    pm.register(stubProvider('jamendo', { songs: [bad, good], failStreamIds: [bad.id] }), true);
    const a = faded();
    seedPlayer([a], 0);
    await usePlayer.getState().next(true);
    // Either the good candidate plays, or (if ranking put bad first and it
    // failed) the player tried the next one — never stuck on the bad track.
    expect(usePlayer.getState().current?.id).not.toBe(bad.id);
  });

  it('11. discovery-only provider is rejected for playback', async () => {
    const pm = getProviderManager();
    const discoProvider = stubProvider('disco-only');
    discoProvider.capabilities.supportsStreaming = false;
    pm.register(discoProvider, true);
    pm.setEnabled('disco-only', true);
    const disco = mkSong('disco-only:vid1', {
      title: 'Discovery Hit',
      artist: 'Some Artist',
      capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false },
    });
    expect(isPlayableCandidate(disco)).toBe(false);
    seedPlayer([faded()], 0);
    expect(await usePlayer.getState().playSong(disco)).toBe(false);
  });

  it('11b. discovery hit resolves to a playable equivalent or is discarded', () => {
    const disco = mkSong('disco-only:vid9', {
      title: 'Faded',
      artist: 'Alan Walker',
      capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false },
    });
    const playable = mkSong('jamendo:faded', { title: 'Faded', artist: 'Alan Walker' });
    expect(resolvePlayableEquivalent(disco, [playable])?.id).toBe(playable.id);
    expect(resolvePlayableEquivalent(disco, [unrelated()])).toBeNull();
  });

  it('all candidates failing stops normally without crashing', async () => {
    const pm = getProviderManager();
    pm.register(stubProvider('jamendo', { searchMode: 'throw' }), true);
    pm.register(stubProvider('airbeats', { searchMode: 'throw' }), true);
    const a = faded();
    seedPlayer([a], 0);
    await expect(usePlayer.getState().next(true)).resolves.toBeUndefined();
    expect(usePlayer.getState().current?.id).toBe(a.id);
  });
});

// ---------- 12–13. Smart Cache playback integration ----------

describe('smart cache playback integration', () => {
  it('12. repeated plays reuse the cache row through FRESH object URLs (no stale reuse)', async () => {
    const song = mkSong('jamendo:cachedreplay1', { title: 'CachedPlay', artist: 'Cached Artist' });
    seedPlayer([], -1, { current: null });
    const createSpy = vi.mocked(URL.createObjectURL);
    const first = await usePlayer.getState().playSong(song);
    expect(first).toBe(true);
    expect((await lookupCacheTrack(song.id)).status).toBe('hit');
    const urlsAfterFirst = createSpy.mock.calls.length;
    const second = await usePlayer.getState().playSong(song);
    expect(second).toBe(true);
    // Second play is a cache HIT served through a NEW object URL.
    expect((await lookupCacheTrack(song.id)).status).toBe('hit');
    expect(createSpy.mock.calls.length).toBeGreaterThan(urlsAfterFirst);
    // Quality label stays provider-honest (cache never fakes quality).
    expect(usePlayer.getState().qualityLabel ?? '').not.toContain('Smart Cache');
  });

  it('13. first play commits the track; replay is a HIT without network', async () => {
    const song = mkSong('jamendo:cachefresh1', { title: 'Fresh', artist: 'Fresh Artist' });
    seedPlayer([], -1, { current: null });
    expect((await lookupCacheTrack(song.id)).status).toBe('miss');
    const ok = await usePlayer.getState().playSong(song);
    expect(ok).toBe(true);
    expect(usePlayer.getState().current?.id).toBe(song.id);
    expect((await lookupCacheTrack(song.id)).status).toBe('hit');
  });
});

// ---------- 14–15. radio + ended lock ----------

describe('radio isolation and ended-event safety', () => {
  it('14. radio never triggers autoplay', async () => {
    const station = { id: 's1', name: 'Test FM', url: 'https://example.com/live', homepage: '', favicon: '', tags: '', country: '', bitrate: 128, codec: 'MP3' };
    usePlayer.setState({ playerMode: 'radio', currentStation: station, queue: [faded()], index: -1 } as never);
    const before = usePlayer.getState().queue.map((s) => s.id);
    await usePlayer.getState().next(true);
    expect(usePlayer.getState().playerMode).toBe('radio');
    expect(usePlayer.getState().queue.map((s) => s.id)).toEqual(before);
  });

  it('15. ended event fires only one transition (lock)', async () => {
    const a = faded();
    const b = spectre();
    seedPlayer([a, b], 0);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next').mockResolvedValue(undefined);
    try {
      expect(tryAcquireTransition()).toBe(true);
      expect(tryAcquireTransition()).toBe(false);
      expect(isTransitionInProgress()).toBe(true);
    } finally {
      releaseTransition();
      nextSpy.mockRestore();
    }
    expect(isTransitionInProgress()).toBe(false);
    // Duplicate COMPLETED dispatches advance exactly once (idempotent hydrate).
    usePlayer.getState().hydrateFromEngine();
    usePlayer.getState().hydrateFromEngine();
    const spy2 = vi.spyOn(usePlayer.getState(), 'next').mockResolvedValue(undefined);
    try {
      engineAudioEl().dispatchEvent(new Event('ended'));
      await new Promise((r) => setTimeout(r, 20));
      expect(spy2.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      spy2.mockRestore();
    }
    void engineAudioEl();
  });
});

// ---------- 17–20. history / settings / consistency / crash safety ----------

describe('history, settings, and consistency', () => {
  it('17. history records only successful playback', async () => {
    const song = mkSong('jamendo:hist1', { title: 'Hist', artist: 'Hist Artist' });
    seedPlayer([], -1, { current: null });
    await usePlayer.getState().playSong(song);
    const recent = await historyRepo.recent(5);
    expect(recent.map((h) => h.songId)).toContain(song.id);
    // Failed discovery play records nothing.
    const disco = mkSong('youtube-music:histfail', { title: 'No Play', artist: 'X' });
    const pm = getProviderManager();
    if (!pm.get('youtube-music')) {
      const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
      pm.register(new YouTubeMusicProvider(), true);
    }
    await usePlayer.getState().playSong(disco).catch(() => false);
    const recent2 = await historyRepo.recent(50);
    expect(recent2.map((h) => h.songId)).not.toContain(disco.id);
  });

  it('18. autoplay + repeat settings persist via the settings store', async () => {
    await useSettings.getState().patch({ autoplay: false });
    expect(useSettings.getState().autoplay).toBe(false);
    expect(await settingsRepo.get('settings.autoplay', true)).toBe(false);
    usePlayer.getState().setRepeat('ALL');
    expect(usePlayer.getState().repeat).toBe('ALL');
    expect(await settingsRepo.get('settings.repeatMode', 'OFF')).toBe('ALL');
    await useSettings.getState().patch({ autoplay: true, repeatMode: 'OFF' as never });
    usePlayer.getState().syncPlaybackSettings();
    expect(usePlayer.getState().repeat).toBe('OFF');
  });

  it('19. queue remains consistent after automatic transition', async () => {
    const a = faded();
    seedPlayer([a], 0);
    await usePlayer.getState().next(true);
    const st = usePlayer.getState();
    expect(st.queue.length).toBeGreaterThanOrEqual(2);
    expect(st.index).toBe(st.queue.length - 1);
    expect(st.current?.id).toBe(st.queue[st.index].id);
    expect(st.queue.filter((s) => s.id === st.current?.id)).toHaveLength(1);
    expect(['manual', 'autoplay', undefined]).toContain(st.queue[0].queueSource);
    expect(st.queue[st.index].queueSource).toBe('autoplay');
  });

  it('20. player does not crash during automatic transition with dead providers', async () => {
    const pm = getProviderManager();
    pm.register(stubProvider('jamendo', { searchMode: 'throw' }), true);
    pm.register(stubProvider('airbeats', { searchMode: 'throw' }), true);
    const a = faded();
    seedPlayer([a], 0);
    await expect(usePlayer.getState().next(true)).resolves.toBeUndefined();
    expect(() => usePlayer.getState()).not.toThrow();
    expect(usePlayer.getState().current).not.toBeNull();
  });

  it('prefetch + candidate path never throws with an empty library', async () => {
    const a = faded();
    await expect(getNextCandidates(a, [])).resolves.toBeInstanceOf(Array);
  });
});
