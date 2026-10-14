// Live Web Discovery — public page metadata extraction.
//
// Layered strategy (prefer structured, fail gracefully):
//   1. JSON-LD (MusicRecording / AudioObject / MusicAlbum)
//   2. OpenGraph / music:* meta tags
//   3. standard <title> + meta description
//   4. provider-specific hints (passed in by the resolver)
//
// Static string parsing only — never executes page JavaScript.
// All helpers are pure (html string in, metadata out) and bounded.

import type { PageMetadata } from './types';

const MAX_HTML_BYTES = 512_000;
const MAX_JSONLD_BLOCKS = 8;

function truncateHtml(html: string): string {
  if (html.length <= MAX_HTML_BYTES) return html;
  return html.slice(0, MAX_HTML_BYTES);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return '';
      }
    })
    .trim();
}

function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  // Tolerate attribute order: property/name before or after content.
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(
    `<meta[^>]*${attr}=["']${esc}["'][^>]*content=["']([^"']{1,500})["'][^>]*>`,
    'i',
  );
  const m1 = re1.exec(html);
  if (m1?.[1]) return decodeEntities(m1[1]);
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']{1,500})["'][^>]*${attr}=["']${esc}["'][^>]*>`,
    'i',
  );
  const m2 = re2.exec(html);
  return m2?.[1] ? decodeEntities(m2[1]) : null;
}

function titleTag(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  return m?.[1] ? decodeEntities(m[1]) : null;
}

function canonicalLink(html: string): string | null {
  const m = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']{1,2048})["'][^>]*>/i.exec(html);
  if (m?.[1]) return m[1].trim();
  const m2 = /<link[^>]*href=["']([^"']{1,2048})["'][^>]*rel=["']canonical["'][^>]*>/i.exec(html);
  return m2?.[1] ? m2[1].trim() : null;
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]{1,60000}?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(html)) !== null && count < MAX_JSONLD_BLOCKS) {
    count += 1;
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed.slice(0, 4));
      else out.push(parsed);
    } catch {
      // Malformed JSON-LD is ignored — next layer handles it.
    }
  }
  return out;
}

function pickJsonLd(node: unknown): Partial<PageMetadata> | null {
  if (!node || typeof node !== 'object') return null;
  const o = node as Record<string, unknown>;
  const type = Array.isArray(o['@type']) ? String(o['@type'][0] ?? '') : String(o['@type'] ?? '');
  if (!/musicrecording|audioobject|musicalbum|musicplaylist|song/i.test(type)) {
    // Still accept generic CreativeWork with name + byArtist.
    if (typeof o.name !== 'string') return null;
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined;
  const byArtist = o.byArtist ?? o.artist ?? o.creator;
  let artist: string | undefined;
  if (typeof byArtist === 'string') artist = str(byArtist);
  else if (Array.isArray(byArtist)) {
    const names = byArtist
      .map((a) => (typeof a === 'string' ? a : (a as Record<string, unknown>)?.name))
      .filter((n): n is string => typeof n === 'string' && !!n.trim());
    if (names.length > 0) artist = names.join(', ').slice(0, 300);
  } else if (byArtist && typeof byArtist === 'object') {
    artist = str((byArtist as Record<string, unknown>).name);
  }
  const inAlbum = o.inAlbum ?? o.album;
  let album: string | undefined;
  if (typeof inAlbum === 'string') album = str(inAlbum);
  else if (inAlbum && typeof inAlbum === 'object') {
    album = str((inAlbum as Record<string, unknown>).name);
  }
  let durationMs: number | undefined;
  const dur = o.duration;
  if (typeof dur === 'string') {
    // ISO 8601 PT5M46S or plain seconds.
    const iso = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/i.exec(dur);
    if (iso) {
      const h = Number(iso[1] ?? 0);
      const m = Number(iso[2] ?? 0);
      const s = Number(iso[3] ?? 0);
      if (h || m || s) durationMs = Math.round((h * 3600 + m * 60 + s) * 1000);
    } else {
      const secs = Number(dur);
      if (Number.isFinite(secs) && secs > 0 && secs < 86400) durationMs = Math.round(secs * 1000);
    }
  } else if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) {
    durationMs = dur > 86400 ? Math.round(dur) : Math.round(dur * 1000);
  }
  const image = o.image ?? o.thumbnailUrl;
  let artwork: string | undefined;
  if (typeof image === 'string') artwork = image.slice(0, 2048);
  else if (Array.isArray(image) && typeof image[0] === 'string') artwork = (image[0] as string).slice(0, 2048);
  else if (image && typeof image === 'object') {
    const u = (image as Record<string, unknown>).url;
    if (typeof u === 'string') artwork = u.slice(0, 2048);
  }
  const title = str(o.name ?? o.headline);
  if (!title && !artist) return null;
  return { title, artist, album, durationMs, artwork };
}

