import { extractPageMetadata } from '../../discovery/metadataExtractor';
import { stripTrackingParams } from '../../discovery/providerDetector';
import { validateDiscoveryUrl } from '../../discovery/ssrfGuard';
import type { PageMetadata, TrackReference } from '../../discovery/types';
import {
  JIOSAAVN_PROVIDER_ID,
  JIOSAAVN_PROVIDER_NAME,
  type JioSaavnAlbumMetadata,
  type JioSaavnArtistMetadata,
  type JioSaavnPageKind,
  type JioSaavnPlaylistMetadata,
  type JioSaavnTrackMetadata,
} from './types';

export const JIOSAAVN_HOSTS = ['jiosaavn.com', 'www.jiosaavn.com', 'saavn.com', 'www.saavn.com'] as const;
export const JIOSAAVN_PUBLIC_API_URL = 'https://www.jiosaavn.com/api.php';

const SAFE_TOKEN_RE = /^[A-Za-z0-9_-]{2,64}$/;

export function isJioSaavnHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return h === 'jiosaavn.com' || h.endsWith('.jiosaavn.com') || h === 'saavn.com' || h.endsWith('.saavn.com');
}

/**
 * Detect the JioSaavn page kind and opaque token from a public URL.
 */
export function detectJioSaavnUrl(rawUrl: string): {
  kind: JioSaavnPageKind;
  token: string | null;
  canonicalUrl: string;
} | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isJioSaavnHost(u.hostname)) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return null;

  const lowerSegs = segs.map((s) => s.toLowerCase());
  let kind: JioSaavnPageKind = 'unknown';
  if (lowerSegs.includes('song') || lowerSegs.includes('track')) kind = 'song';
  else if (lowerSegs.includes('album')) kind = 'album';
  else if (lowerSegs.includes('artist')) kind = 'artist';
  else if (lowerSegs.includes('playlist') || lowerSegs.includes('featured')) kind = 'playlist';
  else if (segs.length < 2) return null;

  const last = segs[segs.length - 1] ?? null;
  const token = last && SAFE_TOKEN_RE.test(last) ? last : null;
  const canonicalUrl = stripTrackingParams(u);
  return { kind, token, canonicalUrl };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function upscaleJioSaavnImage(url: string | undefined): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/(\b|_)(50x50|150x150)(\b|\.)/g, '$1500x500$3');
}

/**
 * Upgrade a JioSaavn preview URL (`preview.saavncdn.com/..._96_p.mp4`) to a
 * full-length AAC CDN stream URL (`aac.saavncdn.com/..._320.mp4`).
 */
export function resolveJioSaavnStreamUrl(
  previewOrStreamUrl?: string,
  preferredBitrate: '320' | '160' | '96' = '320',
): string | undefined {
  if (!previewOrStreamUrl || typeof previewOrStreamUrl !== 'string') return undefined;
  const trimmed = previewOrStreamUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed
    .replace(/^http:\/\//i, 'https://')
    .replace('//preview.saavncdn.com/', '//aac.saavncdn.com/')
    .replace('//h.saavncdn.com/', '//aac.saavncdn.com/')
    .replace(/_96_p\.mp4(\?.*)?$/i, `_${preferredBitrate}.mp4`)
    .replace(/_(96|160|320)\.mp4(\?.*)?$/i, `_${preferredBitrate}.mp4`);
}

export const upgradeSaavnAudioUrl = resolveJioSaavnStreamUrl;

// ---------------------------------------------------------------------------
// Pure TypeScript DES-ECB Decryption for JioSaavn `encrypted_media_url`
// Key: "38346591" (8 ASCII bytes), Mode: ECB, Padding: PKCS#5/PKCS#7
// ---------------------------------------------------------------------------

const DES_IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const DES_FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const DES_E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9,
  8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const DES_P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

const DES_PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

const DES_PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const DES_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const DES_SBOX: number[][][] = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
];

function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) {
      bits.push((bytes[i] >> b) & 1);
    }
  }
  return bits;
}

