// YouTube & YouTube Music public metadata / search scraper logic.
//
// Consolidates the YouTube / YouTube Music public discovery & metadata
// scraping patterns used across KNOX Music:
//   1. URL detection & canonicalization (youtube.com, music.youtube.com, youtu.be)
//   2. Public InnerTube WEB_REMIX search & track metadata lookup (no auth)
//   3. Public page metadata extraction (JSON-LD, OpenGraph, <title>/<meta>)

import { extractPageMetadata } from '../../discovery/metadataExtractor';
import { validateDiscoveryUrl } from '../../discovery/ssrfGuard';
import type { PageMetadata, TrackReference } from '../../discovery/types';
import type { YouTubeSearchResult, YouTubeThumbnail } from './types';

export const YOUTUBE_INNERTUBE_SEARCH_URL =
  'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
export const YOUTUBE_INNERTUBE_PLAYER_URL =
  'https://music.youtube.com/youtubei/v1/player?prettyPrint=false';

export const WEB_REMIX_CLIENT = {
  clientName: 'WEB_REMIX',
  clientVersion: '1.20251022.01.00',
  hl: 'en',
  gl: 'US',
} as const;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

export function isValidYouTubeId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID_RE.test(id.trim());
}

/**
 * Extract a YouTube video ID from a URL or bare ID string.
 */
export function extractYouTubeVideoId(urlOrId: string): string | null {
  const raw = (urlOrId ?? '').trim().replace(/^youtube(-music)?:/, '');
  if (isValidYouTubeId(raw)) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const seg = u.pathname.split('/').filter(Boolean)[0];
      return isValidYouTubeId(seg) ? seg : null;
    }
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'm.youtube.com') {
      const v = u.searchParams.get('v');
      if (isValidYouTubeId(v)) return v;
      const parts = u.pathname.split('/').filter(Boolean);
      if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'v') && isValidYouTubeId(parts[1])) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Canonicalize a YouTube or YouTube Music URL.
 */
