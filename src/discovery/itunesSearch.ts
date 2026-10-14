// Live Web Discovery — iTunes Search adapter (genuine public web catalog).
//
// Why iTunes: it is a COMPLIANT public search API (no key, no auth, no
// scraping, no anti-bot bypass) that returns real public music pages —
// trackViewUrl points at a music.apple.com page — plus artwork, duration,
// and collection metadata. That is genuine web discovery, not just a
// metadata-database lookup: results identify public pages on a major music
// site, which the page resolver then enriches from public HTML metadata.
//
// Reference-only, like every discovery source: playable=false,
// downloadable=false. Only an authorized KNOX provider can supply audio.

import { validateDiscoveryUrl } from './ssrfGuard';
import type { WebDiscoveryResult } from './types';
import type { WebSearchOptions } from './webSearch';

const ITUNES_API = 'https://itunes.apple.com/search';
const ITUNES_TIMEOUT_MS = 8000;
const ITUNES_MAX_BYTES = 512 * 1024;

interface ITunesTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  trackViewUrl?: string;
  releaseDate?: string;
}

interface ITunesResponse {
  resultCount?: number;
  results?: ITunesTrack[];
}

function artwork(res: string | undefined): string | undefined {
  if (typeof res !== 'string' || !res) return undefined;
  // 100x100bb → 600x600bb for usable reference artwork.
  return res.replace('100x100bb', '600x600bb').slice(0, 2048);
}

export function itunesToResults(data: ITunesResponse, limit: number): WebDiscoveryResult[] {
  const rows = Array.isArray(data?.results) ? data.results : [];
  const out: WebDiscoveryResult[] = [];
  for (const r of rows.slice(0, limit)) {
    if (!r || typeof r.trackViewUrl !== 'string' || !r.trackViewUrl) continue;
    if (typeof r.trackName !== 'string' || !r.trackName.trim()) continue;
    out.push({
      url: r.trackViewUrl,
      title: r.trackName.slice(0, 300),
      artist: typeof r.artistName === 'string' ? r.artistName.slice(0, 300) : undefined,
      album: typeof r.collectionName === 'string' ? r.collectionName.slice(0, 300) : undefined,
      durationMs:
        typeof r.trackTimeMillis === 'number' && Number.isFinite(r.trackTimeMillis) && r.trackTimeMillis > 0
          ? Math.round(r.trackTimeMillis)
          : undefined,
      artwork: artwork(r.artworkUrl100),
      site: 'Apple Music',
      provider: 'apple-music',
      providerId: typeof r.trackId === 'number' ? String(r.trackId).slice(0, 120) : undefined,
      sourceType: 'web',
      origin: 'catalog',
      discoveredAt: Date.now(),
    });
  }
  return out;
}

/**
 * Genuine public-web catalog search via the iTunes Search API.
 * Never throws — failures yield [] so provider search continues.
 * Only the trimmed query is sent; nothing else leaves the device.
 */
export async function itunesDiscoverySearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebDiscoveryResult[]> {
  const q = (query ?? '').trim().slice(0, 200);
  if (!q) return [];
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = Math.min(opts.limit ?? 12, 12);
  const url =
    `${ITUNES_API}?term=${encodeURIComponent(q)}` +
    `&media=music&entity=song&limit=${limit}`;
  const verdict = validateDiscoveryUrl(url);
  if (!verdict.ok) return [];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ITUNES_TIMEOUT_MS);
  try {
    const res = await doFetch(verdict.url!, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const len = Number(res.headers.get('content-length') || '0');
    if (len > ITUNES_MAX_BYTES) return [];
    const text = await res.text().catch(() => null);
    if (!text || text.length > ITUNES_MAX_BYTES) return [];
    let data: ITunesResponse;
    try {
      data = JSON.parse(text) as ITunesResponse;
    } catch {
      return [];
    }
    return itunesToResults(data, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Map one local-API discovery hit (Rust iTunes row) to a web result. */
export function localItunesHitToResult(hit: {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  artwork?: string;
  url: string;
  providerId?: string;
}): WebDiscoveryResult {
  return {
    url: hit.url,
    title: hit.title,
    artist: hit.artist,
    album: hit.album,
    durationMs: typeof hit.duration === 'number' && hit.duration > 0 ? Math.round(hit.duration) : undefined,
    artwork: hit.artwork,
    site: 'Apple Music',
    provider: 'apple-music',
    providerId: hit.providerId,
    sourceType: 'web',
      origin: 'catalog',
    discoveredAt: Date.now(),
  };
}
