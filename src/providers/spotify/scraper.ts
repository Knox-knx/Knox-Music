// Spotify in-app server scraper & catalog client logic.
//
// Supports:
//   1. Spotify URL & URI detection, Base62 ID extraction, and canonicalization
//      (open.spotify.com/track|album|artist|playlist/<id>, intl-* paths, spotify:<kind>:<id>).
//   2. Public oEmbed metadata lookup (https://open.spotify.com/oembed?url=...) — no auth needed.
//   3. Static HTML metadata scraping (JSON-LD, OpenGraph og:title / og:description /
//      og:image / music:duration / music:musician / music:album / music:release_date).
//   4. Official Spotify Web API v1 client (when Bearer token is supplied) +
//      unauthenticated in-app catalog search fallback (sidecar / iTunes catalog API).

import { extractPageMetadata } from '../../discovery/metadataExtractor';
import { stripTrackingParams } from '../../discovery/providerDetector';
import { validateDiscoveryUrl } from '../../discovery/ssrfGuard';
import type { PageMetadata, TrackReference } from '../../discovery/types';
import {
  SPOTIFY_PROVIDER_ID,
  SPOTIFY_PROVIDER_NAME,
  type SpotifyAlbumMetadata,
  type SpotifyArtistMetadata,
  type SpotifyEntityKind,
  type SpotifyOEmbedResponse,
  type SpotifyPlaylistMetadata,
  type SpotifyTrackMetadata,
} from './types';

export const SPOTIFY_OEMBED_URL = 'https://open.spotify.com/oembed';
export const SPOTIFY_WEB_API_BASE = 'https://api.spotify.com/v1';
export const SPOTIFY_PUBLIC_CATALOG_URL = 'https://itunes.apple.com/search';

const SPOTIFY_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function isValidSpotifyId(id: unknown): id is string {
  return typeof id === 'string' && SPOTIFY_ID_RE.test(id.trim());
}

export function isSpotifyHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'open.spotify.com' || h === 'spotify.com' || h.endsWith('.spotify.com');
}

/**
 * Detect a Spotify entity kind and ID from a public URL or `spotify:` URI.
 * Handles regional prefixes such as `/intl-en/track/<id>`.
 */
export function detectSpotifyUrlOrUri(input: string): {
  kind: SpotifyEntityKind;
  id: string | null;
  canonicalUrl: string;
} | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  // Handle spotify:<kind>:<id> URI
  const uriMatch = /^spotify:(track|album|artist|playlist):([A-Za-z0-9]{15,32})$/i.exec(raw);
  if (uriMatch) {
    const kind = uriMatch[1].toLowerCase() as SpotifyEntityKind;
    const id = uriMatch[2];
    return {
      kind,
      id,
      canonicalUrl: `https://open.spotify.com/${kind}/${id}`,
    };
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!isSpotifyHost(u.hostname)) return null;

  // Strip optional /intl-<locale>/ or /embed/ prefixes
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .filter((s) => !/^intl-[a-z]{2}(-[a-z0-9]+)?$/i.test(s) && s.toLowerCase() !== 'embed');

  if (segs.length === 0) return null;
  const first = segs[0].toLowerCase();
  let kind: SpotifyEntityKind = 'unknown';
  if (first === 'track' || first === 'song') kind = 'track';
  else if (first === 'album') kind = 'album';
  else if (first === 'artist') kind = 'artist';
  else if (first === 'playlist') kind = 'playlist';
  else return null;

  const candidateId = segs[1] ?? null;
  const id = candidateId && /^[A-Za-z0-9]{15,32}$/.test(candidateId) ? candidateId : null;
  const canonicalUrl = id
    ? `https://open.spotify.com/${kind}/${id}`
    : stripTrackingParams(u);

  return { kind, id, canonicalUrl };
}

export function parseSpotifyTrackQuery(input: string): string | null {
  const det = detectSpotifyUrlOrUri(input);
  if (det && det.kind === 'track' && det.id) return det.id;
  return null;
}

/**
 * Parse Spotify's og:description or <title> patterns into artist, album, and year.
 */