export function canonicalizeYouTubeUrl(rawUrl: string): string | null {
  const videoId = extractYouTubeVideoId(rawUrl);
  if (videoId) {
    try {
      const u = new URL(rawUrl);
      if (u.hostname.toLowerCase().includes('music.youtube.com')) {
        return `https://music.youtube.com/watch?v=${videoId}`;
      }
    } catch {
      /* default to standard watch URL */
    }
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return null;
}

function parseDurationSeconds(text: string): number | null {
  const parts = text
    .trim()
    .split(':')
    .map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs > 0 && secs <= 86400 ? secs : null;
}

function textOfRuns(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const runs = (node as { runs?: unknown[] }).runs;
  if (!Array.isArray(runs)) return '';
  return runs
    .map((r) => (r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string' ? (r as { text: string }).text : ''))
    .join('');
}

function walkResponsiveItems(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkResponsiveItems(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, val] of Object.entries(obj)) {
    if (k === 'musicResponsiveListItemRenderer' && val && typeof val === 'object') {
      out.push(val as Record<string, unknown>);
    } else {
      walkResponsiveItems(val, out);
    }
  }
}

/**
 * Parse a single `musicResponsiveListItemRenderer` node from InnerTube search results.
 */
export function parseInnerTubeSearchItem(renderer: Record<string, unknown>): YouTubeSearchResult | null {
  const overlayVid =
    ((
      ((renderer.overlay as Record<string, unknown>)?.musicItemThumbnailOverlayRenderer as Record<string, unknown>)
        ?.content as Record<string, unknown>
    )?.musicPlayButtonRenderer as Record<string, unknown>)?.playNavigationEndpoint as Record<string, unknown> | undefined;
  const watchVid = (overlayVid?.watchEndpoint as Record<string, unknown>)?.videoId;
  const navVid = ((renderer.navigationEndpoint as Record<string, unknown>)?.watchEndpoint as Record<string, unknown>)
    ?.videoId;
  const vid = typeof watchVid === 'string' ? watchVid : typeof navVid === 'string' ? navVid : null;
  if (!isValidYouTubeId(vid)) return null;

  const flexCols = Array.isArray(renderer.flexColumns) ? (renderer.flexColumns as Record<string, unknown>[]) : [];
  const colText = (idx: number): string => {
    const col = flexCols[idx]?.musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined;
    return textOfRuns(col?.text);
  };

  const title = colText(0).trim();
  if (!title) return null;

  const subtitle = colText(1);
  const segments = subtitle
    .split('•')
    .map((s) => s.trim())
    .filter(Boolean);

  const typeTokens = new Set(['song', 'video', 'single', 'ep', 'album', 'playlist', 'artist', 'explicit']);
  let channel = 'Unknown';
  for (const seg of segments) {
    const low = seg.toLowerCase();
    if (typeTokens.has(low)) continue;
    if (
      low.includes('monthly audience') ||
      low.includes('subscribers') ||
      low.includes('views') ||
      low.includes('songs') ||
      low.includes('videos')
    ) {
      continue;
    }
    if (parseDurationSeconds(seg) !== null) continue;
    if (/^(19|20)\d{2}$/.test(seg)) continue;
    channel = seg;
    break;
  }

  const fixedCols = Array.isArray(renderer.fixedColumns) ? (renderer.fixedColumns as Record<string, unknown>[]) : [];
  const fixedCol0 = fixedCols[0]?.musicResponsiveListItemFixedColumnRenderer as Record<string, unknown> | undefined;
  let duration = parseDurationSeconds(textOfRuns(fixedCol0?.text));
  if (duration === null) {
    for (const seg of segments) {
      const d = parseDurationSeconds(seg);
      if (d !== null) {
        duration = d;
        break;
      }
    }
  }

  const rawThumbs = (
    ((renderer.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer as Record<string, unknown>)
      ?.thumbnail as Record<string, unknown>
  )?.thumbnails;
  const thumbnails: YouTubeThumbnail[] = Array.isArray(rawThumbs)
    ? rawThumbs
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object' && typeof (t as { url?: unknown }).url === 'string'))
        .map((t) => ({
          url: String(t.url),
          width: Number(t.width) || 0,
          height: Number(t.height) || 0,
        }))
    : [];

  return {
    id: vid,
    title,
    channel,
    duration,
    url: `https://www.youtube.com/watch?v=${vid}`,
    live: false,
    thumbnails: thumbnails.length > 0 ? thumbnails : undefined,
  };
}

/**
 * Search YouTube Music public catalog metadata via InnerTube WEB_REMIX.
 */
export async function searchYouTubeInnerTube(
  query: string,
  opts: { limit?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<YouTubeSearchResult[]> {
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 60));
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(YOUTUBE_INNERTUBE_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
    },
    body: JSON.stringify({
      context: { client: WEB_REMIX_CLIENT },
      query: q,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`YouTube InnerTube search failed (HTTP ${res.status})`);
  }

  const payload = (await res.json()) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = [];
  if (payload.contents) {
    walkResponsiveItems(payload.contents, rows);
  }

  const results: YouTubeSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (results.length >= limit) break;
    const parsed = parseInnerTubeSearchItem(row);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      results.push(parsed);
    }
  }
  return results;
}

export const scrapeYouTubeSearch = searchYouTubeInnerTube;

/**
 * Scrape public metadata from a YouTube / YouTube Music watch page HTML
 * using KNOX's layered static parser (JSON-LD → OpenGraph → <title>/<meta>).
 */
export function parseYouTubePageHtml(html: string, url: string): PageMetadata | null {
  const videoId = extractYouTubeVideoId(url);
  const canonicalUrl = canonicalizeYouTubeUrl(url) ?? url;
  return extractPageMetadata(html, canonicalUrl, {
    site: url.includes('music.youtube.com') ? 'YouTube Music' : 'YouTube',
    providerId: videoId ?? undefined,
  });
}

/**
 * Fetch and parse a public YouTube page into a discovery TrackReference.
 */
export async function scrapeYouTubePageReference(
  rawUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TrackReference | null> {
  const verdict = validateDiscoveryUrl(rawUrl);
  if (!verdict.ok || !verdict.url) return null;
  const videoId = extractYouTubeVideoId(verdict.url);
  const canonicalUrl = canonicalizeYouTubeUrl(verdict.url) ?? verdict.url;
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(verdict.url, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
    signal: opts.signal,
  });
  if (!res.ok) return null;
  const html = await res.text();
  const meta = parseYouTubePageHtml(html, canonicalUrl);
  if (!meta || (!meta.title && !meta.artist)) return null;

  return {
    provider: canonicalUrl.includes('music.youtube.com') ? 'youtube-music-web' : 'youtube',
    providerId: videoId ?? meta.providerId,
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    durationMs: meta.durationMs,
    artwork: meta.artwork,
    canonicalUrl: meta.canonicalUrl ?? canonicalUrl,
    originalDiscoveredUrl: rawUrl,
    sourceType: 'web',
    origin: 'web',
    playable: true,
    downloadable: true,
    cacheable: true,
    site: canonicalUrl.includes('music.youtube.com') ? 'YouTube Music' : 'YouTube',
  };
}
