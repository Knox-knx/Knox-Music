// YouTube Music provider tests: mapping, validation, discovery-only honesty,
// provider isolation, cache, lifecycle. All mocked — never live YouTube.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  YouTubeMusicProvider,
  mapYouTubeMusicTrack,
  mapYouTubeMusicArtist,
  mapYouTubeMusicAlbum,
  videoIdFromQualified,
} from '../../src/providers/youtubeMusic/provider';
import { clearYouTubeMusicCache } from '../../src/providers/youtubeMusic/search';
import { __resetHostCache, __setHostCache } from '../../src/desktop/host';
import { DEFAULT_SETTINGS } from '../../src/settings/settingsStore';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const YT_TRACK = {
  id: 'youtube-music:dQw4w9WgXcQ',
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  album: 'Whenever You Need Somebody',
  duration: 214,
  artwork: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  year: 1987,
  videoId: 'dQw4w9WgXcQ',
  provider: 'youtube-music',
};

beforeEach(() => {
  clearYouTubeMusicCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearYouTubeMusicCache();
});

describe('provider initialization', () => {
  it('registers as youtube-music, enabled by default in settings', () => {
    const p = new YouTubeMusicProvider();
    expect(p.id).toBe('youtube-music');
    expect(p.name).toBe('YouTube Music');
    expect(DEFAULT_SETTINGS.providersEnabled['youtube-music']).toBe(true);
  });

  it('declares in-app server capabilities (stream/download/offline enabled)', () => {
    const p = new YouTubeMusicProvider();
    expect(p.capabilities.supportsSearch).toBe(true);
    expect(p.capabilities.supportsStreaming).toBe(true);
    expect(p.capabilities.supportsOffline).toBe(true);
    expect(p.capabilities.supportsDownloads).toBe(true);
    expect(p.capabilities.supportsArtwork).toBe(true);
  });
});

describe('query validation', () => {
  it('returns [] for empty queries without network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new YouTubeMusicProvider().searchSongs('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects over-long queries (max 256)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new YouTubeMusicProvider().searchSongs('a'.repeat(257))).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('search mapping', () => {
  it('maps songs with provider-qualified ids and full metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      expect(String(u)).toContain('127.0.0.1');
      expect(String(u)).toContain('/api/search?q=');
      return jsonResponse({ results: [YT_TRACK] });
    }));
    const songs = await new YouTubeMusicProvider().searchSongs('never gonna');
    expect(songs).toHaveLength(1);
    const s = songs[0];
    expect(s.id).toBe('youtube-music:dQw4w9WgXcQ');
    expect(s.providerId).toBe('youtube-music');
    expect(s.providerTrackId).toBe('dQw4w9WgXcQ');
    expect(s.title).toBe('Never Gonna Give You Up');
    expect(s.artist).toBe('Rick Astley');
    expect(s.album).toBe('Whenever You Need Somebody');
    expect(s.durationMs).toBe(214000);
    expect(s.artworkUrl).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(s.year).toBe(1987);
  });

  it('maps artists, albums, durations, artwork', () => {
    const s = mapYouTubeMusicTrack(YT_TRACK)!;
    expect(s.durationMs).toBe(214000);
    expect(s.artworkUrl).toContain('ytimg.com');
    expect(mapYouTubeMusicArtist({ id: 'youtube-music:artist:UCxxx', name: 'Rick Astley' })?.providerId).toBe('youtube-music');
    expect(mapYouTubeMusicAlbum({ id: 'youtube-music:album:OLxxx', title: 'Whenever You Need Somebody' })?.title).toBe('Whenever You Need Somebody');
  });

  it('uses provider-qualified ids, never raw video ids', () => {
    const s = mapYouTubeMusicTrack({ ...YT_TRACK, id: 'dQw4w9WgXcQ' })!;
    expect(s.id).toBe('youtube-music:dQw4w9WgXcQ');
    expect(videoIdFromQualified('youtube-music:dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('returns null for unaddressable records, never throws on drift', () => {
    expect(mapYouTubeMusicTrack({} as never)).toBeNull();
    expect(mapYouTubeMusicTrack({ title: 'x' } as never)).toBeNull();
    expect(mapYouTubeMusicTrack({ id: 'youtube-music:abc123' })?.title).toBe('Untitled');
  });

  it('tolerates malformed upstream shapes (empty, never crash)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ unexpected: true })));
    expect(await new YouTubeMusicProvider().searchSongs('rick')).toEqual([]);
  });

  it('derives artist/album views from song results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [YT_TRACK] })));
    const p = new YouTubeMusicProvider();
    const artists = await p.searchArtists('rick astley');
    expect(artists.length).toBeGreaterThanOrEqual(1);
    expect(artists[0].providerId).toBe('youtube-music');
    expect(await p.searchPlaylists()).toEqual([]);
  });

  it('deduplicates identical video ids from repeated searches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [YT_TRACK, YT_TRACK] })));
    const { dedupeSongs } = await import('../../src/search/dedupe');
    const p = new YouTubeMusicProvider();
    const songs = await p.searchSongs('rick');
    expect(dedupeSongs(songs)).toHaveLength(1);
  });
});

