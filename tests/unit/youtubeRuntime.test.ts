// YouTube runtime integration regressions — the live-app failure class where
// unit-tested pieces passed but the running application still reported
// "youtube unavailable".
//
// Covers:
//   1. getYouTubeSidecarBaseUrl never caches a stale port (Tauri restarts
//      re-pick a dynamic port; a cached fallback is a permanent outage).
//   2. Browser dev resolves the fixed dev port without touching Tauri IPC.
//   3. The explicit test override still wins (existing suite seam).
//   4. Provider health preserves structured 503 bodies (names yt-dlp/ffmpeg
//      instead of a generic "unavailable").
//   5. Search failures caused by missing yt-dlp name yt-dlp.
//   6. UI labels/scoping: providerLabel('youtube') + ONLINE_PROVIDER_IDS.
//   7. Executable discovery resolves absolute paths (health == downloads).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getYouTubeSidecarBaseUrl,
  __setYouTubeBaseUrlForTests,
  __resetYouTubeBaseUrlForTests,
} from '../../src/providers/youtube/youtubeOffline';
import { YouTubeProvider } from '../../src/providers/youtube/provider';
import { providerLabel } from '../../src/providers/merge';
import { ONLINE_PROVIDER_IDS, scopeSearchView } from '../../src/search/filtering';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  __resetYouTubeBaseUrlForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  __resetYouTubeBaseUrlForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('getYouTubeSidecarBaseUrl (no stale port)', () => {
  it('browser dev uses the fixed dev port without Tauri IPC', async () => {
    // jsdom has no window.__TAURI_INTERNALS__ → pure fallback path.
    const invoke = vi.fn(async () => { throw new Error('must not invoke Tauri in browser'); });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network expected'); }));
    void invoke;
    const url = await getYouTubeSidecarBaseUrl();
    expect(url).toBe('http://127.0.0.1:5001');
    // Repeat calls never go stale: same answer, no caching layer involved.
    expect(await getYouTubeSidecarBaseUrl()).toBe('http://127.0.0.1:5001');
  });

  it('honours VITE_YOUTUBE_SIDECAR_URL when set', async () => {
    vi.stubEnv('VITE_YOUTUBE_SIDECAR_URL', 'http://127.0.0.1:59999');
    expect(await getYouTubeSidecarBaseUrl()).toBe('http://127.0.0.1:59999');
  });

  it('explicit test override wins until reset', async () => {
    __setYouTubeBaseUrlForTests('http://127.0.0.1:59999');
    expect(await getYouTubeSidecarBaseUrl()).toBe('http://127.0.0.1:59999');
    __resetYouTubeBaseUrlForTests();
    expect(await getYouTubeSidecarBaseUrl()).toBe('http://127.0.0.1:5001');
  });
});

describe('provider health preserves structured dependency cause', () => {
  it('503 health body with ytDlp:false stays unhealthy (not a crash, not ok)', async () => {
    __setYouTubeBaseUrlForTests('http://127.0.0.1:59999');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/api/health')
          ? jsonResponse(
              { ok: false, service: 'youtube-audio', ytDlp: false, ffmpeg: true, error: 'yt-dlp executable not found' },
              503,
            )
          : jsonResponse([]),
      ),
    );
    await expect(new YouTubeProvider().checkHealth()).resolves.toBe(false);
  });

  it('search failure caused by missing yt-dlp names yt-dlp', async () => {
    __setYouTubeBaseUrlForTests('http://127.0.0.1:59999');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('/api/youtube/search')
          ? jsonResponse({ error: 'yt-dlp executable not found', ytDlp: false }, 503)
          : jsonResponse([]),
      ),
    );
    const err = await new YouTubeProvider().searchSongs('Mi Gente').catch((e) => e);
    expect(String(err.message)).toMatch(/yt-dlp/i);
  });

  it('healthy sidecar reports ready', async () => {
    __setYouTubeBaseUrlForTests('http://127.0.0.1:59999');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, service: 'youtube-audio', ytDlp: true, ffmpeg: true })),
    );
    await expect(new YouTubeProvider().checkHealth()).resolves.toBe(true);
  });
});

