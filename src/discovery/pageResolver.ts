// Live Web Discovery — page resolver.
//
// Static HTTP retrieval + metadata parsing only. Never executes page
// JavaScript. Every fetch is SSRF-guarded, size-capped, redirect-capped,
// and time-bounded. Each parser fails gracefully (null = discard result).

import { logger } from '../core/logger';
import { scrubDiscoveryUrl, validateDiscoveryUrl } from './ssrfGuard';
import { detectMusicPage } from './providerDetector';
import { extractPageMetadata } from './metadataExtractor';
import { readDiscoveryCache, writeDiscoveryCache } from './discoveryCache';
import type { TrackReference } from './types';

export interface PageResolverOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
}

export const PAGE_FETCH_TIMEOUT_MS = 8000;
export const PAGE_MAX_BYTES = 1_000_000;
export const PAGE_MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch page HTML with manual redirect handling (so every hop is SSRF
 * re-validated), a byte cap (decompression-bomb safe), and a timeout.
 * Returns null on any failure — the caller discards the result.
 */
async function fetchPageHtml(url: string, opts: PageResolverOptions): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? PAGE_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? PAGE_MAX_REDIRECTS;
  let current = url;
  let redirects = 0;

  for (;;) {
    const verdict = validateDiscoveryUrl(current);
    if (!verdict.ok) return null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(verdict.url!, {
        signal: controller.signal,
        redirect: 'manual' as RequestRedirect,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (isRedirect(res.status)) {
        if (redirects >= maxRedirects) return null;
        const loc = res.headers.get('location');
        if (!loc) return null;
        try {
          current = new URL(loc, current).href;
        } catch {
          return null;
        }
        // Never follow non-http(s) or blocked redirect targets.
        if (!validateDiscoveryUrl(current).ok) return null;
        // Block http downgrade of an https start.
        try {
          const from = new URL(url);
          const to = new URL(current);
          if (from.protocol === 'https:' && to.protocol !== 'https:') return null;
        } catch {
          return null;
        }
        redirects += 1;
        continue;
      }
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct && !ct.includes('html') && !ct.includes('xhtml') && !ct.includes('text')) {
        return null;
      }
      // Stream with a byte cap — oversized pages are discarded.
      if (!res.body) {
        const text = await res.text().catch(() => null);
        if (!text || text.length > maxBytes) return null;
        return text;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return null;
        }
        chunks.push(value);
      }
      const total = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        total.set(c, off);
        off += c.byteLength;
      }
      return new TextDecoder().decode(total);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Resolve one discovered URL into a normalized TrackReference (or null).
 * Cached briefly; never throws; never extracts audio.
 */
export async function resolveMusicPage(
  rawUrl: string,
  opts: PageResolverOptions = {},
): Promise<TrackReference | null> {
  const verdict = validateDiscoveryUrl(rawUrl);
  if (!verdict.ok) return null;
  const discoveredUrl = verdict.url!;

  const detected = detectMusicPage(discoveredUrl);
  // Unknown domains are preserved as generic web references (provider=web)
  // instead of being discarded — broad web discovery must not be limited to
  // a hardcoded site list. Detection only labels known sites; unknown sites
  // are never falsely identified.
  const fallback = detected ?? (() => {
    try {
      const u = new URL(discoveredUrl);
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      // Preserve the original URL; strip only tracking params via the
      // shared helper when possible (never strip page-identifying params).
      return {
        webProviderId: 'web',
        displayName: host.replace(/^www\./, ''),
        kind: 'unknown' as const,
        pageId: null as string | null,
        canonicalUrl: discoveredUrl,
      };
    } catch {
      return null;
    }
  })();
  if (!fallback) {
    logger.debug('discovery', 'page not a known music page', scrubDiscoveryUrl(discoveredUrl));
    return null;
  }

  const cached = readDiscoveryCache(fallback.canonicalUrl);
  if (cached) return cached;

  // Local-first page fetch: the desktop shell proxies through the local KNOX
  // API (no renderer CORS; server re-validates SSRF + redirects + size).
  // Browser/PWA falls back to the direct bounded fetch below.
  let html: string | null = null;
  try {
    const { fetchDiscoveryPageHtml } = await import('./localDiscoveryService');
    const via = await fetchDiscoveryPageHtml(discoveredUrl, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
      maxBytes: opts.maxBytes ?? PAGE_MAX_BYTES,
    });
    // The local proxy already enforces redirect/size policy server-side.
    // The direct path below re-validates every hop itself; only accept the
    // proxy body when it actually arrived.
    if (via && via.html) html = via.html;
  } catch {
    html = null;
  }
  html ??= await fetchPageHtml(discoveredUrl, opts);
  if (!html) {
    logger.debug('discovery', 'page fetch failed', scrubDiscoveryUrl(discoveredUrl));
    return null;
  }
  const meta = extractPageMetadata(html, fallback.canonicalUrl, {
    site: fallback.displayName,
    providerId: fallback.pageId ?? undefined,
  });
  if (!meta || (!meta.title && !meta.artist)) {
    logger.debug('discovery', 'page metadata unusable', scrubDiscoveryUrl(discoveredUrl));
    return null;
  }
  const ref: TrackReference = {
    provider: fallback.webProviderId,
    providerId: fallback.pageId ?? meta.providerId,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    durationMs: meta.durationMs,
    artwork: meta.artwork,
    canonicalUrl: meta.canonicalUrl ?? fallback.canonicalUrl,
    originalDiscoveredUrl: discoveredUrl,
    sourceType: 'web',
    // Parsed from fetched public-page HTML — genuine page scrape.
    origin: 'web',
    playable: false,
    downloadable: false,
    cacheable: false,
    site: fallback.displayName,
  };
  writeDiscoveryCache(ref);
  return ref;
}