export function parseSpotifyDescriptionMetadata(
  title: string | undefined,
  description: string | undefined,
): { title?: string; artist?: string; album?: string; year?: number } {
  const cleanTitle = title
    ?.replace(/\s*[-|–—]\s*song(?:\s+and\s+lyrics)?\s+by\s+(.+?)\s*\|\s*Spotify.*$/i, '')
    .replace(/\s*\|\s*Spotify.*$/i, '')
    .trim();

  let artistFromTitle: string | undefined;
  if (title) {
    const byMatch = /\s*[-|–—]\s*song(?:\s+and\s+lyrics)?\s+by\s+(.+?)\s*\|\s*Spotify/i.exec(title);
    if (byMatch?.[1]) {
      artistFromTitle = byMatch[1].trim();
    }
  }

  if (!description) {
    return { title: cleanTitle, artist: artistFromTitle };
  }

  const tail = description.replace(/^Listen to .+?\s+on Spotify\.\s*/i, '').trim();
  const parts = tail
    .split('·')
    .map((p) => p.replace(/\.$/, '').trim())
    .filter(Boolean);

  let artist = artistFromTitle;
  let album: string | undefined;
  let year: number | undefined;

  for (const part of parts) {
    if (/^(19|20)\d{2}$/.test(part)) {
      year = Number(part);
      continue;
    }
    if (/^(song|track|single|ep|album|playlist|artist|\d+\s+songs?)$/i.test(part)) {
      continue;
    }
    if (!artist) {
      artist = part;
    } else if (!album && part !== artist) {
      album = part;
    }
  }

  return { title: cleanTitle, artist, album, year };
}

function readMetaTag(html: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(
    `<meta[^>]*?(?:property|name)=["']${esc}["'][^>]*?content=["']([^"']{1,500})["'][^>]*>`,
    'i',
  );
  const m1 = re1.exec(html);
  if (m1?.[1]) return m1[1].trim();
  const re2 = new RegExp(
    `<meta[^>]*?content=["']([^"']{1,500})["'][^>]*?(?:property|name)=["']${esc}["'][^>]*>`,
    'i',
  );
  const m2 = re2.exec(html);
  return m2?.[1] ? m2[1].trim() : null;
}

/**
 * Parse a public Spotify HTML page into structured PageMetadata.
 */
export function parseSpotifyPageHtml(html: string, pageUrl: string): PageMetadata | null {
  const detected = detectSpotifyUrlOrUri(pageUrl);
  const canonical = detected?.canonicalUrl ?? pageUrl;
  const base = extractPageMetadata(html, canonical, {
    site: SPOTIFY_PROVIDER_NAME,
    providerId: detected?.id ?? undefined,
  });

  const ogDesc = readMetaTag(html, 'og:description') ?? readMetaTag(html, 'description') ?? undefined;
  const ogTitle = readMetaTag(html, 'og:title') ?? base?.title;
  const parsedDesc = parseSpotifyDescriptionMetadata(ogTitle, ogDesc);

  const title = parsedDesc.title || base?.title;
  const artist = parsedDesc.artist || base?.artist;
  if (!title && !artist) return base;

  return {
    title,
    artist,
    album: base?.album ?? parsedDesc.album,
    durationMs: base?.durationMs,
    artwork: base?.artwork,
    canonicalUrl: base?.canonicalUrl ?? canonical,
    site: SPOTIFY_PROVIDER_NAME,
    providerId: detected?.id ?? base?.providerId,
    rawSource: base?.rawSource ?? 'opengraph',
  };
}

/**
 * Fetch public metadata for a Spotify URL via Spotify's unauthenticated oEmbed endpoint.
 */