function splitTitleArtist(raw: string): { title?: string; artist?: string } {
  // Common pattern: "Title - Artist" or "Title | Artist" or "Title by Artist".
  const by = raw.split(/\s+by\s+/i);
  if (by.length === 2 && by[0].trim() && by[1].trim()) {
    return { title: by[0].trim().slice(0, 300), artist: by[1].trim().slice(0, 300) };
  }
  for (const sep of [' - ', ' – ', ' — ', ' | ', ' / ']) {
    const i = raw.indexOf(sep);
    if (i > 0 && i + sep.length < raw.length) {
      const a = raw.slice(0, i).trim();
      const b = raw.slice(i + sep.length).trim();
      if (a && b) return { title: a.slice(0, 300), artist: b.slice(0, 300) };
    }
  }
  return { title: raw.trim().slice(0, 300) };
}

function parseDurationText(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  // "5:46" or "05:46" or seconds.
  const mmss = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (mmss) {
    if (mmss[3]) {
      const h = Number(mmss[1]);
      const m = Number(mmss[2]);
      const sec = Number(mmss[3]);
      if (h < 24 && m < 60 && sec < 60) return ((h * 60 + m) * 60 + sec) * 1000;
      return undefined;
    }
    const m = Number(mmss[1]);
    const sec = Number(mmss[2]);
    if (m < 600 && sec < 60) return (m * 60 + sec) * 1000;
    return undefined;
  }
  const secs = Number(s);
  if (Number.isFinite(secs) && secs > 0 && secs < 86400) return Math.round(secs * 1000);
  return undefined;
}

/**
 * Extract public metadata from a page's HTML. Pure, bounded, never throws.
 * Returns null when nothing usable is found (caller discards the result).
 */
export function extractPageMetadata(
  html: string,
  pageUrl: string,
  opts: { site?: string; providerId?: string } = {},
): PageMetadata | null {
  try {
    if (!html || typeof html !== 'string' || html.length < 32) return null;
    const doc = truncateHtml(html);

    // Layer 1: JSON-LD.
    for (const block of jsonLdBlocks(doc)) {
      const picked = pickJsonLd(block);
      if (picked && (picked.title || picked.artist)) {
        return {
          title: picked.title,
          artist: picked.artist,
          album: picked.album,
          durationMs: picked.durationMs,
          artwork: picked.artwork,
          canonicalUrl: canonicalLink(doc) ?? pageUrl,
          site: opts.site,
          providerId: opts.providerId,
          rawSource: 'json-ld',
        };
      }
      // @graph containers.
      if (block && typeof block === 'object' && Array.isArray((block as Record<string, unknown>)['@graph'])) {
        for (const node of (block as Record<string, { node: unknown }>)['@graph'] as unknown as unknown[]) {
          const inner = pickJsonLd(node);
          if (inner && (inner.title || inner.artist)) {
            return {
              title: inner.title,
              artist: inner.artist,
              album: inner.album,
              durationMs: inner.durationMs,
              artwork: inner.artwork,
              canonicalUrl: canonicalLink(doc) ?? pageUrl,
              site: opts.site,
              providerId: opts.providerId,
              rawSource: 'json-ld',
            };
          }
        }
      }
    }

    // Layer 2: OpenGraph / music:* tags.
    const ogTitle = metaContent(doc, 'property', 'og:title');
    const ogAudioArtist =
      metaContent(doc, 'property', 'music:musician') ??
      metaContent(doc, 'property', 'music:creator') ??
      metaContent(doc, 'name', 'author');
    const ogAlbum = metaContent(doc, 'property', 'music:album');
    const ogImage = metaContent(doc, 'property', 'og:image');
    const ogDuration =
      metaContent(doc, 'property', 'music:duration') ??
      metaContent(doc, 'name', 'duration');
    const ogUrl = metaContent(doc, 'property', 'og:url');
    if (ogTitle || ogAudioArtist) {
      const split = ogTitle && !ogAudioArtist ? splitTitleArtist(ogTitle) : null;
      return {
        title: split?.title ?? ogTitle ?? undefined,
        artist: ogAudioArtist ?? split?.artist,
        album: ogAlbum ?? undefined,
        durationMs: parseDurationText(ogDuration),
        artwork: ogImage ?? undefined,
        canonicalUrl: ogUrl ?? canonicalLink(doc) ?? pageUrl,
        site: opts.site,
        providerId: opts.providerId,
        rawSource: 'opengraph',
      };
    }

    // Layer 3: standard meta + <title>.
    const metaTitle = metaContent(doc, 'name', 'title') ?? metaContent(doc, 'property', 'title');
    const metaDesc = metaContent(doc, 'name', 'description') ?? metaContent(doc, 'property', 'og:description');
    const tag = titleTag(doc);
    const best = metaTitle ?? tag;
    if (best) {
      const split = splitTitleArtist(best);
      // Require at least a plausible title (avoid nav chrome like "Home").
      if (split.title && split.title.length >= 2) {
        return {
          title: split.title,
          artist: split.artist,
          album: undefined,
          durationMs: undefined,
          artwork: metaContent(doc, 'property', 'og:image') ?? undefined,
          canonicalUrl: canonicalLink(doc) ?? pageUrl,
          site: opts.site,
          providerId: opts.providerId,
          rawSource: 'meta',
        };
      }
    }
    void metaDesc;
    return null;
  } catch {
    return null;
  }
}