describe('in-app server capabilities', () => {
  it('marks tracks playable and downloadable via in-app audio server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [YT_TRACK] })));
    const [s] = await new YouTubeMusicProvider().searchSongs('rick');
    expect(s.streamUrl).toBeUndefined();
    expect(s.downloadAllowed).toBe(true);
    expect(s.capabilities).toMatchObject({ streamable: true, downloadable: true, offline: true });
  });

  it('getStream rejects with NETWORK when the audio server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    const p = new YouTubeMusicProvider();
    await expect(p.getStream({
      id: 'youtube-music:dQw4w9WgXcQ', providerId: 'youtube-music', providerTrackId: 'dQw4w9WgXcQ',
      title: 'T', artist: 'A', album: '', durationMs: 0, addedAt: 0,
    })).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('canDownload/getArtwork/getLyrics resolve as expected', async () => {
    const p = new YouTubeMusicProvider();
    expect(await p.canDownload()).toBe(true);
    expect(await p.getLyrics()).toBeNull();
    expect(await p.getArtwork({
      id: 'youtube-music:dQw4w9WgXcQ', providerId: 'youtube-music', providerTrackId: 'dQw4w9WgXcQ',
      title: 'T', artist: 'A', album: '', durationMs: 0, addedAt: 0, artworkUrl: 'https://img/x.jpg',
    })).toBe('https://img/x.jpg');
  });
});

describe('resilience', () => {
  it('reports honest unavailability when the sidecar is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    const p = new YouTubeMusicProvider();
    await expect(p.searchSongs('rick')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(await p.checkHealth()).toBe(false);
  });

  it('checkHealth is true when the sidecar answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    expect(await new YouTubeMusicProvider().checkHealth()).toBe(true);
  });

  it('maps sidecar TIMEOUT and RATE_LIMITED to provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'TIMEOUT', message: 'timed out' } })));
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'TIMEOUT' });
    clearYouTubeMusicCache();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { code: 'RATE_LIMITED', message: 'slow down' } })));
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('honours cancellation (aborted searches resolve empty, never stale)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [YT_TRACK] })));
    const c = new AbortController();
    c.abort();
    expect(await new YouTubeMusicProvider().searchSongs('rick', c.signal)).toEqual([]);
  });

  it('caches repeat searches within TTL (one network hit)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [YT_TRACK] }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new YouTubeMusicProvider();
    expect(await p.searchSongs('rick astley')).toHaveLength(1);
    expect(await p.searchSongs('rick astley')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent different queries never share stale results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const q = new URL(String(url)).searchParams.get('q') ?? '';
      const vid = q.includes('walker') ? 'lNM9HlEK4q4' : 'dQw4w9WgXcQ';
      return jsonResponse({ results: [{ ...YT_TRACK, id: `youtube-music:${vid}`, videoId: vid }] });
    }));
    const p = new YouTubeMusicProvider();
    const [a, b] = await Promise.all([p.searchSongs('alan walker'), p.searchSongs('rick astley')]);
    expect(a[0]?.providerTrackId).toBe('lNM9HlEK4q4');
    expect(b[0]?.providerTrackId).toBe('dQw4w9WgXcQ');
  });

  it('provider isolation: failure never breaks other providers', async () => {
    const { ProviderManager } = await import('../../src/providers/ProviderManager');
    const pm = new ProviderManager(5000);
    const good = {
      id: 'good', name: 'Good',
      capabilities: { supportsSearch: true, supportsStreaming: true, supportsOffline: false, supportsLyrics: false, supportsArtwork: false, supportsArtists: false, supportsAlbums: false },
      searchSongs: async () => [{ id: 'good:1', providerId: 'good', providerTrackId: '1', title: 'Ok', artist: 'A', album: '', durationMs: 1, addedAt: 0 }],
      searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
      getSong: async () => null, getArtist: async () => null, getAlbum: async () => null, getPlaylist: async () => null,
      getAlbumTracks: async () => [], getStream: async () => { throw new Error('x'); },
      getArtwork: async () => null, getLyrics: async () => null,
    };
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('yt down'); }));
    pm.register(good as never, true);
    pm.register(new YouTubeMusicProvider(), true);
    const r = await pm.searchAll('rick', 'songs');
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.failures).toContain('youtube-music');
  });

  it('getSong rejects traversal ids without network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ track: null }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new YouTubeMusicProvider();
    expect(await p.getSong('../etc/passwd')).toBeNull();
    expect(await p.getSong('a/b')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Opt-in live integration: NEVER runs in normal CI (no network dependency).
// Enable explicitly: YOUTUBE_MUSIC_INTEGRATION_TEST=1 npm test
const LIVE = process.env.YOUTUBE_MUSIC_INTEGRATION_TEST === '1';
describe.skipIf(!LIVE)('youtube-music live integration (opt-in)', () => {
  it('returns real YouTube Music metadata through the loopback sidecar', async () => {
    const { spawn } = await import('node:child_process');
    const { join } = await import('node:path');
    const net = (await import('node:net')).default;
    const script = join(__dirname, '..', '..', 'services', 'youtubemusic', 'app.py');
    const port = await new Promise<number>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
      });
    });
    const child = spawn('python3', [script, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          ready = r.ok;
        } catch { await new Promise((r) => setTimeout(r, 150)); }
      }
      expect(ready).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('alan walker')}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results?: { id?: string; title?: string; artist?: string }[] };
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results!.length).toBeGreaterThan(0);
      for (const r of body.results!) {
        expect(r.id).toMatch(/^youtube-music:[A-Za-z0-9_-]{6,32}$/);
        expect(r.title?.trim().length).toBeGreaterThan(0);
      }
    } finally {
      child.kill('SIGTERM');
    }
  }, 60000);
});

