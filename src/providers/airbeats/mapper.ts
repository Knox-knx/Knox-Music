// AirBeats → KNOX mapping. Every field comes from the observed live API
// contract (see types.ts) — nothing is invented. Missing/empty values follow
// the existing KNOX conventions ('Untitled', 'Unknown artist', undefined).

import type { Album, Artist, Playlist, Song } from '../../core/types';
import {
  AIRBEATS_LICENSE_FALLBACK,
  AIRBEATS_PROVIDER_ID,
  type AirbeatsAlbumDetail,
  type AirbeatsAlbumResult,
  type AirbeatsArtistDetail,
  type AirbeatsArtistResult,
  type AirbeatsDownloadVariant,
  type AirbeatsImage,
  type AirbeatsPlaylistDetail,
  type AirbeatsPlaylistResult,
  type AirbeatsSong,
} from './types';

/** Decode HTML entities the API embeds in display strings (e.g. `&quot;`). */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanStr(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? decodeEntities(v).trim() : '';
  return s || fallback;
}

function cleanOpt(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

function cleanYear(v: unknown): number | undefined {
  const n = typeof v === 'number' ? Math.trunc(v) : Number(String(v ?? '').slice(0, 4));
  return Number.isFinite(n) && n > 1000 && n < 2200 ? n : undefined;
}

/** API reports duration in SECONDS (verified) → KNOX durationMs. */
export function airbeatsDurationMs(v: unknown): number {
  const secs = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.round(secs * 1000);
}

/** Prefer the largest artwork (500x500), then 150x150, then 50x50. */
export function pickArtwork(images: AirbeatsImage[] | undefined): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const byQuality = (q: string): string | undefined => {
    const hit = images.find((i) => i?.quality === q && typeof i.url === 'string' && i.url.trim());
    return hit?.url?.trim() || undefined;
  };
  return (
    byQuality('500x500') ||
    byQuality('150x150') ||
    byQuality('50x50') ||
    cleanOpt(images.find((i) => typeof i?.url === 'string' && i.url.trim())?.url)
  );
}

function qualityRank(q: string): number {
  const m = /^(\d+)\s*kbps$/i.exec(q.trim());
  return m ? Number(m[1]) : -1;
}

/**
 * Pick the best playable file: highest kbps variant with a usable URL.
 * Observed tiers ascend 12kbps → 320kbps; selection is by parsed bitrate,
 * never by array position, so tier changes/drift stay safe.
 */
export function pickStreamUrl(variants: AirbeatsDownloadVariant[] | undefined): string | undefined {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  let best: string | undefined;
  let bestRank = -1;
  for (const v of variants) {
    const url = typeof v?.url === 'string' ? v.url.trim() : '';
    if (!url) continue;
    const rank = qualityRank(typeof v?.quality === 'string' ? v.quality : '');
    const score = rank >= 0 ? rank : 0;
    if (best === undefined || score > bestRank) {
      best = url;
      bestRank = score;
    }
  }
  return best;
}

/** Primary artist names joined; falls back across featured/all like the API groups them. */
export function artistNames(t: Pick<AirbeatsSong, 'artists'>): string {
  const groups = t.artists;
  const primary = (groups?.primary ?? []).map((a) => a?.name?.trim()).filter(Boolean) as string[];
  if (primary.length > 0) return primary.join(', ');
  const featured = (groups?.featured ?? []).map((a) => a?.name?.trim()).filter(Boolean) as string[];
  if (featured.length > 0) return featured.join(', ');
  const all = (groups?.all ?? []).map((a) => a?.name?.trim()).filter(Boolean) as string[];
  if (all.length > 0) return all[0];
  return 'Unknown artist';
}

function firstArtistId(t: Pick<AirbeatsSong, 'artists'>): string | undefined {
  const groups = t.artists;
  const pick = (list: { id?: string }[] | undefined): string | undefined => {
    const hit = (list ?? []).find((a) => typeof a?.id === 'string' && a.id.trim());
    return hit?.id?.trim() || undefined;
  };
  return pick(groups?.primary) ?? pick(groups?.featured) ?? pick(groups?.all);
}

