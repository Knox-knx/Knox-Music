// Live Web Discovery — local-first desktop service client.
//
// The user's computer is the server: KNOX Desktop → Tauri / Local KNOX Core
// → Web Discovery service → Internet. No KNOX cloud backend, no Railway /
// Render / Vercel / VPS required.
//
// Two local paths (both reference/metadata only — never audio extraction):
//  1. Desktop shell: renderer → local KNOX API (GET /api/discovery/search,
//     GET /api/discovery/fetch) which performs the web search + page fetch
//     server-side (no renderer CORS, SSRF-guarded + size/time bounded).
//  2. Browser/PWA (or desktop API unreachable): direct public-metadata
//     lookup against MusicBrainz (no key, CORS-enabled) from the renderer.
//
// Only the trimmed search query ever leaves the device. Library, playlists,
// favorites, history, files, profiles, and credentials are never sent.

import { logger } from '../core/logger';
import { validateDiscoveryUrl } from './ssrfGuard';
import type { WebDiscoveryResult } from './types';
import type { WebSearchOptions } from './webSearch';

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const LOCAL_TIMEOUT_MS = 8000;

interface MbRecording {
  id: string;
  title?: string;
  length?: number;
  'artist-credit'?: { name?: string; artist?: { name?: string } }[];
  releases?: { title?: string; date?: string }[];
}

interface MbSearchResponse {
  recordings?: MbRecording[];
}

/** Build MusicBrainz Lucene query from user text (title/artist/album). */
export function buildMusicBrainzQuery(rawQuery: string): string {
  const q = (rawQuery ?? '').trim().slice(0, 200);
  if (!q) return '';
  // Quote phrases with spaces so "soch hardy sandhu" matches as terms, and
  // request the default indexed fields (recording title + artist name).
  const terms = q.split(/\s+/).slice(0, 8).filter(Boolean);
  if (terms.length === 0) return '';
  if (terms.length === 1) return `recording:"${terms[0]}" OR artist:"${terms[0]}"`;
  const joined = terms.join(' ');
  return `recording:"${joined}" OR artist:"${joined}" OR release:"${joined}"`;
}

function mbArtistName(r: MbRecording): string | undefined {
  const credit = r['artist-credit'];
  if (!Array.isArray(credit) || credit.length === 0) return undefined;
  const names = credit
    .map((c) => c?.artist?.name ?? c?.name)
    .filter((n): n is string => typeof n === 'string' && !!n.trim());
  if (names.length === 0) return undefined;
  return names.join(', ').slice(0, 300);
}

function mbToResults(data: MbSearchResponse, limit: number): WebDiscoveryResult[] {
  const recs = Array.isArray(data?.recordings) ? data.recordings : [];
  const out: WebDiscoveryResult[] = [];
  for (const r of recs.slice(0, limit)) {
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    const title = typeof r.title === 'string' ? r.title.slice(0, 300) : undefined;
    const artist = mbArtistName(r);
    if (!title && !artist) continue;
    const url = `https://musicbrainz.org/recording/${r.id}`;
    const release = Array.isArray(r.releases) ? r.releases[0] : undefined;
    out.push({
      url,
      title,
      artist,
      album: typeof release?.title === 'string' ? release.title.slice(0, 300) : undefined,
      durationMs:
        typeof r.length === 'number' && Number.isFinite(r.length) && r.length > 0
          ? Math.round(r.length)
          : undefined,
      site: 'MusicBrainz',
      provider: 'musicbrainz',
      providerId: r.id.slice(0, 120),
      sourceType: 'web',
      origin: 'catalog',
      discoveredAt: Date.now(),
    });
  }
  return out;
}