// Desktop gateway path (packaged AppImage): the renderer reaches the sidecar
// through the KNOX gateway (`/api/sidecar/youtubemusic/...` + token), never
// through a hardcoded sidecar port. Regression coverage for the production
// bug where the gateway faithfully forwarded the sidecar's structured
// `{error: {code}}` body with a non-2xx status (e.g. 504 after an InnerTube
// stall) and the renderer DISCARDED that body, misreporting every transient
// stall as NETWORK "YouTube Music is currently unavailable."
describe('desktop gateway structured errors (packaged AppImage path)', () => {
  const GW_PORT = 45678;
  const GW_TOKEN = 'gw-test-token';

  function gatewayShell() {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: GW_PORT, token: GW_TOKEN, dataDir: '', version: 'test' });
  }

  /** fetch mock: gateway URL → responder; direct :5000 fallback is always dead. */
  function mockGateway(respond: (url: string) => Response | Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async (u: unknown, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith(`http://127.0.0.1:${GW_PORT}/api/sidecar/youtubemusic/`)) {
        expect((init?.headers as Record<string, string> | undefined)?.['x-knox-token']).toBe(GW_TOKEN);
        return respond(url);
      }
      throw new Error('connection refused');
    }));
  }

  beforeEach(() => {
    gatewayShell();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    __resetHostCache();
  });

  it('uses the dynamic gateway URL (never a hardcoded sidecar port)', async () => {
    mockGateway((url) => {
      expect(url).toContain('/api/sidecar/youtubemusic/search?q=');
      expect(url).not.toContain('127.0.0.1:5000');
      return jsonResponse({ results: [YT_TRACK] });
    });
    const songs = await new YouTubeMusicProvider().searchSongs('never gonna');
    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe('youtube-music:dQw4w9WgXcQ');
  });

  it('gateway 504 structured TIMEOUT maps to TIMEOUT, not NETWORK', async () => {
    mockGateway((url) => {
      if (url.includes('/api/sidecar/youtubemusic/health')) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: 'TIMEOUT', message: 'YouTube Music search timed out.' } }, 504);
    });
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('gateway 429 structured RATE_LIMITED maps to RATE_LIMIT', async () => {
    mockGateway(() => jsonResponse({ error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429));
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('gateway 502 with a non-structured body stays NETWORK (sidecar genuinely down)', async () => {
    mockGateway(() => new Response('sidecar unavailable', { status: 502 }));
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'NETWORK' });
    expect(await new YouTubeMusicProvider().checkHealth()).toBe(false);
  });

  it('health probe succeeds through the gateway', async () => {
    mockGateway((url) => {
      expect(url).toContain('/api/sidecar/youtubemusic/health');
      return jsonResponse({ ok: true, service: 'knox-youtube-music' });
    });
    expect(await new YouTubeMusicProvider().checkHealth()).toBe(true);
  });

  it('empty results through the gateway are fine (no failure)', async () => {
    mockGateway(() => jsonResponse({ results: [] }));
    expect(await new YouTubeMusicProvider().searchSongs('zzz-no-such-song')).toEqual([]);
  });

  it('a structured failure does not poison the next retry', async () => {
    let calls = 0;
    mockGateway(() => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: { code: 'TIMEOUT', message: 'stall' } }, 504);
      return jsonResponse({ results: [YT_TRACK] });
    });
    await expect(new YouTubeMusicProvider().searchSongs('rick')).rejects.toMatchObject({ code: 'TIMEOUT' });
    clearYouTubeMusicCache();
    const songs = await new YouTubeMusicProvider().searchSongs('rick');
    expect(songs).toHaveLength(1);
  });

  it('gateway 404 NOT_FOUND on track resolves null (detail path)', async () => {
    mockGateway(() => jsonResponse({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));
    expect(await new YouTubeMusicProvider().getSong('dQw4w9WgXcQ')).toBeNull();
  });
});