export async function fetchSpotifyOEmbed(
  rawUrlOrUri: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SpotifyOEmbedResponse | null> {
  const detected = detectSpotifyUrlOrUri(rawUrlOrUri);
  if (!detected) return null;
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    const endpoint = `${SPOTIFY_OEMBED_URL}?url=${encodeURIComponent(detected.canonicalUrl)}`;
    const res = await doFetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as SpotifyOEmbedResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Scrape a public Spotify page (combining HTML metadata + oEmbed fallback)
 * into a normalized TrackReference.
 */
export async function scrapeSpotifyPageReference(
  rawUrlOrUri: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TrackReference | null> {
  const detected = detectSpotifyUrlOrUri(rawUrlOrUri);
  if (!detected) return null;
  const verdict = validateDiscoveryUrl(detected.canonicalUrl);
  if (!verdict.ok || !verdict.url) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    let meta: PageMetadata | null = null;
    try {
      const res = await doFetch(verdict.url, {
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (res.ok) {
        const html = await res.text();
        meta = parseSpotifyPageHtml(html, detected.canonicalUrl);
      }
    } catch {
      /* fall through to oEmbed */
    }

    if (!meta || (!meta.title && !meta.artist)) {
      const oembed = await fetchSpotifyOEmbed(detected.canonicalUrl, {
        signal: controller.signal,
        fetchImpl: doFetch,
      });
      if (oembed && oembed.title) {
        meta = {
          title: oembed.title.trim(),
          artist: oembed.author_name?.trim(),
          artwork: oembed.thumbnail_url,
          canonicalUrl: detected.canonicalUrl,
          site: SPOTIFY_PROVIDER_NAME,
          providerId: detected.id ?? undefined,
          rawSource: 'meta',
        };
      }
    }

    if (!meta || (!meta.title && !meta.artist)) return null;

    return {
      provider: SPOTIFY_PROVIDER_ID,
      providerId: detected.id ?? meta.providerId,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      durationMs: meta.durationMs,
      artwork: meta.artwork,
      canonicalUrl: meta.canonicalUrl ?? detected.canonicalUrl,
      originalDiscoveredUrl: rawUrlOrUri,
      sourceType: 'web',
      origin: 'web',
      playable: true,
      downloadable: true,
      cacheable: true,
      site: SPOTIFY_PROVIDER_NAME,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function readSpotifyAccessToken(explicitToken?: string): string | null {
  if (explicitToken && explicitToken.trim()) return explicitToken.trim();
  try {
    const meta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const t = meta?.VITE_SPOTIFY_ACCESS_TOKEN?.trim();
    if (t) return t;
  } catch {
    /* ignore */
  }
  try {
    const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const t = proc?.env?.VITE_SPOTIFY_ACCESS_TOKEN?.trim() || proc?.env?.SPOTIFY_ACCESS_TOKEN?.trim();
    if (t) return t;
  } catch {
    /* ignore */
  }
  return null;
}

export function parseSpotifyApiTrack(item: Record<string, unknown>): SpotifyTrackMetadata | null {
  // Support both Spotify Web API v1 items and iTunes/sidecar catalog items
  const id = String(item.id ?? item.trackId ?? '').trim();
  const title = String(item.name ?? item.title ?? item.trackName ?? '').trim();
  if (!id || !title) return null;

  const rawArtists = Array.isArray(item.artists) ? (item.artists as Record<string, unknown>[]) : [];
  const artists = rawArtists
    .filter((a) => a && (typeof a.id === 'string' || typeof a.id === 'number') && typeof a.name === 'string')
    .map((a) => ({ id: String(a.id), name: String(a.name).trim() }));
  if (artists.length === 0 && typeof item.artistName === 'string' && item.artistName.trim()) {
    artists.push({
      id: String(item.artistId ?? item.artistName).trim(),
      name: item.artistName.trim(),
    });
  }
  const artist =
    artists.map((a) => a.name).join(', ') ||
    (typeof item.artist === 'string' && item.artist.trim() ? item.artist.trim() : 'Unknown artist');

  const albumObj = (item.album && typeof item.album === 'object' ? item.album : {}) as Record<string, unknown>;
  const album =
    typeof albumObj.name === 'string'
      ? albumObj.name.trim()
      : typeof item.album === 'string'
        ? item.album.trim()
        : typeof item.collectionName === 'string'
          ? item.collectionName.trim()
          : undefined;
  const albumId =
    typeof albumObj.id === 'string'
      ? albumObj.id.trim()
      : item.collectionId !== undefined
        ? String(item.collectionId)
        : undefined;
  const releaseDate =
    typeof albumObj.release_date === 'string'
      ? albumObj.release_date
      : typeof item.releaseDate === 'string'
        ? item.releaseDate
        : undefined;
  const year =
    typeof item.year === 'number'
      ? item.year
      : releaseDate && /^(19|20)\d{2}/.test(releaseDate)
        ? Number(releaseDate.slice(0, 4))
        : undefined;

  const images = Array.isArray(albumObj.images) ? (albumObj.images as Record<string, unknown>[]) : [];
  const rawArt =
    typeof images[0]?.url === 'string'
      ? String(images[0].url)
      : typeof item.artworkUrl === 'string'
        ? item.artworkUrl
        : typeof item.artworkUrl100 === 'string'
          ? item.artworkUrl100.replace(/100x100bb/g, '600x600bb')
          : undefined;
  const dur = Number(item.duration_ms ?? item.durationMs ?? item.trackTimeMillis ?? 0);
  const durationMs = Number.isFinite(dur) && dur > 0 ? Math.round(dur) : undefined;
  const trackNumber =
    typeof item.track_number === 'number'
      ? item.track_number
      : typeof item.trackNumber === 'number'
        ? item.trackNumber
        : undefined;
  const extIds = (item.external_ids && typeof item.external_ids === 'object' ? item.external_ids : {}) as Record<
    string,
    unknown
  >;
  const isrc = typeof extIds.isrc === 'string' ? extIds.isrc : undefined;
  const url =
    typeof item.url === 'string' && item.url
      ? item.url
      : typeof item.trackViewUrl === 'string' && item.trackViewUrl
        ? item.trackViewUrl
        : `https://open.spotify.com/track/${id}`;

  return {
    id,
    title,
    artist,
    artists: artists.length > 0 ? artists : undefined,
    album,
    albumId,
    durationMs,
    year,
    trackNumber,
    artworkUrl: rawArt,
    isrc,
    url,
  };
}

function parseSpotifyPayload(data: unknown): {
  tracks: SpotifyTrackMetadata[];
  artists: SpotifyArtistMetadata[];
  albums: SpotifyAlbumMetadata[];
  playlists: SpotifyPlaylistMetadata[];
} {
  const tracks: SpotifyTrackMetadata[] = [];
  const artists: SpotifyArtistMetadata[] = [];
  const albums: SpotifyAlbumMetadata[] = [];
  const playlists: SpotifyPlaylistMetadata[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const t = parseSpotifyApiTrack(item as Record<string, unknown>);
        if (t) tracks.push(t);
      }
    }
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const trackItems = Array.isArray((obj.tracks as { items?: unknown[] })?.items)
      ? ((obj.tracks as { items: unknown[] }).items)
      : Array.isArray(obj.tracks)
        ? (obj.tracks as unknown[])
        : Array.isArray(obj.results)
          ? (obj.results as unknown[])
          : [];

    for (const item of trackItems) {
      if (item && typeof item === 'object') {
        const t = parseSpotifyApiTrack(item as Record<string, unknown>);
        if (t) tracks.push(t);
      }
    }

    const artistItems = Array.isArray((obj.artists as { items?: unknown[] })?.items)
      ? ((obj.artists as { items: unknown[] }).items)
      : [];
    for (const item of artistItems) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        if (!id || !name) continue;
        const images = Array.isArray(o.images) ? (o.images as Record<string, unknown>[]) : [];
        artists.push({
          id,
          name,
          artworkUrl: typeof images[0]?.url === 'string' ? String(images[0].url) : undefined,
          genres: Array.isArray(o.genres) ? o.genres.filter((g): g is string => typeof g === 'string') : undefined,
          url: `https://open.spotify.com/artist/${id}`,
        });
      }
    }

    const albumItems = Array.isArray((obj.albums as { items?: unknown[] })?.items)
      ? ((obj.albums as { items: unknown[] }).items)
      : [];
    for (const item of albumItems) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const title = typeof o.name === 'string' ? o.name.trim() : '';
        if (!id || !title) continue;
        const rawArtists = Array.isArray(o.artists) ? (o.artists as Record<string, unknown>[]) : [];
        const firstArtist = rawArtists[0];
        const releaseDate = typeof o.release_date === 'string' ? o.release_date : undefined;
        const images = Array.isArray(o.images) ? (o.images as Record<string, unknown>[]) : [];
        albums.push({
          id,
          title,
          artist: typeof firstArtist?.name === 'string' ? firstArtist.name : 'Unknown artist',
          artistId: typeof firstArtist?.id === 'string' ? firstArtist.id : undefined,
          releaseDate,
          year: releaseDate && /^(19|20)\d{2}/.test(releaseDate) ? Number(releaseDate.slice(0, 4)) : undefined,
          artworkUrl: typeof images[0]?.url === 'string' ? String(images[0].url) : undefined,
          totalTracks: typeof o.total_tracks === 'number' ? o.total_tracks : undefined,
          url: `https://open.spotify.com/album/${id}`,
        });
      }
    }

    const playlistItems = Array.isArray((obj.playlists as { items?: unknown[] })?.items)
      ? ((obj.playlists as { items: unknown[] }).items)
      : [];
    for (const item of playlistItems) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id.trim() : '';
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        if (!id || !name) continue;
        const images = Array.isArray(o.images) ? (o.images as Record<string, unknown>[]) : [];
        const tracksInfo = (o.tracks && typeof o.tracks === 'object' ? o.tracks : {}) as Record<string, unknown>;
        playlists.push({
          id,
          name,
          description: typeof o.description === 'string' ? o.description : undefined,
          artworkUrl: typeof images[0]?.url === 'string' ? String(images[0].url) : undefined,
          totalTracks: typeof tracksInfo.total === 'number' ? tracksInfo.total : undefined,
          url: `https://open.spotify.com/playlist/${id}`,
        });
      }
    }
  }

  // Derive artists & albums from tracks when using the catalog fallback
  if (artists.length === 0 && tracks.length > 0) {
    const seenArtists = new Set<string>();
    for (const t of tracks) {
      const id = t.artists?.[0]?.id || t.artist;
      if (!id || seenArtists.has(id)) continue;
      seenArtists.add(id);
      artists.push({
        id,
        name: t.artist,
        artworkUrl: t.artworkUrl,
        url: `https://open.spotify.com/artist/${encodeURIComponent(id)}`,
      });
    }
  }
  if (albums.length === 0 && tracks.length > 0) {
    const seenAlbums = new Set<string>();
    for (const t of tracks) {
      if (!t.album) continue;
      const id = t.albumId || t.album;
      if (seenAlbums.has(id)) continue;
      seenAlbums.add(id);
      albums.push({
        id,
        title: t.album,
        artist: t.artist,
        artistId: t.artists?.[0]?.id,
        year: t.year,
        artworkUrl: t.artworkUrl,
        url: `https://open.spotify.com/album/${encodeURIComponent(id)}`,
      });
    }
  }
  if (playlists.length === 0 && tracks.length > 0) {
    const first = tracks[0];
    playlists.push({
      id: `mix:${first.id}`,
      name: `${first.title} — Spotify Real-Time Radio`,
      description: `Real-time station inspired by ${first.artist}`,
      artworkUrl: first.artworkUrl,
      totalTracks: tracks.length,
      url: `https://open.spotify.com/track/${encodeURIComponent(first.id)}`,
      tracks,
    });
    if (artists.length > 0) {
      const topArtist = artists[0];
      const artistTracks = tracks.filter((t) =>
        t.artist.toLowerCase().includes(topArtist.name.toLowerCase()),
      );
      if (artistTracks.length >= 2) {
        playlists.push({
          id: `artist-mix:${encodeURIComponent(topArtist.name)}`,
          name: `This Is ${topArtist.name} (Spotify Mix)`,
          description: `Best of ${topArtist.name} & related tracks`,
          artworkUrl: topArtist.artworkUrl ?? first.artworkUrl,
          totalTracks: artistTracks.length,
          url: topArtist.url,
          tracks: artistTracks,
        });
      }
    }
  }

  return { tracks, artists, albums, playlists };
}

