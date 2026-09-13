// Live Web Discovery — music-page provider detection (plugin based).
//
// Each plugin recognizes public music-page URLs for one site and extracts
// the page/provider identifier generically (never hardcoded songs).
// Detection only — no audio extraction, no private APIs.

export interface WebPageProvider {
  /** Stable web provider id, e.g. "jiosaavn". */
  readonly webProviderId: string;
  readonly displayName: string;
  /** Host suffixes that belong to this site (lowercase, no port). */
  readonly hostSuffixes: string[];
  /** Path pattern hint: "song" | "album" | "artist" | "playlist" | "track" | "unknown". */
  detect(url: URL): WebPageKind | null;
  /** Extract the opaque page/provider identifier from the URL path. */
  extractId(url: URL): string | null;
  /** Build the canonical public page URL (tracking params stripped). */
  canonicalize(url: URL): string;
}

export type WebPageKind = 'song' | 'album' | 'artist' | 'playlist' | 'track' | 'unknown';

const plugins = new Map<string, WebPageProvider>();

export function registerWebPageProvider(p: WebPageProvider): void {
  plugins.set(p.webProviderId, p);
}

export function listWebPageProviders(): WebPageProvider[] {
  return [...plugins.values()];
}

export function clearWebPageProviders(): void {
  plugins.clear();
}

export function getWebPageProvider(id: string): WebPageProvider | undefined {
  return plugins.get(id);
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function matchesHost(url: URL, suffixes: string[]): boolean {
  const h = hostOf(url);
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}

export interface DetectedPage {
  webProviderId: string;
  displayName: string;
  kind: WebPageKind;
  pageId: string | null;
  canonicalUrl: string;
}

/** Detect which known music site (if any) a URL belongs to. Pure. */
export function detectMusicPage(rawUrl: string): DetectedPage | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const p of plugins.values()) {
    if (!matchesHost(url, p.hostSuffixes)) continue;
    const kind = p.detect(url);
    if (!kind) continue;
    let canonical = rawUrl;
    try {
      canonical = p.canonicalize(url);
    } catch {
      canonical = rawUrl;
    }
    let pageId: string | null = null;
    try {
      pageId = p.extractId(url);
    } catch {
      pageId = null;
    }
    return {
      webProviderId: p.webProviderId,
      displayName: p.displayName,
      kind,
      pageId,
      canonicalUrl: canonical,
    };
  }
  return null;
}

// --- shared helpers for plugins ---

/** Last non-empty path segment (usually the opaque page id). */
export function lastPathSegment(url: URL): string | null {
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1];
  if (!last || last.length > 256) return null;
  return last;
}

/** Strip tracking params, preserve page-identifying params. */
export function stripTrackingParams(url: URL, preserve: string[] = []): string {
  const keep = new Set(preserve.map((s) => s.toLowerCase()));
  const out = new URL(url.href);
  const params = [...out.searchParams.keys()];
  for (const k of params) {
    const lk = k.toLowerCase();
    if (keep.has(lk)) continue;
    if (lk.startsWith('utm_')) {
      out.searchParams.delete(k);
      continue;
    }
    if (['ref', 'referrer', 'referer', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid', 'si'].includes(lk)) {
      out.searchParams.delete(k);
    }
  }
  out.hash = '';
  return out.href;
}

// --- built-in plugins (generic, no hardcoded songs) ---

function genericSongPlugin(
  webProviderId: string,
  displayName: string,
  hostSuffixes: string[],
  songPathHints: string[] = ['song', 'track'],
): WebPageProvider {
  return {
    webProviderId,
    displayName,
    hostSuffixes,
    detect(url: URL): WebPageKind | null {
      const path = url.pathname.toLowerCase();
      const segs = path.split('/').filter(Boolean);
      if (segs.length === 0) return null;
      if (segs.includes('song') || segs.includes('track')) return 'song';
      if (segs.includes('album')) return 'album';
      if (segs.includes('artist')) return 'artist';
      if (segs.includes('playlist')) return 'playlist';
      // Site-root song-style URLs with an id-like last segment still count
      // as unknown-kind music pages (conservative: only with 2+ segments).
      if (segs.length >= 2 && songPathHints.length > 0) return 'unknown';
      return null;
    },
    extractId(url: URL): string | null {
      return lastPathSegment(url);
    },
    canonicalize(url: URL): string {
      // Preserve common page identifiers (v= video, list= playlist).
      return stripTrackingParams(url, ['v', 'list', 'id']);
    },
  };
}

let builtinDone = false;
/** Register the built-in music-site detectors. Idempotent. */
export function registerBuiltinWebPageProviders(): void {
  if (builtinDone && plugins.size > 0) return;
  builtinDone = true;
  registerWebPageProvider(
    genericSongPlugin('jiosaavn', 'JioSaavn', ['jiosaavn.com', 'saavn.com']),
  );
  registerWebPageProvider(
    genericSongPlugin('spotify', 'Spotify', ['open.spotify.com', 'spotify.com']),
  );
  registerWebPageProvider(
    genericSongPlugin('youtube-music-web', 'YouTube Music', ['music.youtube.com', 'youtube.com', 'youtu.be']),
  );
  registerWebPageProvider(
    genericSongPlugin('soundcloud', 'SoundCloud', ['soundcloud.com']),
  );
  registerWebPageProvider(
    genericSongPlugin('bandcamp', 'Bandcamp', ['bandcamp.com']),
  );
  registerWebPageProvider(
    genericSongPlugin('audius', 'Audius', ['audius.co']),
  );
  registerWebPageProvider({
    webProviderId: 'musicbrainz',
    displayName: 'MusicBrainz',
    hostSuffixes: ['musicbrainz.org'],
    detect(url: URL): WebPageKind | null {
      const path = url.pathname.toLowerCase();
      if (path.includes('/recording/')) return 'song';
      if (path.includes('/release/')) return 'album';
      if (path.includes('/artist/')) return 'artist';
      return null;
    },
    extractId(url: URL): string | null {
      return lastPathSegment(url);
    },
    canonicalize(url: URL): string {
      return stripTrackingParams(url);
    },
  });
  registerWebPageProvider({
    webProviderId: 'apple-music',
    displayName: 'Apple Music',
    hostSuffixes: ['music.apple.com', 'itunes.apple.com'],
    detect(url: URL): WebPageKind | null {
      // Public catalog pages: /<storefront>/song|album|artist/<slug>/<id>.
      const path = url.pathname.toLowerCase();
      if (path.includes('/song/')) return 'song';
      if (path.includes('/album/')) return 'album';
      if (path.includes('/artist/')) return 'artist';
      if (path.includes('/playlist/') || path.includes('/music-video/')) return 'playlist';
      return null;
    },
    extractId(url: URL): string | null {
      // Apple Music ids trail the slug: .../<slug>/<numeric-id>[?i=...].
      const direct = url.searchParams.get('i');
      if (direct && /^\d{1,24}$/.test(direct)) return direct;
      const last = lastPathSegment(url);
      if (last && /^\d{1,24}$/.test(last)) return last;
      return last;
    },
    canonicalize(url: URL): string {
      // Preserve `i=` (song within album page); strip tracking params.
      return stripTrackingParams(url, ['i']);
    },
  });
}

export function __resetBuiltinWebPageProvidersForTests(): void {
  builtinDone = false;
}