function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length >>> 3);
  for (let i = 0; i < out.length; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | (bits[i * 8 + b] & 1);
    }
    out[i] = val;
  }
  return out;
}

function permuteBits(bits: number[], table: number[]): number[] {
  const out = new Array<number>(table.length);
  for (let i = 0; i < table.length; i++) {
    out[i] = bits[table[i] - 1];
  }
  return out;
}

function generateDesSubkeys(keyStr: string): number[][] {
  const keyBytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) keyBytes[i] = keyStr.charCodeAt(i) & 0xff;
  const keyBits = permuteBits(bytesToBits(keyBytes), DES_PC1);
  let c = keyBits.slice(0, 28);
  let d = keyBits.slice(28, 56);
  const subkeys: number[][] = [];
  for (let round = 0; round < 16; round++) {
    const s = DES_SHIFTS[round];
    c = c.slice(s).concat(c.slice(0, s));
    d = d.slice(s).concat(d.slice(0, s));
    subkeys.push(permuteBits(c.concat(d), DES_PC2));
  }
  return subkeys;
}

const SAAVN_DES_SUBKEYS_REV = generateDesSubkeys('38346591').reverse();

function desDecryptBlock(blockBits: number[], subkeysRev: number[][]): number[] {
  const ip = permuteBits(blockBits, DES_IP);
  let l = ip.slice(0, 32);
  let r = ip.slice(32, 64);
  for (let round = 0; round < 16; round++) {
    const k = subkeysRev[round];
    const er = permuteBits(r, DES_E);
    const xored = new Array<number>(48);
    for (let i = 0; i < 48; i++) xored[i] = er[i] ^ k[i];
    const sboxOut: number[] = [];
    for (let box = 0; box < 8; box++) {
      const offset = box * 6;
      const row = (xored[offset] << 1) | xored[offset + 5];
      const col =
        (xored[offset + 1] << 3) |
        (xored[offset + 2] << 2) |
        (xored[offset + 3] << 1) |
        xored[offset + 4];
      const val = DES_SBOX[box][row][col];
      sboxOut.push((val >> 3) & 1, (val >> 2) & 1, (val >> 1) & 1, val & 1);
    }
    const f = permuteBits(sboxOut, DES_P);
    const nextR = new Array<number>(32);
    for (let i = 0; i < 32; i++) nextR[i] = l[i] ^ f[i];
    l = r;
    r = nextR;
  }
  return permuteBits(r.concat(l), DES_FP);
}