/**
 * Search Spotify catalog metadata:
 *   1. Direct Spotify URL or `spotify:` URI -> page/oEmbed scraper.
 *   2. Official Spotify Web API v1 when `accessToken` or `VITE_SPOTIFY_ACCESS_TOKEN` is set.
 *   3. In-app catalog fallback (sidecar `/api/spotify/search` or public catalog API)
 *      when no token is configured so the Spotify in-app server works out-of-the-box.
 */
export async function searchSpotifyCatalog(
  query: string,
  opts: {
    accessToken?: string;
    limit?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<{
  tracks: SpotifyTrackMetadata[];
  artists: SpotifyArtistMetadata[];
  albums: SpotifyAlbumMetadata[];
  playlists: SpotifyPlaylistMetadata[];
}> {
  const empty = { tracks: [], artists: [], albums: [], playlists: [] };
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return empty;

  // 1. Direct Spotify URL or URI
  const detected = detectSpotifyUrlOrUri(q);
  if (detected && detected.kind === 'track') {
    const ref = await scrapeSpotifyPageReference(q, opts);
    if (ref && ref.title) {
      return {
        ...empty,
        tracks: [
          {
            id: detected.id || ref.providerId || q,
            title: ref.title,
            artist: ref.artist || 'Unknown artist',
            album: ref.album,
            durationMs: ref.durationMs,
            artworkUrl: ref.artwork,
            url: ref.canonicalUrl,
          },
        ],
      };
    }
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  const doFetch = opts.fetchImpl ?? fetch;
  const token = readSpotifyAccessToken(opts.accessToken);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);

  try {
    // 2. Authenticated Spotify Web API v1
    if (token) {
      const params = new URLSearchParams({
        q,
        type: 'track,artist,album,playlist',
        limit: String(limit),
      });
      const res = await doFetch(`${SPOTIFY_WEB_API_BASE}/search?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        throw new Error(`Spotify Web API search failed (HTTP ${res.status})`);
      }
      const data = await res.json();
      return parseSpotifyPayload(data);
    }

    // 3. Unauthenticated in-app catalog search (custom fetchImpl in tests -> direct catalog URL)
    const catalogParams = new URLSearchParams({
      term: q,
      media: 'music',
      entity: 'song',
      limit: String(limit),
    });
    const catalogUrl = `${SPOTIFY_PUBLIC_CATALOG_URL}?${catalogParams.toString()}`;

    if (opts.fetchImpl) {
      const res = await doFetch(catalogUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Spotify catalog search failed (HTTP ${res.status})`);
      }
      const data = await res.json();
      return parseSpotifyPayload(data);
    }

    // Try sidecar first -> desktop gateway -> direct CORS-enabled catalog URL
    try {
      const { getYouTubeSidecarBaseUrl } = await import('../youtube/youtubeOffline');
      const baseUrl = await getYouTubeSidecarBaseUrl();
      const sidecarRes = await doFetch(
        `${baseUrl}/api/spotify/search?q=${encodeURIComponent(q)}&limit=${limit}`,
        { signal: controller.signal, headers: { Accept: 'application/json' } },
      );
      if (sidecarRes.ok) {
        const data = await sidecarRes.json();
        const parsed = parseSpotifyPayload(data);
        if (parsed.tracks.length > 0) return parsed;
      }
    } catch {
      /* fall through to desktop gateway / direct catalog */
    }

    try {
      const { proxyGetJson } = await import('../../desktop/localApi');
      const data = await proxyGetJson<unknown>('spotify', catalogUrl);
      if (data) {
        return parseSpotifyPayload(data);
      }
    } catch {
      /* fall through to direct fetch */
    }

    const res = await doFetch(catalogUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Spotify catalog search failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    return parseSpotifyPayload(data);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch real-time Spotify station / recommendation mix tracks for a seed track.
 */
export async function fetchSpotifyRecommendations(
  trackId: string,
  opts: {
    title?: string;
    artist?: string;
    album?: string;
    queryHint?: string;
    accessToken?: string;
    limit?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SpotifyTrackMetadata[]> {
  const cleanId = (trackId ?? '').trim().replace(/^spotify:(track:)?/, '');
  const limit = Math.max(5, Math.min(opts.limit ?? 35, 50));
  const doFetch = opts.fetchImpl ?? fetch;
  const token = readSpotifyAccessToken(opts.accessToken);
  const seen = new Set<string>([cleanId]);
  const out: SpotifyTrackMetadata[] = [];

  const pushUnique = (items: SpotifyTrackMetadata[]) => {
    for (const item of items) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= limit) break;
    }
  };

  // 1. Official Spotify Web API v1 /recommendations when Bearer token is available
  if (token && isValidSpotifyId(cleanId)) {
    try {
      const params = new URLSearchParams({
        seed_tracks: cleanId,
        limit: String(limit),
      });
      const res = await doFetch(`${SPOTIFY_WEB_API_BASE}/recommendations?${params.toString()}`, {
        signal: opts.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        const parsed = parseSpotifyPayload(data);
        pushUnique(parsed.tracks);
      }
    } catch {
      /* fall through to real-time catalog station builder */
    }
  }

  // 2. Real-time multi-angle station queries (artist hits, album, vibe)
  if (out.length < Math.min(20, limit)) {
    const queries: string[] = [];
    const primaryArtist = (opts.artist ?? '').split(',')[0].trim();
    if (primaryArtist && primaryArtist.toLowerCase() !== 'unknown artist') {
      queries.push(primaryArtist);
      queries.push(`${primaryArtist} hits`);
    }
    if (opts.album?.trim()) {
      queries.push(`${opts.album.trim()} ${primaryArtist}`.trim());
    }
    if (opts.title?.trim()) {
      queries.push(`${opts.title.trim()} ${primaryArtist}`.trim());
    }
    if (opts.queryHint?.trim()) {
      queries.push(opts.queryHint.trim());
    }
    if (queries.length === 0 && cleanId && !isValidSpotifyId(cleanId)) {
      queries.push(cleanId);
    }

    for (const q of queries) {
      if (out.length >= limit || opts.signal?.aborted) break;
      try {
        const { tracks } = await searchSpotifyCatalog(q, {
          limit: 25,
          signal: opts.signal,
          fetchImpl: opts.fetchImpl,
        });
        pushUnique(tracks);
      } catch {
        /* continue */
      }
    }
  }

  return out.slice(0, limit);
}