export function mapAirbeatsSong(t: AirbeatsSong): Song | null {
  if (!t || typeof t !== 'object') return null;
  const rawId = typeof t.id === 'string' ? t.id.trim() : '';
  if (!rawId) return null; // unaddressable — never invent an id
  const streamUrl = pickStreamUrl(t.downloadUrl);
  const title = cleanStr(t.name, 'Untitled');
  const artist = artistNames(t);
  if (!title.trim() || !artist.trim()) return null;
  const artistId = firstArtistId(t);
  const albumId = cleanOpt(t.album?.id);
  return {
    id: `${AIRBEATS_PROVIDER_ID}:${rawId}`,
    providerId: AIRBEATS_PROVIDER_ID,
    providerTrackId: rawId,
    title,
    artist,
    artistId: artistId ? `${AIRBEATS_PROVIDER_ID}:artist:${artistId}` : undefined,
    album: cleanStr(t.album?.name, ''),
    albumId: albumId ? `${AIRBEATS_PROVIDER_ID}:album:${albumId}` : undefined,
    durationMs: airbeatsDurationMs(t.duration),
    artworkUrl: pickArtwork(t.image),
    // The API explicitly names these "downloadUrl" tiers (12–320kbps) and
    // serves stable full-length audio/mp4 blobs (verified via HEAD:
    // audio/mp4, Accept-Ranges, CORS *). Streaming AND downloading are both
    // explicitly supported by the provider contract.
    streamUrl: streamUrl || undefined,
    downloadUrl: streamUrl || undefined,
    downloadAllowed: Boolean(streamUrl),
    genre: undefined, // API reports `language`, never a genre — never conflate
    year: cleanYear(t.year),
    license: cleanOpt(t.copyright) ?? AIRBEATS_LICENSE_FALLBACK,
    sourceUrl: cleanOpt(t.url),
    capabilities: {
      searchable: true,
      streamable: Boolean(streamUrl),
      downloadable: Boolean(streamUrl),
      offline: Boolean(streamUrl),
      previewOnly: false, // full-length recordings, never previews
    },
    addedAt: Date.now(),
  };
}

export function mapAirbeatsSongs(list: unknown): Song[] {
  if (!Array.isArray(list)) return [];
  const out: Song[] = [];
  for (const item of list) {
    try {
      const s = mapAirbeatsSong(item as AirbeatsSong);
      if (s) out.push(s);
    } catch {
      continue; // malformed entries never break the batch
    }
  }
  return out;
}

export function mapAirbeatsArtist(a: AirbeatsArtistResult | AirbeatsArtistDetail): Artist | null {
  if (!a || typeof a !== 'object') return null;
  const rawId = cleanOpt(a.id);
  const name = cleanStr(a.name, '');
  if (!rawId || !name) return null;
  const detail = a as AirbeatsArtistDetail;
  const bio = Array.isArray(detail.bio)
    ? detail.bio
        .map((b) => (typeof b?.text === 'string' ? b.text.trim() : ''))
        .filter(Boolean)
        .join('\n\n') || undefined
    : undefined;
  return {
    id: `${AIRBEATS_PROVIDER_ID}:artist:${rawId}`,
    providerId: AIRBEATS_PROVIDER_ID,
    providerArtistId: rawId,
    name,
    artworkUrl: pickArtwork(a.image),
    bio,
  };
}

export function mapAirbeatsAlbum(a: AirbeatsAlbumResult | AirbeatsAlbumDetail): Album | null {
  if (!a || typeof a !== 'object') return null;
  const rawId = cleanOpt(a.id);
  const title = cleanStr(a.name, '');
  if (!rawId || !title) return null;
  const primary = a.artists && 'primary' in a.artists && Array.isArray((a.artists as { primary?: unknown }).primary)
    ? ((a.artists as unknown as { primary: { id?: string; name?: string }[] }).primary ?? [])
    : [];
  const firstName = primary.map((x) => x?.name?.trim()).find(Boolean);
  const firstId = primary.map((x) => (typeof x?.id === 'string' ? x.id.trim() : '')).find(Boolean);
  const detail = a as AirbeatsAlbumDetail;
  return {
    id: `${AIRBEATS_PROVIDER_ID}:album:${rawId}`,
    providerId: AIRBEATS_PROVIDER_ID,
    providerAlbumId: rawId,
    title,
    artist: firstName ?? '',
    artistId: firstId ? `${AIRBEATS_PROVIDER_ID}:artist:${firstId}` : undefined,
    year: cleanYear(a.year),
    artworkUrl: pickArtwork(a.image),
    trackCount: typeof detail.songCount === 'number' && detail.songCount > 0 ? detail.songCount : undefined,
  };
}

export function mapAirbeatsPlaylist(p: AirbeatsPlaylistResult | AirbeatsPlaylistDetail): Playlist | null {
  if (!p || typeof p !== 'object') return null;
  const rawId = cleanOpt(p.id);
  const name = cleanStr(p.name, '');
  if (!rawId || !name) return null;
  const now = Date.now();
  const detail = p as AirbeatsPlaylistDetail;
  const songs = Array.isArray(detail.songs) ? mapAirbeatsSongs(detail.songs) : [];
  return {
    id: `${AIRBEATS_PROVIDER_ID}:playlist:${rawId}`,
    name,
    description: cleanOpt(detail.description),
    coverUrl: pickArtwork(p.image),
    createdAt: now,
    updatedAt: now,
    trackIds: songs.map((s) => s.id),
    isUserPlaylist: false,
    providerId: AIRBEATS_PROVIDER_ID,
    providerPlaylistId: rawId,
  };
}