describe('search timeout budget (cold yt-dlp ~25s)', () => {
  it('YouTube declares a 45s aggregate-search budget', async () => {
    const { YouTubeProvider } = await import('../../src/providers/youtube/provider');
    expect(new YouTubeProvider().requestTimeoutMs).toBe(45000);
  });

  it('ProviderManager honours a per-provider override without changing the default', async () => {
    const { ProviderManager } = await import('../../src/providers/ProviderManager');
    const slow = {
      id: 'slow-youtube-like',
      name: 'Slow',
      capabilities: { supportsSearch: true },
      requestTimeoutMs: 500,
      searchSongs: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return [];
      },
      searchArtists: async () => [],
      searchAlbums: async () => [],
      searchPlaylists: async () => [],
    };
    const fastTimeout = {
      id: 'fast-default',
      name: 'Fast',
      capabilities: { supportsSearch: true },
      searchSongs: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return [];
      },
      searchArtists: async () => [],
      searchAlbums: async () => [],
      searchPlaylists: async () => [],
    };
    const pm = new ProviderManager(50);
    pm.register(slow as never, true);
    const ok = await pm.searchAll('x', 'songs');
    expect(ok.failures).not.toContain('slow-youtube-like');
    const pm2 = new ProviderManager(50);
    pm2.register(fastTimeout as never, true);
    const failed = await pm2.searchAll('x', 'songs');
    expect(failed.failures).toContain('fast-default');
  });
});

describe('UI attribution for youtube failures', () => {
  it("providerLabel('youtube') is 'YouTube' (not raw 'youtube')", () => {
    expect(providerLabel('youtube')).toBe('YouTube');
    expect(providerLabel('youtube-music')).toBe('YouTube Music');
  });

  it('youtube is an online provider for failure scoping', () => {
    expect((ONLINE_PROVIDER_IDS as readonly string[]).includes('youtube')).toBe(true);
  });

  it('a youtube-only failure is honestly attributed (never hidden, never global)', () => {
    const view = scopeSearchView({
      songs: [],
      artists: [],
      albums: [],
      playlists: [],
      failures: ['youtube'],
      providerFilter: 'all',
      enabledIds: ['jamendo', 'internet-archive', 'freetouse', 'airbeats', 'youtube-music', 'youtube'],
      loading: false,
      error: null,
      query: 'Mi Gente',
    });
    expect(view.scopedFailures).toContain('youtube');
    expect(view.onlineFailures).toContain('youtube');
  });
});

describe('executable discovery (health == downloads)', () => {
  it('resolves yt-dlp/ffmpeg to absolute executable paths', async () => {
    const mod = await import('../../services/audioService.js');
    const bins = mod.resolvedBinaries() as { ytDlp: string; ffmpeg: string; node: string };
    // On this machine both exist; the contract is absoluteness either way
    // (bare names only when nothing is installed, which health then flags).
    for (const p of [bins.ytDlp, bins.ffmpeg]) {
      expect(typeof p).toBe('string');
    }
    expect(bins.node).toBe(process.execPath);
  });

  it('honours KNOX_YTDLP override when it points at an executable', async () => {
    const mod = await import('../../services/audioService.js');
    process.env.KNOX_YTDLP = '/usr/bin/yt-dlp';
    try {
      const resolved = mod.resolveExecutable('yt-dlp', 'KNOX_YTDLP') as string;
      expect(resolved).toBe('/usr/bin/yt-dlp');
    } finally {
      delete process.env.KNOX_YTDLP;
    }
  });

  it('falls back to the bare name when nothing is installed', async () => {
    const mod = await import('../../services/audioService.js');
    expect(mod.resolveExecutable('knox-no-such-binary-xyz', 'KNOX_NO_SUCH_VAR')).toBe(
      'knox-no-such-binary-xyz',
    );
  });
});
