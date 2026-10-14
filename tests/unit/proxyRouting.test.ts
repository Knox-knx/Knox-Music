// Provider HTTP routing: desktop proxy first, direct fallback.
//
// fetchJson keeps its exact browser behavior (direct fetch with timeout +
// retries). In the desktop shell, routable provider URLs go through the
// local KNOX egress proxy first; any proxy failure falls back to direct.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJson } from '../../src/providers/http';
import { __resetHostCache, __setHostCache } from '../../src/desktop/host';

beforeEach(() => {
  __resetHostCache();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  __resetHostCache();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchJson browser path (unchanged)', () => {
  it('fetches directly with no host present', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://www.jiosaavn.com/api.php?__call=search.getResults');
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const data = await fetchJson<{ ok: boolean }>('https://www.jiosaavn.com/api.php?__call=search.getResults');
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('fetchJson desktop proxy path', () => {
  it('routes routable provider URLs through the local proxy with the token', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41237, token: 'proxy-token', dataDir: '', version: 'test' });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        return new Response(JSON.stringify({ proxied: true }), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const data = await fetchJson<{ proxied: boolean }>('https://www.jiosaavn.com/api.php?__call=search.getResults');
    expect(data).toEqual({ proxied: true });
    // Exactly one request — and it went to the loopback proxy, not JioSaavn directly.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('http://127.0.0.1:41237/api/proxy/jiosaavn?target=');
    expect(calls[0].headers['x-knox-token']).toBe('proxy-token');
  });

  it('falls back to direct fetch when the proxy is unreachable', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41238, token: 't', dataDir: '', version: 'test' });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/api/proxy/')) throw new TypeError('proxy down');
        return new Response(JSON.stringify({ direct: true }), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const data = await fetchJson<{ direct: boolean }>('https://www.jiosaavn.com/api.php?__call=search.getResults');
    expect(data).toEqual({ direct: true });
    expect(calls.some((u) => u.includes('/api/proxy/'))).toBe(true);
    expect(calls.some((u) => u.startsWith('https://www.jiosaavn.com'))).toBe(true);
  });

  it('never proxies non-provider hosts (direct only)', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41239, token: 't', dataDir: '', version: 'test' });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
      }),
    );
    await fetchJson<unknown>('https://cdn.example.com/audio.mp3');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://cdn.example.com/audio.mp3');
  });
});

describe('youtubemusic gateway routing', () => {
  it('rejects traversal track ids without any network', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    expect(await new YouTubeMusicProvider().getSong('../etc/passwd')).toBeNull();
    expect(await new YouTubeMusicProvider().getSong('a/b')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the desktop gateway when hosted, direct URL otherwise', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41240, token: 'gw-token', dataDir: '', version: 'test' });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        return new Response(JSON.stringify({ ok: true, service: 'knox-youtube-music' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    expect(await new YouTubeMusicProvider().checkHealth()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:41240/api/sidecar/youtubemusic/health');
    expect(calls[0].headers['x-knox-token']).toBe('gw-token');
  });
});
