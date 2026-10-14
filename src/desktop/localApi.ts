// Local KNOX HTTP API client — renderer side.
//
// Transport for operations that benefit from a stable app API (provider
// egress proxy, sidecar gateway, config, logs). Desktop-only internal ops
// that need no HTTP stay on Tauri IPC (see host.ts).
//
// Security: every protected route carries the per-launch token
// (`X-Knox-Token`, memory-only). Health is open by design (no secrets in
// it). Requests are size/time bounded; targets are allowlisted per
// provider by the server — this client additionally validates shapes so
// programming errors fail fast in the renderer.

import { getApiConfig } from './host';
import { isTauri } from './detector';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Dynamic import keeps the browser/PWA bundle working without Tauri.
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/** Invoke with a time bound (Tauri IPC has no built-in timeout). */
async function invokeBounded<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      invoke<T>(cmd, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${cmd} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const TOKEN_HEADER = 'x-knox-token';
export const LOCAL_API_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Providers the local egress proxy serves (mirrors the Rust allowlist). */
export const PROXY_PROVIDERS = new Set([
  'jiosaavn',
  'spotify',
  'youtube',
  'youtube-music',
  'lrclib',
  'radio-browser',
]);

export function isProxyProvider(id: string): boolean {
  return PROXY_PROVIDERS.has(id);
}

/** Exact hosts per provider; radio-browser allows its regional subdomains. */
function allowedHost(provider: string, host: string): boolean {
  switch (provider) {
    case 'jiosaavn':
      return host === 'www.jiosaavn.com' || host === 'jiosaavn.com' || host.endsWith('.saavncdn.com');
    case 'spotify':
      return host === 'api.spotify.com' || host === 'open.spotify.com';
    case 'youtube':
      return host === 'www.youtube.com' || host === 'youtube.com';
    case 'youtube-music':
      return host === 'music.youtube.com';
    case 'lrclib':
      return host === 'lrclib.net';
    case 'radio-browser':
      return host === 'api.radio-browser.info' || host.endsWith('.api.radio-browser.info');
    default:
      return false;
  }
}

export function validateProxyTarget(provider: string, target: string): string {
  if (!isProxyProvider(provider)) throw new Error(`unknown provider: ${provider}`);
  if (typeof target !== 'string' || !target) throw new Error('target must be a non-empty URL');
  if (target.length > 8192) throw new Error('target too long');
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('invalid target url');
  }
  if (url.protocol !== 'https:') throw new Error('target must be https');
  if (url.username || url.password) throw new Error('credentials in url are forbidden');
  if (url.port) throw new Error('explicit ports are forbidden');
  if (!allowedHost(provider, url.hostname.toLowerCase())) {
    throw new Error('target host not allowlisted for provider');
  }
  if (target.includes('/../') || target.includes('/..?') || target.includes('/..#')) {
    throw new Error('path traversal rejected');
  }
  return target;
}

/** Sidecar gateway paths the server proxies (mirrors the Rust allowlist). */
export function validateSidecarPath(path: string): string {
  const clean = (path ?? '').replace(/^\/+/, '');
  const allowed =
    clean === 'health' ||
    clean === 'search' ||
    clean.startsWith('search/') ||
    clean.startsWith('songs/') ||
    clean.startsWith('track/') ||
    clean.startsWith('artist/') ||
    clean.startsWith('album/') ||
    clean.startsWith('playlist/');
  if (!allowed || clean.includes('..') || clean.includes('\\')) {
    throw new Error('sidecar path rejected');
  }
  if (clean.length > 512) throw new Error('sidecar path too long');
  return clean;
}

interface LocalApi {
  base: string;
  token: string;
}

async function ctx(signal?: AbortSignal): Promise<(LocalApi | null)> {
  const cfg = await getApiConfig();
  if (!cfg) return null;
  void signal;
  return { base: `http://127.0.0.1:${cfg.port}`, token: cfg.token };
}