async function fetchJsonBounded(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<unknown | null> {
  const verdict = validateDiscoveryUrl(url);
  if (!verdict.ok) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(verdict.url!, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || '0');
    if (len > maxBytes) return null;
    const text = await res.text().catch(() => null);
    if (!text || text.length > maxBytes) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Local KNOX API discovery search (desktop shell). Returns null outside the
 * desktop shell or when the local service is unreachable — the caller falls
 * back to the direct public-metadata path below.
 */
export async function discoverySearchViaLocalApi(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebDiscoveryResult[] | null> {
  try {
    const { getApiConfig } = await import('../desktop/host');
    const cfg = await getApiConfig().catch(() => null);
    if (!cfg) return null;
    const { TOKEN_HEADER } = await import('../desktop/localApi');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? LOCAL_TIMEOUT_MS);
    try {
      const doFetch = opts.fetchImpl ?? fetch;
      const url = `http://127.0.0.1:${cfg.port}/api/discovery/search?q=${encodeURIComponent(query.trim().slice(0, 200))}`;
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { [TOKEN_HEADER]: cfg.token },
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        results?: WebDiscoveryResult[];
      } | null;
      if (!data || !Array.isArray(data.results)) return null;
      return data.results.slice(0, opts.limit ?? 12);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return null;
  }
}

/**
 * Direct public-metadata discovery (browser/PWA or desktop fallback).
 * MusicBrainz only: no key, CORS-enabled, rate-limited client-side by the
 * webSearch token bucket. Returns sanitized web results (reference-only).
 */
export async function discoverySearchViaPublicMetadata(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebDiscoveryResult[]> {
  const q = (query ?? '').trim().slice(0, 200);
  if (!q) return [];
  const mbq = buildMusicBrainzQuery(q);
  if (!mbq) return [];
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = Math.min(opts.limit ?? 12, 12);
  const url =
    `${MUSICBRAINZ_API}/recording/?query=${encodeURIComponent(mbq)}` +
    `&fmt=json&limit=${limit}`;
  const data = (await fetchJsonBounded(
    url,
    doFetch,
    opts.signal,
    opts.timeoutMs ?? LOCAL_TIMEOUT_MS,
    512 * 1024,
  ).catch(() => null)) as MbSearchResponse | null;
  if (!data) {
    logger.debug('discovery', 'local metadata lookup failed');
    return [];
  }
  return mbToResults(data, limit);
}

/**
 * Local-first web search provider implementation. Desktop: local KNOX API
 * first, public metadata as fallback. Browser: public metadata directly.
 * Never throws — failures yield [] so provider search continues.
 */
export async function localDesktopDiscoverySearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebDiscoveryResult[]> {
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return [];
  try {
    const viaLocal = await discoverySearchViaLocalApi(q, opts).catch(() => null);
    if (viaLocal && viaLocal.length > 0) return viaLocal;
  } catch {
    /* fall through to public metadata */
  }
  if (opts.signal?.aborted) return [];
  try {
    return await discoverySearchViaPublicMetadata(q, opts);
  } catch {
    return [];
  }
}

/**
 * Fetch a public music page's HTML preferring the local KNOX API proxy
 * (desktop: no renderer CORS) with direct fetch as fallback. SSRF-guarded
 * on both paths (server re-validates). Returns null on any failure.
 */
export async function fetchDiscoveryPageHtml(
  rawUrl: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<{ html: string; via: 'local-proxy' | 'direct' } | null> {
  const verdict = validateDiscoveryUrl(rawUrl);
  if (!verdict.ok) return null;
  const url = verdict.url!;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  // Path 1: local proxy (desktop shell only).
  try {
    const { getApiConfig } = await import('../desktop/host');
    const cfg = await getApiConfig().catch(() => null);
    if (cfg) {
      const { TOKEN_HEADER } = await import('../desktop/localApi');
      const doFetch = opts.fetchImpl ?? fetch;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const proxyUrl =
          `http://127.0.0.1:${cfg.port}/api/discovery/fetch?target=${encodeURIComponent(url)}`;
        const res = await doFetch(proxyUrl, {
          signal: controller.signal,
          headers: { [TOKEN_HEADER]: cfg.token, Accept: 'text/html,application/xhtml+xml' },
        });
        if (res.ok) {
          const len = Number(res.headers.get('content-length') || '0');
          if (!(len > maxBytes)) {
            const text = await res.text().catch(() => null);
            if (text && text.length <= maxBytes) return { html: text, via: 'local-proxy' };
          }
        }
      } catch {
        /* fall through to direct */
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }
  } catch {
    /* fall through to direct */
  }
  // Path 2: direct fetch (browser/PWA, or desktop fallback).
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) return null;
      const text = await res.text().catch(() => null);
      if (!text || text.length > maxBytes) return null;
      return { html: text, via: 'direct' };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  } catch {
    return null;
  }
}
