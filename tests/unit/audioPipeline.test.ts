// Audio pipeline tests (§8 AUDIO 1–10): the element behind the UI state.
//
// Verifies the complete local chain UI → AudioEngine → HTMLAudioElement:
// source assignment, output routing (volume/mute invariants), media events,
// failure states, diagnostics, and the stall predicate. No network, no
// real audio — jsdom element behavior + mocked playUrl at the store level.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { usePlayer, isPlaybackStalled, PLAYBACK_STALL_MS } from '../../src/audio/playerStore';
import { getProviderManager } from '../../src/providers/ProviderManager';
import type { MusicProvider } from '../../src/providers/types';
import type { Song } from '../../src/core/types';

function el(): HTMLAudioElement {
  return (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio;
}

function mkSong(id: string): Song {
  const [providerId, ...rest] = id.split(':');
  return {
    id, providerId, providerTrackId: rest.join(':') || id,
    title: 'Pipeline Track', artist: 'Pipeline Artist', album: 'Pipeline Album',
    durationMs: 180000, addedAt: 0,
  } as Song;
}

function stubStreamProvider(id: string): MusicProvider {
  return {
    id, name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true,
      supportsPlaybackCache: true,
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
      mimeType: 'audio/mpeg', quality: 'MP3', allowsOffline: true,
    }),
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

beforeEach(() => {
  const pm = getProviderManager();
  if (!pm.get('jamendo')) pm.register(stubStreamProvider('jamendo'), true);
  pm.setEnabled('jamendo', true);
  try { pm.healthManager().reset('jamendo'); } catch { /* ignore */ }
  usePlayer.getState().hydrateFromEngine();
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'loadTempSource').mockResolvedValue(undefined);
  // Element-level play mock: engine.play() still calls through (so the
  // rejection tests below keep working), while temp playback resolves.
  vi.spyOn((getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio, 'play').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'awaitClockAdvance').mockResolvedValue(true);
  // Temporary Playback Buffer downloads the fresh provider URL — mock valid audio.
  const audioBytes = new Uint8Array(8192).fill(0x61);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(audioBytes, {
    status: 200, headers: { 'content-type': 'audio/mpeg' },
  })));
  URL.createObjectURL = vi.fn(() => 'blob:mock-audio') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  usePlayer.setState({ volume: 0.9, muted: false, error: null } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('audio element wiring (1–4)', () => {
  it('1/2. valid stream loads onto the element with the correct source', async () => {
    const engine = getAudioEngine();
    const loadSpy = vi.spyOn(el(), 'load').mockImplementation(() => undefined);
    try {
      await engine.load('https://example.com/track.mp3');
      expect(el().src).toContain('https://example.com/track.mp3');
      expect(engine.getDiagnostics().hasSrc).toBe(true);
      expect(engine.getDiagnostics().srcHost).toContain('example.com');
    } finally {
      loadSpy.mockRestore();
    }
  });

  it('diagnostics never leak query strings (signed URLs stay secret)', async () => {
    const engine = getAudioEngine();
    const loadSpy = vi.spyOn(el(), 'load').mockImplementation(() => undefined);
    try {
      await engine.load('https://example.com/track.mp3?token=SECRET&sig=abc');
      const d = engine.getDiagnostics();
      expect(d.srcHost).not.toContain('SECRET');
      expect(d.srcHost).not.toContain('sig=');
      expect(d.srcHost).toContain('example.com');
    } finally {
      loadSpy.mockRestore();
    }
  });

  it('3/4. output routing: volume is non-zero and element is not muted', () => {
    const engine = getAudioEngine();
    engine.setVolume(0.9);
    engine.setMuted(false);
    expect(el().volume).toBeGreaterThan(0);
    expect(el().muted).toBe(false);
    expect(engine.isAudible()).toBe(true);
    const d = engine.getDiagnostics();
    expect(d.audible).toBe(true);
    expect(d.muted).toBe(false);
    expect(d.volume).toBeGreaterThan(0);
  });

  it('playSong re-asserts store volume/mute on the element at track start', async () => {
    el().muted = true; // simulate drift: element muted behind the store's back
    usePlayer.setState({ volume: 0.8, muted: false, queue: [], index: -1, current: null } as never);
    const ok = await usePlayer.getState().playSong(mkSong('jamendo:aud1'));
    expect(ok).toBe(true);
    expect(el().muted).toBe(false);
    expect(el().volume).toBeCloseTo(0.8);
  });

  it('stuck-muted element surfaces an honest error instead of fake Playing', async () => {
    const engine = getAudioEngine();
    // Platform ignores routing writes (stuck muted) — verification must say so.
    vi.spyOn(engine, 'setMuted').mockImplementation(() => undefined);
    el().muted = true;
    usePlayer.setState({ volume: 0.8, muted: false, queue: [], index: -1, current: null } as never);
    const ok = await usePlayer.getState().playSong(mkSong('jamendo:aud2'));
    expect(ok).toBe(true); // playback itself started…
    expect(usePlayer.getState().error).toContain('Audio playback failed'); // …but silence is reported
  });
});

describe('media events (5–10)', () => {
  it('5/6. play + playing events drive state (never stuck in Preparing)', async () => {
    const engine = getAudioEngine();
    const seen: string[] = [];
    const off = engine.onState((s) => seen.push(s));
    try {
      el().dispatchEvent(new Event('play'));
      el().dispatchEvent(new Event('playing'));
      expect(seen).toContain('PLAYING');
      expect(engine.state).toBe('PLAYING');
    } finally {
      off();
    }
  });

  it('7. pause event drives PAUSED', () => {
    const engine = getAudioEngine();
    const seen: string[] = [];
    const off = engine.onState((s) => seen.push(s));
    try {
      Object.defineProperty(el(), 'ended', { value: false, configurable: true });
      el().dispatchEvent(new Event('pause'));
      expect(seen).toContain('PAUSED');
    } finally {
      off();
    }
  });

  it('8/10. error event drives ERROR (playback failure state)', () => {
    const engine = getAudioEngine();
    const seen: string[] = [];
    const off = engine.onState((s) => seen.push(s));
    try {
      el().dispatchEvent(new Event('error'));
      expect(seen).toContain('ERROR');
      expect(engine.state).toBe('ERROR');
      expect(engine.getDiagnostics().errorCode).toBeNull(); // jsdom has no MediaError — still safe
    } finally {
      off();
    }
  });

  it('9. ended event drives COMPLETED exactly once per dispatch', () => {
    const engine = getAudioEngine();
    let count = 0;
    const off = engine.onState((s) => { if (s === 'COMPLETED') count += 1; });
    try {
      el().dispatchEvent(new Event('ended'));
      expect(count).toBe(1);
    } finally {
      off();
    }
  });

  it('10. play() rejection drives ERROR and throws to the caller', async () => {
    const engine = getAudioEngine();
    const playSpy = vi.spyOn(el(), 'play').mockRejectedValueOnce(new DOMException('NotAllowed', 'NotAllowedError'));
    try {
      await expect(engine.play()).rejects.toThrow();
      expect(engine.state).toBe('ERROR');
    } finally {
      playSpy.mockRestore();
    }
  });

  it('resume failure surfaces a useful error instead of silence', async () => {
    const engine = getAudioEngine();
    const playSpy = vi.spyOn(el(), 'play').mockRejectedValueOnce(new DOMException('nope', 'NotAllowedError'));
    usePlayer.setState({ state: 'PAUSED' } as never);
    try {
      await usePlayer.getState().toggle();
      expect(usePlayer.getState().error).toContain('Audio playback failed');
    } finally {
      playSpy.mockRestore();
    }
  });
});

describe('stall detection', () => {
  it('flags PLAYING-with-frozen-clock only after the threshold', () => {
    const now = 1_000_000;
    expect(isPlaybackStalled(now - 1000, now)).toBe(false);
    expect(isPlaybackStalled(now - PLAYBACK_STALL_MS, now)).toBe(false);
    expect(isPlaybackStalled(now - PLAYBACK_STALL_MS - 1, now)).toBe(true);
  });

  it('diagnostics snapshot stays safe before any source loads', () => {
    const d = getAudioEngine().getDiagnostics();
    expect(typeof d.readyState).toBe('number');
    expect(typeof d.networkState).toBe('number');
    expect(typeof d.paused).toBe('boolean');
    expect(typeof d.playbackRate).toBe('number');
    expect(d.playbackRate).toBeGreaterThan(0);
  });
});
