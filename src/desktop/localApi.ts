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

export const TOKEN_HEADER = 'x-knox-token';
export const LOCAL_API_TIMEOUT_MS = 25000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Providers the local egress proxy serves (mirrors the Rust allowlist). */
export const PROXY_PROVIDERS = new Set([
  'jamendo',
  'internet-archive',
  'freetouse',
  'lrclib',
  'radio-browser',
  'airbeats',
]);

export function isProxyProvider(id: string): boolean {
  return PROXY_PROVIDERS.has(id);
}

/** Exact hosts per provider; radio-browser allows its regional subdomains. */
function allowedHost(provider: string, host: string): boolean {
  switch (provider) {
    case 'jamendo':
      return host === 'api.jamendo.com';
    case 'internet-archive':
      return host === 'archive.org';
    case 'freetouse':
      return host === 'api.freetouse.com';
    case 'lrclib':
      return host === 'lrclib.net';
    case 'radio-browser':
      return host === 'api.radio-browser.info' || host.endsWith('.api.radio-browser.info');
    case 'airbeats':
      return host === 'api.airbeats.xyz';
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
 * Returns null outside the desktop shell (caller uses direct fetch).
 */
export async function proxyGet(provider: string, target: string, timeoutMs = 20000): Promise<Response | null> {
  validateProxyTarget(provider, target);
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
  if (!res.ok) throw new Error(`sidecar gateway failed (HTTP ${res.status})`);
  return (await res.json()) as T;
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