function decodeBase64ToBytes(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/[\r\n\s]/g, '');
    if (!clean || clean.length < 16) return null;
    if (typeof atob === 'function') {
      const bin = atob(clean);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decrypt JioSaavn `more_info.encrypted_media_url` (DES-ECB, key "38346591")
 * and upgrade it to the requested AAC bitrate (`320` / `160` / `96`).
 */
export function decryptJioSaavnMediaUrl(
  encryptedMediaUrl?: string,
  preferredBitrate: '320' | '160' | '96' = '320',
): string | undefined {
  if (!encryptedMediaUrl || typeof encryptedMediaUrl !== 'string') return undefined;
  const cipherBytes = decodeBase64ToBytes(encryptedMediaUrl.trim());
  if (!cipherBytes || cipherBytes.length < 16 || cipherBytes.length % 8 !== 0) return undefined;

  const plainBytes = new Uint8Array(cipherBytes.length);
  for (let offset = 0; offset < cipherBytes.length; offset += 8) {
    const block = cipherBytes.subarray(offset, offset + 8);
    const decBits = desDecryptBlock(bytesToBits(block), SAAVN_DES_SUBKEYS_REV);
    plainBytes.set(bitsToBytes(decBits), offset);
  }

  // Strip PKCS#5/PKCS#7 padding or trailing control characters
  let end = plainBytes.length;
  const lastByte = plainBytes[end - 1];
  if (lastByte >= 1 && lastByte <= 8) {
    let validPad = true;
    for (let i = end - lastByte; i < end; i++) {
      if (plainBytes[i] !== lastByte) {
        validPad = false;
        break;
      }
    }
    if (validPad) end -= lastByte;
  }
  while (end > 0 && (plainBytes[end - 1] <= 0x20 || plainBytes[end - 1] >= 0x7f)) {
    end--;
  }

  let decoded = '';
  for (let i = 0; i < end; i++) {
    decoded += String.fromCharCode(plainBytes[i]);
  }
  const trimmed = decoded.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return resolveJioSaavnStreamUrl(trimmed, preferredBitrate);
}

/**
 * Clean JioSaavn's standard page title suffixes:
 * e.g. "Song Name - Artist Name - Download or Listen Free on JioSaavn"
 */
export function cleanJioSaavnTitle(rawTitle: string): { title: string; artist?: string } {
  const stripped = decodeHtmlEntities(rawTitle)
    .replace(/\s*[-|–—]\s*(?:Download|Listen|Play|Watch|JioSaavn|Saavn).*$/i, '')
    .replace(/\s*\((?:Full\s+Song|Mp3|Audio)\).*$/i, '')
    .trim();
  const byMatch = stripped.split(/\s+by\s+/i);
  if (byMatch.length === 2 && byMatch[0].trim() && byMatch[1].trim()) {
    return { title: byMatch[0].trim(), artist: byMatch[1].trim() };
  }
  const dashIdx = stripped.indexOf(' - ');
  if (dashIdx > 0 && dashIdx + 3 < stripped.length) {
    return {
      title: stripped.slice(0, dashIdx).trim(),
      artist: stripped.slice(dashIdx + 3).trim(),
    };
  }
  return { title: stripped };
}

/**
 * Parse a public JioSaavn HTML page into structured PageMetadata.
 */
export function parseJioSaavnPageHtml(html: string, pageUrl: string): PageMetadata | null {
  const detected = detectJioSaavnUrl(pageUrl);
  const canonical = detected?.canonicalUrl ?? pageUrl;
  const base = extractPageMetadata(html, canonical, {
    site: JIOSAAVN_PROVIDER_NAME,
    providerId: detected?.token ?? undefined,
  });
  if (!base) return null;

  const cleaned = base.title ? cleanJioSaavnTitle(base.title) : null;
  return {
    ...base,
    title: cleaned?.title || base.title,
    artist: base.artist || cleaned?.artist,
    artwork: upscaleJioSaavnImage(base.artwork) ?? base.artwork,
    canonicalUrl: base.canonicalUrl ?? canonical,
    site: JIOSAAVN_PROVIDER_NAME,
    providerId: detected?.token ?? base.providerId,
  };
}

/**
 * Fetch and parse a public JioSaavn page into a normalized TrackReference.
 */
export async function scrapeJioSaavnPageReference(
  rawUrl: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<TrackReference | null> {
  const verdict = validateDiscoveryUrl(rawUrl);
  if (!verdict.ok || !verdict.url) return null;
  const detected = detectJioSaavnUrl(verdict.url);
  if (!detected) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    const res = await doFetch(verdict.url, {
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = parseJioSaavnPageHtml(html, detected.canonicalUrl);
    if (!meta || (!meta.title && !meta.artist)) return null;

    return {
      provider: JIOSAAVN_PROVIDER_ID,
      providerId: detected.token ?? meta.providerId,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      durationMs: meta.durationMs,
      artwork: meta.artwork,
      canonicalUrl: meta.canonicalUrl ?? detected.canonicalUrl,
      originalDiscoveredUrl: rawUrl,
      sourceType: 'web',
      origin: 'web',
      playable: true,
      downloadable: true,
      cacheable: true,
      site: JIOSAAVN_PROVIDER_NAME,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function parseRawTrackRecord(raw: Record<string, unknown>): JioSaavnTrackMetadata | null {
  const id = String(raw.id ?? '').trim();
  const title = decodeHtmlEntities(String(raw.title ?? raw.song ?? '').trim());
  if (!id || !title) return null;

  const moreInfo = (raw.more_info && typeof raw.more_info === 'object' ? raw.more_info : {}) as Record<string, unknown>;
  const artistMap = (moreInfo.artistMap && typeof moreInfo.artistMap === 'object'
    ? moreInfo.artistMap
    : {}) as Record<string, unknown>;
  const primaryArtistsArr = Array.isArray(artistMap.primary_artists)
    ? (artistMap.primary_artists as Record<string, unknown>[])
    : [];

  const artistNames = primaryArtistsArr
    .map((a) => decodeHtmlEntities(String(a?.name ?? '').trim()))
    .filter(Boolean);
  const fallbackArtist = decodeHtmlEntities(
    String(
      moreInfo.music ??
        moreInfo.primary_artists ??
        raw.primary_artists ??
        raw.primaryArtists ??
        raw.artist ??
        raw.subtitle ??
        '',
    ).trim(),
  );
  const artist = artistNames.join(', ') || fallbackArtist || 'Unknown artist';

  const album = decodeHtmlEntities(String(moreInfo.album ?? raw.album ?? '').trim());
  const albumId = String(moreInfo.album_id ?? raw.albumid ?? '').trim() || undefined;
  const durRaw = Number(moreInfo.duration ?? raw.duration ?? 0);
  const durationSec = Number.isFinite(durRaw) && durRaw > 0 ? Math.round(durRaw) : undefined;
  const yearRaw = Number(raw.year ?? moreInfo.year ?? 0);
  const year = Number.isFinite(yearRaw) && yearRaw > 1000 && yearRaw < 2200 ? Math.trunc(yearRaw) : undefined;
  const artworkUrl = upscaleJioSaavnImage(String(raw.image ?? raw.artworkUrl ?? '').trim() || undefined);
  const url = String(raw.perma_url ?? moreInfo.perma_url ?? raw.url ?? '').trim() || `https://www.jiosaavn.com/song/_/${id}`;

  const rawPreview =
    typeof raw.streamUrl === 'string' && raw.streamUrl
      ? raw.streamUrl
      : typeof moreInfo.media_preview_url === 'string' && moreInfo.media_preview_url
        ? moreInfo.media_preview_url
        : typeof raw.media_preview_url === 'string' && raw.media_preview_url
          ? raw.media_preview_url
          : typeof moreInfo.vlink === 'string' && moreInfo.vlink
            ? moreInfo.vlink
            : undefined;
  const is320 = String(moreInfo['320kbps'] ?? raw['320kbps'] ?? 'true').toLowerCase() !== 'false';
  const preferredBitrate =
    durationSec && durationSec >= 1500
      ? '96'
      : durationSec && durationSec >= 900
        ? '160'
        : is320
          ? '320'
          : '160';
  const encryptedMediaUrl =
    typeof moreInfo.encrypted_media_url === 'string' && moreInfo.encrypted_media_url
      ? moreInfo.encrypted_media_url
      : typeof raw.encrypted_media_url === 'string' && raw.encrypted_media_url
        ? raw.encrypted_media_url
        : undefined;
  const decryptedUrl = decryptJioSaavnMediaUrl(encryptedMediaUrl, preferredBitrate);
  const streamUrl = decryptedUrl ?? resolveJioSaavnStreamUrl(rawPreview, preferredBitrate);

  return {
    id,
    title,
    subtitle: decodeHtmlEntities(String(raw.subtitle ?? '').trim()) || undefined,
    artist,
    artists: primaryArtistsArr
      .filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
      .map((a) => ({
        id: String(a.id),
        name: decodeHtmlEntities(String(a.name)),
        role: typeof a.role === 'string' ? a.role : undefined,
        url: typeof a.perma_url === 'string' ? a.perma_url : undefined,
      })),
    album: album || undefined,
    albumId,
    durationSec,
    year,
    language: typeof raw.language === 'string' ? raw.language : undefined,
    copyright: typeof moreInfo.copyright_text === 'string' ? decodeHtmlEntities(moreInfo.copyright_text) : undefined,
    artworkUrl,
    streamUrl,
    encryptedMediaUrl,
    url,
    hasLyrics: String(moreInfo.has_lyrics ?? raw.has_lyrics ?? '').toLowerCase() === 'true',
  };
}

/**
 * Search JioSaavn catalog metadata via the direct API, with fallback to the
 * in-app sidecar (`/api/jiosaavn/search`) or Tauri desktop proxy when CORS
 * blocks browser requests.
 */
export async function searchJioSaavnCatalog(
  query: string,
  opts: { limit?: number; page?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JioSaavnTrackMetadata[]> {
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 40));
  const page = Math.max(1, opts.page ?? 1);
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    __call: 'search.getResults',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    q,
    p: String(page),
    n: String(limit),
  });
  const targetUrl = `${JIOSAAVN_PUBLIC_API_URL}?${params.toString()}`;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);

  const parseList = (data: unknown): JioSaavnTrackMetadata[] => {
    if (Array.isArray(data)) {
      return data
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map(parseRawTrackRecord)
        .filter((t): t is JioSaavnTrackMetadata => t !== null);
    }
    const obj = (data && typeof data === 'object' ? data : {}) as { results?: unknown[]; data?: { results?: unknown[] } };
    const list = Array.isArray(obj.results)
      ? obj.results
      : Array.isArray(obj.data?.results)
        ? obj.data.results
        : [];
    const out: JioSaavnTrackMetadata[] = [];
    for (const item of list) {
      if (item && typeof item === 'object') {
        const parsed = parseRawTrackRecord(item as Record<string, unknown>);
        if (parsed) out.push(parsed);
      }
    }
    return out;
  };

  try {
    let primaryErr: unknown = null;
    try {
      const res = await doFetch(targetUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`JioSaavn metadata search failed (HTTP ${res.status})`);
      }
      const data = await res.json();
      return parseList(data);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      primaryErr = err;
    }

    // Fallback to in-app sidecar / desktop gateway only when not using a custom test fetchImpl
    if (!opts.fetchImpl) {
      try {
        const { proxyGetJson } = await import('../../desktop/localApi');
        const data = await proxyGetJson<unknown>('jiosaavn', targetUrl);
        if (data) {
          return parseList(data);
        }
      } catch {
        /* try sidecar next */
      }

      try {
        const { getYouTubeSidecarBaseUrl } = await import('../youtube/youtubeOffline');
        const baseUrl = await getYouTubeSidecarBaseUrl();
        const sidecarRes = await doFetch(
          `${baseUrl}/api/jiosaavn/search?q=${encodeURIComponent(q)}&limit=${limit}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (sidecarRes.ok) {
          const data = await sidecarRes.json();
          return parseList(data);
        }
      } catch {
        /* rethrow primary error below */
      }
    }

    throw primaryErr instanceof Error ? primaryErr : new Error('JioSaavn metadata search failed');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch metadata for a single JioSaavn track ID.
 */
export async function getJioSaavnTrackMetadata(
  trackId: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JioSaavnTrackMetadata | null> {
  const cleanId = (trackId ?? '').trim().replace(/^jiosaavn:/, '');
  if (!SAFE_TOKEN_RE.test(cleanId)) return null;
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    __call: 'song.getDetails',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    pids: cleanId,
  });
  const targetUrl = `${JIOSAAVN_PUBLIC_API_URL}?${params.toString()}`;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  const parseDetails = (data: Record<string, unknown>): JioSaavnTrackMetadata | null => {
    const songsArr = Array.isArray(data.songs) ? data.songs : null;
    const rawSong = (songsArr?.[0] ?? data[cleanId] ?? data) as Record<string, unknown> | undefined;
    if (!rawSong || typeof rawSong !== 'object') return null;
    return parseRawTrackRecord(rawSong);
  };

  try {
    try {
      const res = await doFetch(targetUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        return parseDetails(data);
      }
    } catch {
      /* try fallbacks below */
    }

    if (!opts.fetchImpl) {
      try {
        const { proxyGetJson } = await import('../../desktop/localApi');
        const data = await proxyGetJson<Record<string, unknown>>('jiosaavn', targetUrl);
        if (data) {
          return parseDetails(data);
        }
      } catch {
        /* try sidecar next */
      }

      try {
        const { getYouTubeSidecarBaseUrl } = await import('../youtube/youtubeOffline');
        const baseUrl = await getYouTubeSidecarBaseUrl();
        const sidecarRes = await doFetch(
          `${baseUrl}/api/jiosaavn/track?id=${encodeURIComponent(cleanId)}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } },
        );
        if (sidecarRes.ok) {
          const data = (await sidecarRes.json()) as Record<string, unknown>;
          return parseDetails(data);
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch real-time related / station recommendations for a JioSaavn track ID
 * (using JioSaavn's `reco.getreco` endpoint + artist/vibe catalog enrichment).
 */
export async function fetchJioSaavnRecommendations(
  trackId: string,
  opts: {
    queryHint?: string;
    language?: string;
    limit?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<JioSaavnTrackMetadata[]> {
  const cleanId = (trackId ?? '').trim().replace(/^jiosaavn:/, '');
  const limit = Math.max(5, Math.min(opts.limit ?? 35, 60));
  const doFetch = opts.fetchImpl ?? fetch;
  const seen = new Set<string>([cleanId]);
  const out: JioSaavnTrackMetadata[] = [];

  const pushUnique = (items: JioSaavnTrackMetadata[]) => {
    for (const item of items) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= limit) break;
    }
  };

  if (SAFE_TOKEN_RE.test(cleanId)) {
    const params = new URLSearchParams({
      __call: 'reco.getreco',
      _format: 'json',
      _marker: '0',
      api_version: '4',
      ctx: 'web6dot0',
      pid: cleanId,
      language: opts.language || 'hindi,english,punjabi',
    });
    const recoUrl = `${JIOSAAVN_PUBLIC_API_URL}?${params.toString()}`;

    const parseReco = (data: unknown): JioSaavnTrackMetadata[] => {
      const list = Array.isArray(data)
        ? data
        : data && typeof data === 'object' && Array.isArray((data as { results?: unknown[] }).results)
          ? (data as { results: unknown[] }).results
          : [];
      return list
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map(parseRawTrackRecord)
        .filter((t): t is JioSaavnTrackMetadata => t !== null);
    };

    try {
      const res = await doFetch(recoUrl, {
        signal: opts.signal,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        pushUnique(parseReco(data));
      }
    } catch {
      /* fallback to proxy below */
    }

    if (out.length === 0 && !opts.fetchImpl) {
      try {
        const { proxyGetJson } = await import('../../desktop/localApi');
        const data = await proxyGetJson<unknown>('jiosaavn', recoUrl);
        if (data) {
          pushUnique(parseReco(data));
        }
      } catch {
        /* fallback to catalog search below */
      }
    }
  }

  // Enrich with artist / vibe catalog search if reco returned fewer than needed
  if (out.length < Math.min(20, limit)) {
    let seedMeta: JioSaavnTrackMetadata | null = null;
    if (!opts.queryHint && SAFE_TOKEN_RE.test(cleanId)) {
      try {
        seedMeta = await getJioSaavnTrackMetadata(cleanId, {
          signal: opts.signal,
          fetchImpl: opts.fetchImpl,
          timeoutMs: 5000,
        });
      } catch {
        /* ignore */
      }
    }
    const queries: string[] = [];
    if (opts.queryHint?.trim()) queries.push(opts.queryHint.trim());
    if (seedMeta?.artist && seedMeta.artist !== 'Unknown artist') {
      const primaryArtist = seedMeta.artist.split(',')[0].trim();
      if (primaryArtist) {
        queries.push(`${primaryArtist} hits`);
        queries.push(`${primaryArtist} songs`);
      }
    }
    if (seedMeta?.album) queries.push(seedMeta.album);
    if (seedMeta?.title) queries.push(`${seedMeta.title} ${seedMeta.artist ?? ''}`.trim());

    for (const q of queries) {
      if (out.length >= limit || opts.signal?.aborted) break;
      try {
        const rows = await searchJioSaavnCatalog(q, {
          limit: 25,
          signal: opts.signal,
          fetchImpl: opts.fetchImpl,
        });
        pushUnique(rows);
      } catch {
        /* continue */
      }
    }
  }

  return out.slice(0, limit);
}

function parseRawPlaylistRecord(raw: Record<string, unknown>): JioSaavnPlaylistMetadata | null {
  const id = String(raw.id ?? raw.listid ?? '').trim();
  const title = decodeHtmlEntities(String(raw.title ?? raw.listname ?? '').trim());
  if (!id || !title) return null;

  const moreInfo = (raw.more_info && typeof raw.more_info === 'object' ? raw.more_info : {}) as Record<string, unknown>;
  const countRaw = Number(moreInfo.song_count ?? raw.count ?? raw.list_count ?? 0);
  const trackCount = Number.isFinite(countRaw) && countRaw > 0 ? Math.trunc(countRaw) : undefined;
  const artworkUrl = upscaleJioSaavnImage(String(raw.image ?? raw.artworkUrl ?? '').trim() || undefined);
  const url = String(raw.perma_url ?? raw.url ?? '').trim() || `https://www.jiosaavn.com/featured/_/${id}`;
  const subtitle = decodeHtmlEntities(
    String(raw.subtitle ?? moreInfo.firstname ?? moreInfo.subtitle ?? '').trim(),
  ) || undefined;

  const rawList = Array.isArray(raw.list)
    ? raw.list
    : Array.isArray(raw.songs)
      ? raw.songs
      : Array.isArray(moreInfo.songs)
        ? moreInfo.songs
        : [];
  const tracks = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(parseRawTrackRecord)
    .filter((t): t is JioSaavnTrackMetadata => t !== null);

  return {
    id,
    title,
    subtitle,
    artworkUrl,
    url,
    trackCount: trackCount ?? (tracks.length > 0 ? tracks.length : undefined),
    tracks: tracks.length > 0 ? tracks : undefined,
  };
}

/**
 * Search JioSaavn playlists via `search.getPlaylistResults`, plus synthesize
 * real-time dynamic mix playlists from catalog tracks so playlist search
 * always delivers playable JioSaavn playlists.
 */
export async function searchJioSaavnPlaylists(
  query: string,
  opts: { limit?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JioSaavnPlaylistMetadata[]> {
  const q = (query ?? '').trim().slice(0, 256);
  if (!q) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 30));
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    __call: 'search.getPlaylistResults',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    q,
    p: '1',
    n: String(limit),
  });
  const targetUrl = `${JIOSAAVN_PUBLIC_API_URL}?${params.toString()}`;

  const parsePlaylists = (data: unknown): JioSaavnPlaylistMetadata[] => {
    const obj = (data && typeof data === 'object' ? data : {}) as {
      results?: unknown[];
      data?: { results?: unknown[] };
    };
    const list = Array.isArray(data)
      ? data
      : Array.isArray(obj.results)
        ? obj.results
        : Array.isArray(obj.data?.results)
          ? obj.data.results
          : [];
    return list
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map(parseRawPlaylistRecord)
      .filter((p): p is JioSaavnPlaylistMetadata => p !== null);
  };

  const results: JioSaavnPlaylistMetadata[] = [];

  try {
    const res = await doFetch(targetUrl, {
      signal: opts.signal,
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      results.push(...parsePlaylists(data));
    }
  } catch {
    /* try proxy below */
  }

  if (results.length === 0 && !opts.fetchImpl) {
    try {
      const { proxyGetJson } = await import('../../desktop/localApi');
      const data = await proxyGetJson<unknown>('jiosaavn', targetUrl);
      if (data) {
        results.push(...parsePlaylists(data));
      }
    } catch {
      /* fallback to synthesized mix playlists below */
    }
  }

  // Always synthesize real-time playable JioSaavn Mix playlists from catalog tracks
  try {
    const tracks = await searchJioSaavnCatalog(q, {
      limit: 30,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    if (tracks.length > 0) {
      const first = tracks[0];
      results.unshift({
        id: `mix:${first.id}`,
        title: `${q} — JioSaavn Real-Time Mix`,
        subtitle: `Real-time station • ${first.artist}`,
        artworkUrl: first.artworkUrl,
        trackCount: tracks.length,
        tracks,
      });
    }
  } catch {
    /* ignore */
  }

  return results.slice(0, limit);
}

/**
 * Fetch full details and tracks for a JioSaavn playlist (`playlist.getDetails`
 * or real-time `mix:<trackId>` station).
 */
export async function getJioSaavnPlaylistDetails(
  playlistId: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<JioSaavnPlaylistMetadata | null> {
  const cleanId = (playlistId ?? '').trim().replace(/^jiosaavn:/, '');
  if (!cleanId) return null;

  if (cleanId.startsWith('mix:')) {
    const seedId = cleanId.slice(4).trim();
    const tracks = await fetchJioSaavnRecommendations(seedId, {
      limit: 40,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    });
    if (tracks.length === 0) return null;
    return {
      id: cleanId,
      title: `JioSaavn Mix • ${tracks[0]?.title ?? 'Station'}`,
      subtitle: tracks[0]?.artist,
      artworkUrl: tracks[0]?.artworkUrl,
      trackCount: tracks.length,
      tracks,
    };
  }

  if (!SAFE_TOKEN_RE.test(cleanId)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    __call: 'playlist.getDetails',
    _format: 'json',
    _marker: '0',
    api_version: '4',
    ctx: 'web6dot0',
    listid: cleanId,
  });
  const targetUrl = `${JIOSAAVN_PUBLIC_API_URL}?${params.toString()}`;

  try {
    const res = await doFetch(targetUrl, {
      signal: opts.signal,
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const parsed = parseRawPlaylistRecord(data);
      if (parsed && parsed.tracks && parsed.tracks.length > 0) return parsed;
    }
  } catch {
    /* try proxy below */
  }

  if (!opts.fetchImpl) {
    try {
      const { proxyGetJson } = await import('../../desktop/localApi');
      const data = await proxyGetJson<Record<string, unknown>>('jiosaavn', targetUrl);
      if (data) {
        const parsed = parseRawPlaylistRecord(data);
        if (parsed && parsed.tracks && parsed.tracks.length > 0) return parsed;
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Derive album metadata summaries from a list of JioSaavn track metadata rows.
 */
export function deriveJioSaavnAlbums(tracks: JioSaavnTrackMetadata[], query: string, limit = 20): JioSaavnAlbumMetadata[] {
  const q = query.trim().toLowerCase();
  const map = new Map<string, JioSaavnAlbumMetadata>();
  for (const t of tracks) {
    if (!t.album) continue;
    if (q && !t.album.toLowerCase().includes(q) && !t.artist.toLowerCase().includes(q)) continue;
    const id = t.albumId || t.album;
    if (!map.has(id)) {
      map.set(id, {
        id,
        title: t.album,
        artist: t.artist,
        artistId: t.artists?.[0]?.id,
        year: t.year,
        artworkUrl: t.artworkUrl,
      });
    }
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

/**
 * Derive artist metadata summaries from a list of JioSaavn track metadata rows.
 */
export function deriveJioSaavnArtists(tracks: JioSaavnTrackMetadata[], query: string, limit = 20): JioSaavnArtistMetadata[] {
  const q = query.trim().toLowerCase();
  const map = new Map<string, JioSaavnArtistMetadata>();
  for (const t of tracks) {
    if (t.artists && t.artists.length > 0) {
      for (const a of t.artists) {
        if (q && !a.name.toLowerCase().includes(q)) continue;
        if (!map.has(a.id)) {
          map.set(a.id, {
            id: a.id,
            name: a.name,
            artworkUrl: t.artworkUrl,
            url: a.url,
          });
        }
        if (map.size >= limit) break;
      }
    } else if (t.artist && (!q || t.artist.toLowerCase().includes(q))) {
      if (!map.has(t.artist)) {
        map.set(t.artist, {
          id: t.artist,
          name: t.artist,
          artworkUrl: t.artworkUrl,
        });
      }
    }
    if (map.size >= limit) break;
  }
  return [...map.values()];
}

export type { JioSaavnPlaylistMetadata };
