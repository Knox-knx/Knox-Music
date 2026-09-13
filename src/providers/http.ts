// Shared HTTP helpers: timeout, retry with exponential backoff, rate-limit
// respect, and strict URL validation. All providers must go through these so
// one slow/h failing API can never hang the UI.

import { ProviderError } from '../core/errors';
import { safeUrlOrUndefined } from '../core/utils';
import { logger } from '../core/logger';
import { isTauri } from '../desktop/detector';

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Extra headers (never put credentials here). */
  headers?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 10000);
  }
  // 400ms, 800ms, 1600ms ... capped at 5s + small jitter
  return Math.min(5000, 400 * 2 ** attempt) + Math.floor(Math.random() * 120);
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * GET JSON with per-request timeout + retries. Throws ProviderError with
 * TIMEOUT / RATE_LIMIT / NETWORK — never a raw TypeError — so the
 * ProviderManager can attribute failures per provider.
 *
 * Desktop path: when the Tauri host is present, routable provider URLs go
 * through the local KNOX egress proxy first (fixes CORS, centralizes
 * timeout/logging server-side). Any proxy failure falls back to the direct
 * fetch below — proxying is an optimization, never a hard dependency.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 15000, retries = 2, signal, headers } = opts;
  const safe = safeUrlOrUndefined(url);
  if (!safe) throw new ProviderError('NETWORK', 'Refusing to fetch an unsafe URL');

  if (isTauri() && !signal?.aborted && !headers) {
    try {
      const proxied = await fetchJsonViaLocalProxy<T>(safe, timeoutMs, signal);
      if (proxied !== undefined) return proxied;
      // Proxy inapplicable/unreachable in-shell: the direct fetch below is
      // the fallback. Debug-level (expected in browser shells; diagnosable
      // in desktop when CORS-blocked hosts like api.freetouse.com fail).
      logger.debug('providers', `proxy miss (${providerForUrl(safe) ?? 'unknown'}), falling back to direct fetch`);
    } catch (e) {
      // A proxy that RESPONDED with an error is recorded for diagnosis, then
      // the direct fetch still gets its chance (redundancy, not dependence).
      // Only host + status travel to the logs — never the full target URL.
      const reason = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
      logger.warn('providers', `proxy error (${providerForUrl(safe) ?? 'unknown'}), falling back to direct fetch`, reason);
    }
  }

  let lastError: unknown = null;
  const attempts = Math.max(0, retries) + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(safe, { signal: controller.signal, headers });
      if (res.status === 429) {
        lastError = new ProviderError('RATE_LIMIT', `Rate limited: ${safe}`);
        if (attempt < attempts - 1) {
          await sleep(backoffDelay(attempt, parseRetryAfter(res)));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
          lastError = new ProviderError('NETWORK', `HTTP ${res.status}`);
          await sleep(backoffDelay(attempt));
          continue;
        }
        if (res.status === 404) throw new ProviderError('NOT_FOUND', `Not found (HTTP 404)`);
        throw new ProviderError('NETWORK', `Request failed (HTTP ${res.status})`);
      }
      return (await res.json()) as T;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // Caller-cancelled vs our timeout: surface TIMEOUT for our own timer.
        if (signal?.aborted) throw e;
        lastError = new ProviderError('TIMEOUT', `Request timed out after ${timeoutMs}ms`);
      } else if (e instanceof ProviderError) {
        lastError = e;
        // Non-retryable provider errors bubble immediately.
        if (e.code === 'NOT_FOUND' || e.code === 'UNSUPPORTED') throw e;
      } else {
        lastError = new ProviderError('NETWORK', e instanceof Error ? e.message : 'Network request failed');
      }
      if (attempt < attempts - 1) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError('NETWORK', 'Request failed');
}

const PROXY_HOST_TO_PROVIDER: [string, string][] = [
  ['api.jamendo.com', 'jamendo'],
  ['archive.org', 'internet-archive'],
  ['api.freetouse.com', 'freetouse'],
  ['lrclib.net', 'lrclib'],
  ['api.radio-browser.info', 'radio-browser'],
  ['api.airbeats.xyz', 'airbeats'],
];

function providerForUrl(safeUrl: string): string | null {
  let host = '';
  try {
    host = new URL(safeUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [suffix, provider] of PROXY_HOST_TO_PROVIDER) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return provider;
  }
  return null;
}

/**
 * Try the local KNOX egress proxy for one GET. Resolves to the parsed JSON
 * on success, or `undefined` when the proxy is unavailable/inapplicable so
 * the caller falls back to a direct fetch. Never throws.
 */
async function fetchJsonViaLocalProxy<T>(
  safeUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const provider = providerForUrl(safeUrl);
  if (!provider) return undefined;
  try {
    const { getApiConfig } = await import('../desktop/host');
    const cfg = await getApiConfig();
    if (!cfg) return undefined;
    const { proxyGetJson } = await import('../desktop/localApi');
    const data = await proxyGetJson<T>(provider, safeUrl, Math.min(timeoutMs, 20000));
    if (data === null) return undefined;
    if (signal?.aborted) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/** Validate a provider-supplied media URL before handing it to audio/download. */
export function requireSafeMediaUrl(url: unknown, label = 'Provider returned an unsafe audio URL'): string {  if (typeof url !== 'string' || !url) throw new ProviderError('NETWORK', label);
  const safe = safeUrlOrUndefined(url);
  if (!safe) throw new ProviderError('NETWORK', label);
  return safe;
}
