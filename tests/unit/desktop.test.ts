// Desktop host + local API validation (renderer side).
//
// Covers: Tauri detection, host config fallback, proxy/sidecar allowlists,
// token transport, and browser-mode null fallbacks. The Rust host has its
// own test suite (`cargo test`); these pin the renderer contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTauri, isDesktop, runtimeMode } from '../../src/desktop/detector';
import {
  getApiConfig,
  getLocalApiBase,
  getSidecarStatus,
  ensureSidecar,
  __resetHostCache,
  __setHostCache,
} from '../../src/desktop/host';
import {
  isProxyProvider,
  validateProxyTarget,
  validateSidecarPath,
  fetchHealth,
  proxyGet,
  proxyGetJson,
  sidecarGet,
} from '../../src/desktop/localApi';

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

describe('detector', () => {
  it('reports browser mode without Tauri internals', () => {
    expect(isTauri()).toBe(false);
    expect(isDesktop()).toBe(false);
    expect(runtimeMode()).toBe('browser');
  });

  it('detects the Tauri shell when internals exist', () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
    expect(isDesktop()).toBe(true);
    expect(runtimeMode()).toBe('desktop');
  });
});

describe('host bridge', () => {
  it('returns null outside the desktop shell (browser fallback)', async () => {
    expect(await getApiConfig()).toBeNull();
    expect(await getLocalApiBase()).toBeNull();
    expect(await getSidecarStatus()).toBeNull();
    expect(await ensureSidecar(true)).toBeNull();
  });

  it('derives the loopback base URL from an injected config', async () => {
    __setHostCache({ port: 41234, token: 't'.repeat(64), dataDir: '/tmp/knox', version: '1.0.0' });
    // Injected cache is returned as-is; base URL is always 127.0.0.1 (never 0.0.0.0).
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await getLocalApiBase()).toBe('http://127.0.0.1:41234');
  });
});

describe('local API validation', () => {
  it('knows exactly which providers are proxyable', () => {
    for (const p of ['jiosaavn', 'spotify', 'youtube', 'youtube-music', 'lrclib', 'radio-browser']) {
      expect(isProxyProvider(p)).toBe(true);
    }
    expect(isProxyProvider('evil')).toBe(false);
    expect(isProxyProvider('airbeats')).toBe(false);
  });

  it('rejects unknown providers', () => {
    expect(() => validateProxyTarget('evil', 'https://www.jiosaavn.com/x')).toThrow(/unknown provider/);
  });

  it('rejects non-https targets', () => {
    expect(() => validateProxyTarget('jiosaavn', 'http://www.jiosaavn.com/')).toThrow(/https/);
  });

  it('rejects wrong-host targets for a provider', () => {
    expect(() => validateProxyTarget('jiosaavn', 'https://evil.example.com/x')).toThrow(/allowlist|host/);
  });

  it('rejects path traversal attempts', () => {
    expect(() => validateProxyTarget('jiosaavn', 'https://www.jiosaavn.com/../etc/passwd')).toThrow(/traversal/);
  });

  it('rejects credentials and explicit ports', () => {
    expect(() => validateProxyTarget('jiosaavn', 'https://user:pass@www.jiosaavn.com/')).toThrow(/credentials/);
    expect(() => validateProxyTarget('jiosaavn', 'https://www.jiosaavn.com:8443/')).toThrow(/ports/);
  });

  it('rejects oversized targets', () => {
    expect(() => validateProxyTarget('jiosaavn', `https://www.jiosaavn.com/${'a'.repeat(9000)}`)).toThrow(/too long/);
  });

  it('accepts a well-formed provider URL', () => {
    expect(validateProxyTarget('jiosaavn', 'https://www.jiosaavn.com/api.php?__call=search.getResults')).toContain('jiosaavn.com');
  });

  it('restricts the sidecar gateway to the documented read API', () => {
    expect(validateSidecarPath('health')).toBe('health');
    expect(validateSidecarPath('search')).toBe('search');
    expect(validateSidecarPath('track/dQw4w9WgXcQ')).toBe('track/dQw4w9WgXcQ');
    expect(validateSidecarPath('songs/abc123')).toBe('songs/abc123');
    expect(() => validateSidecarPath('../secret')).toThrow(/rejected/);
    expect(() => validateSidecarPath('songs/..\\x')).toThrow(/rejected/);
    expect(() => validateSidecarPath('admin/restart')).toThrow(/rejected/);
    expect(() => validateSidecarPath('')).toThrow(/rejected/);
  });
});

describe('local API transport', () => {
  it('returns null outside desktop (callers use direct fetch)', async () => {
    expect(await fetchHealth()).toBeNull();
    expect(await proxyGet('jiosaavn', 'https://www.jiosaavn.com/x')).toBeNull();
    expect(await proxyGetJson('jiosaavn', 'https://www.jiosaavn.com/x')).toBeNull();
    expect(await sidecarGet('youtubemusic', 'health')).toBeNull();
  });

  it('sends the per-launch token on protected routes, never on health', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41235, token: 'secret-token', dataDir: '', version: 'test' });
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true, app: 'knox-music', version: 't', mode: 'desktop', port: 1, sidecars: {} }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      }),
    );
    const health = await fetchHealth();
    expect(health?.ok).toBe(true);
    expect(health).not.toHaveProperty('token');
    await proxyGet('jiosaavn', 'https://www.jiosaavn.com/api.php?__call=search.getResults');
    const proxied = seen.find((s) => s.url.includes('/api/proxy/jiosaavn'));
    expect(proxied?.headers['x-knox-token']).toBe('secret-token');
    const healthCall = seen.find((s) => s.url.endsWith('/api/health'));
    expect(healthCall?.headers['x-knox-token']).toBeUndefined();
  });

  it('proxy validates before sending (no request for bad targets)', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    __setHostCache({ port: 41236, token: 't', dataDir: '', version: 'test' });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(proxyGet('evil', 'https://www.jiosaavn.com/')).rejects.toThrow();
    await expect(proxyGet('jiosaavn', 'http://www.jiosaavn.com/')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