async function readBounded(res: Response): Promise<Response> {
  // Guard against unbounded provider payloads reaching the renderer.
  const len = Number(res.headers.get('content-length') || '0');
  if (len > MAX_BODY_BYTES) throw new Error('upstream body too large');
  return res;
}

async function authed(path: string, init?: RequestInit, timeoutMs = LOCAL_API_TIMEOUT_MS): Promise<Response | null> {
  const c = await ctx();
  if (!c) return null; // not in desktop shell — caller falls back
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...(init?.headers as Record<string, string> | undefined), [TOKEN_HEADER]: c.token },
    });
    return await readBounded(res);
  } finally {
    clearTimeout(timer);
  }
}

export interface HealthInfo {
  ok: boolean;
  app: string;
  version: string;
  mode: string;
  port: number;
  sidecars: Record<string, string>;
}

/** Open health probe — no token (contains no secrets). Null outside desktop. */
export async function fetchHealth(): Promise<HealthInfo | null> {
  // IPC first: the WebView cannot always open a loopback socket (mobile
  // WebViews block https-page → http-127.0.0.1 as mixed content).
  if (isTauri()) {
    try {
      return await invokeBounded<HealthInfo>('knox_health', {}, 8000);
    } catch { /* fall through to the loopback probe */ }
  }
  const c = await ctx();
  if (!c) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${c.base}/api/health`, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider egress proxy: renderer → local KNOX API → provider.
 * Fixes browser CORS, centralizes timeout/logging server-side.
 *
 * Transport order under Tauri: IPC command first (no socket from the page —
 * mobile WebViews block https-page → http-127.0.0.1 as mixed content), then
 * the loopback HTTP route (desktop shells where it is reachable).
 * Returns null outside the desktop shell (caller uses direct fetch).
 */
export async function proxyGet(provider: string, target: string, timeoutMs = 20000): Promise<Response | null> {
  validateProxyTarget(provider, target);
  if (isTauri()) {
    try {
      const r = await invokeBounded<{ status: number; contentType: string; body: string }>(
        'knox_proxy_get',
        { provider, target },
        timeoutMs,
      );
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': r.contentType || 'application/json' },
      });
    } catch { /* fall through to the loopback route */ }
  }
  const url = `/api/proxy/${encodeURIComponent(provider)}?target=${encodeURIComponent(target)}`;
  return authed(url, { method: 'GET' }, timeoutMs);
}

/** Same as proxyGet but parses JSON. Null outside desktop. */
export async function proxyGetJson<T>(provider: string, target: string, timeoutMs = 20000): Promise<T | null> {
  const res = await proxyGet(provider, target, timeoutMs);
  if (!res) return null;
  if (!res.ok) {
    const err = new Error(`proxy ${provider} failed (HTTP ${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Sidecar gateway: renderer → local KNOX API → sidecar.
 * Only the documented read API (health/search/track/artist/album/songs) is
 * reachable. Returns null outside desktop (caller uses the direct sidecar URL).
 */
export async function sidecarGet(sidecar: string, path: string, query = '', timeoutMs = 20000): Promise<Response | null> {
  const name = (sidecar ?? '').trim().toLowerCase();
  if (name !== 'youtubemusic' && name !== 'youtube-music') throw new Error('unknown sidecar');
  const clean = validateSidecarPath(path);
  if (query.length > 4096) throw new Error('query too long');
  const route = name === 'youtube-music' ? 'youtubemusic' : name;
  return authed(`/api/sidecar/${route}/${clean}${query}`, { method: 'GET' }, timeoutMs);
}

/** Sidecar gateway + JSON. Null outside desktop. */
export async function sidecarGetJson<T>(sidecar: string, path: string, query = '', timeoutMs = 20000): Promise<T | null> {
  const res = await sidecarGet(sidecar, path, query, timeoutMs);
  if (!res) return null;
  if (!res.ok) throw await toSidecarError(res);
  return (await res.json()) as T;
}

/**
 * Structured upstream error carried from the sidecar through the gateway.
 *
 * The gateway forwards the sidecar's HTTP status AND its
 * `{error: {code, message}}` JSON body (e.g. 504 TIMEOUT after an InnerTube
 * stall, 429 RATE_LIMITED, 404 NOT_FOUND). Callers that understand the
 * sidecar schema (YouTube Music provider) must receive that body so they
 * can map it honestly — collapsing it into a generic NETWORK error is what
 * used to paint every transient upstream stall as "provider unavailable".
 */
export class SidecarUpstreamError extends Error {
  readonly code: string;
  readonly status: number;
  /** The sidecar's `{error: ...}` payload (safe to surface to mappers). */
  readonly body: { error: { code: string; message?: string } };
  constructor(status: number, body: { error: { code: string; message?: string } }) {
    super(`sidecar upstream failed (${body.error.code}, HTTP ${status})`);
    this.name = 'SidecarUpstreamError';
    this.code = body.error.code;
    this.status = status;
    this.body = body;
  }
}

export function isSidecarUpstreamError(e: unknown): e is SidecarUpstreamError {
  return e instanceof SidecarUpstreamError;
}

/** True for the sidecar's documented `{error: {code, ...}}` shape only. */
function asStructuredErrorBody(value: unknown): { error: { code: string; message?: string } } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const err = (value as { error?: unknown }).error;
  if (!err || typeof err !== 'object' || Array.isArray(err)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !code) return null;
  const message = (err as { message?: unknown }).message;
  return { error: { code, ...(typeof message === 'string' ? { message } : {}) } };
}

/**
 * Build the right gateway error: structured sidecar failures keep their
 * `{error: {code}}` body (mappable upstream); anything else (proxy 502s,
 * 401s, HTML error pages) stays a generic transport error so callers fall
 * back to the direct sidecar URL exactly as before.
 */
async function toSidecarError(res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const structured = asStructuredErrorBody(body);
  if (structured) return new SidecarUpstreamError(res.status, structured);
  const err = new Error(`sidecar gateway failed (HTTP ${res.status})`) as Error & { status?: number };
  err.status = res.status;
  return err;
}

export interface LocalDiscoveryHit {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  artwork?: string;
  url: string;
  site?: string;
  provider?: string;
  providerId?: string;
  sourceType: 'web-reference';
  playable: false;
  downloadable: false;
}

/**
 * Local Web Discovery search (desktop shell): the local KNOX Core performs
 * the web search + metadata extraction server-side. Only the trimmed query
 * leaves the renderer (loopback). Returns null outside the desktop shell or
 * when the service is unreachable — callers fall back to the direct public
 * metadata path. Never sends library/playlists/favorites/history.
 */
export async function discoverySearch(
  query: string,
  timeoutMs = 8000,
): Promise<{ results: LocalDiscoveryHit[] } | null> {
  const q = (query ?? '').trim().slice(0, 200);
  if (!q) return { results: [] };
  const res = await authed(`/api/discovery/search?q=${encodeURIComponent(q)}`, { method: 'GET' }, timeoutMs);
  if (!res) return null;
  if (!res.ok) throw new Error(`local discovery search failed (HTTP ${res.status})`);
  return (await res.json()) as { results: LocalDiscoveryHit[] };
}

/**
 * Local page fetch proxy (desktop shell): fetch one public music page
 * through the local service (SSRF-guarded + size/time bounded server-side).
 * Returns the raw Response for the caller to bound-read, or null outside
 * the desktop shell (caller uses direct fetch).
 */
export async function discoveryFetch(target: string, timeoutMs = 8000): Promise<Response | null> {
  if (typeof target !== 'string' || !target || target.length > 2048) {
    throw new Error('target must be a short non-empty URL');
  }
  return authed(`/api/discovery/fetch?target=${encodeURIComponent(target)}`, { method: 'GET' }, timeoutMs);
}
