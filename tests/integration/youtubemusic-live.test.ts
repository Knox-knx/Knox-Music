// REAL integration test against the bundled YouTube Music sidecar.
//
// Opt-in on purpose (needs loopback + outbound InnerTube access):
//   YOUTUBE_MUSIC_INTEGRATION_TEST=1 npm test -- tests/integration/youtubemusic-live.test.ts
//
// Covers the task's end-to-end contract: search "alan walker" through the
// actual provider stack (HTTP 200, valid JSON, provider === youtube-music,
// videoId/title/artist present), then track-detail enrichment
// (duration > 0), then the pure enrichment merge.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { clearYouTubeMusicCache } from '../../src/providers/youtubeMusic/search';
import { providerEnv } from '../../src/providers/env';
import { createEnrichmentCache, enrichSongs } from '../../src/search/enrichment';

const SCRIPT = join(__dirname, '..', '..', 'services', 'youtubemusic', 'app.py');
const LIVE = process.env.YOUTUBE_MUSIC_INTEGRATION_TEST === '1';

let child: ChildProcess | null = null;
let port = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

describe.skipIf(!LIVE)('youtube-music live integration (bundled sidecar)', () => {
  beforeAll(async () => {
    port = await freePort();
    // jsdom/undici interop: this worker's global fetch is Node's undici,
    // which rejects jsdom-constructed AbortSignals (fetchJson builds one per
    // request). Real browsers/Tauri use a single coherent DOM, so this shim
    // is test-only: strip the signal and let the request run to completion.
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const { signal: _ignored, ...rest } = init;
      return realFetch(url, rest);
    });
    // Point the provider at the test sidecar. providerEnv reads
    // import.meta.env (invisible to process.env/vi.stubEnv in this worker),
    // so override the getter directly and restore it in afterAll.
    vi.spyOn(providerEnv, 'youtubemusicBaseUrl', 'get').mockReturnValue(`http://127.0.0.1:${port}`);
    child = spawn('python3', [SCRIPT, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        ready = r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(ready).toBe(true);
    clearYouTubeMusicCache();
  }, 60000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try {
      child?.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    child = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('canonical /health and compat /api/health agree', async () => {
    for (const path of ['/health', '/api/health']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; service?: string };
      expect(body.ok).toBe(true);
      expect(body.service).toBe('knox-youtube-music');
    }
  });

  it('search "alan walker" returns genuine youtube-music results', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent('alan walker')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results?: Record<string, unknown>[] };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results!.length).toBeGreaterThan(0);
    for (const r of body.results!) {
      expect(r.provider).toBe('youtube-music');
      expect(String(r.id)).toMatch(/^youtube-music:[A-Za-z0-9_-]{6,32}$/);
      expect(String(r.title ?? '').trim().length).toBeGreaterThan(0);
      expect(String(r.artist ?? '').trim().length).toBeGreaterThan(0);
      expect(typeof r.videoId).toBe('string');
    }
  });

  it('provider searchSongs maps the live sidecar into KNOX songs', async () => {
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    const songs = await new YouTubeMusicProvider().searchSongs('alan walker');
    expect(songs.length).toBeGreaterThan(0);
    expect(songs.every((s) => s.providerId === 'youtube-music')).toBe(true);
    expect(songs[0].capabilities).toMatchObject({ streamable: false, downloadable: false, offline: false });
  });

  it('track detail enriches duration > 0 and merges without duplicates', async () => {
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    const provider = new YouTubeMusicProvider();
    const songs = await provider.searchSongs('the spectre alan walker');
    expect(songs.length).toBeGreaterThan(0);
    const target = songs[0];
    const detail = await provider.getSong(target.providerTrackId);
    expect(detail).not.toBeNull();
    expect(detail!.durationMs).toBeGreaterThan(0);
    const merged = await enrichSongs([target], {
      fetchDetail: (s) => provider.getSong(s.providerTrackId),
      cache: createEnrichmentCache(),
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(target.id);
    expect(merged[0].durationMs).toBeGreaterThan(0);
  });
});
