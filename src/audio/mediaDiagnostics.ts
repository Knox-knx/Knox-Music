// Track-specific playback diagnostics (§1–§10, §20).
//
// The previous global GStreamer/AppImage/PipeWire investigation is complete
// and untouched here. This module answers the narrower question: for ONE
// resolved playback URL, is the response actually browser/WebKit-playable
// audio, and if not, which category does the failure belong to?
//
// All helpers are pure and side-effect free (no network, no DOM) so they are
// unit-testable and safe to call from the playback path. Anything that
// touches the network (probeMediaUrl) is CORS-tolerant: a blocked probe
// reports `unknown`, never a failure — the <audio> element remains the
// authoritative decoder and its MediaError is classified honestly.

/** Playback failure categories (§20). Never conflated. */
export type PlaybackFailureKind =
  | 'provider-unavailable'
  | 'track-unavailable'
  | 'unsupported-format'
  | 'network-failure'
  | 'decode-failure'
  | 'audio-output-muted';

/** Media events recorded for the compact trail (§8). */
export const MEDIA_EVENT_TRAIL_ORDER = [
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'durationchange',
  'progress',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'abort',
  'error',
  'ended',
  'emptied',
  'seeking',
  'seeked',
] as const;

export type MediaEventName = (typeof MEDIA_EVENT_TRAIL_ORDER)[number] | string;

/** MIME types the KNOX desktop WebKitGTK pipeline is expected to demux. */
const PLAYABLE_AUDIO_MIME = [
  /^audio\/mpeg$/i,
  /^audio\/mp3$/i,
  /^audio\/x-mp3$/i,
  /^audio\/mp4$/i,
  /^audio\/x-m4a$/i,
  /^audio\/aac$/i,
  /^audio\/x-aac$/i,
  /^audio\/ogg$/i,
  /^audio\/opus$/i,
  /^audio\/flac$/i,
  /^audio\/x-flac$/i,
  /^audio\/wav$/i,
  /^audio\/x-wav$/i,
  /^audio\/wave$/i,
  /^audio\/webm$/i,
  /^application\/ogg$/i,
];

/** Content-Types that are definitely NOT audio (§2). */
const NOT_AUDIO_MIME = [
  /^text\/html/i,
  /^application\/json/i,
  /^text\/plain/i,
  /^application\/xml/i,
  /^text\/xml/i,
];

/** Strip query/hash that may carry signatures — never log full URLs (§1). */
export function scrubMediaUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'http://localhost');
    if (u.protocol === 'blob:' || u.protocol === 'data:') return `${u.protocol}//<local>`;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

/** Infer the honest MIME type from a media URL's extension (§5). */
export function inferMimeTypeFromUrl(url: string, fallback = 'audio/mpeg'): string {
  const clean = (url ?? '').split('?')[0].split('#')[0].toLowerCase();
  if (/\.mp3(\/|$)/.test(`${clean}/`) || clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.m4a')) return 'audio/mp4';
  if (clean.endsWith('.mp4') || clean.endsWith('.m4b')) return 'audio/mp4';
  if (clean.endsWith('.aac')) return 'audio/mp4';
  if (clean.endsWith('.opus')) return 'audio/ogg';
  if (clean.endsWith('.ogg') || clean.endsWith('.oga')) return 'audio/ogg';
  if (clean.endsWith('.flac')) return 'audio/flac';
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.webm') || clean.endsWith('.weba')) return 'audio/webm';
  // AirBeats/JioSaavn-style tiered blobs always end in _<kbps>.mp4.
  if (/_\d+kbps\.mp4$/.test(clean)) return 'audio/mp4';
  return fallback;
}

/** Infer the honest MIME type from an Internet Archive file record (§15). */
export function mimeTypeForFilename(
  name: string,
  formatHint?: string,
  fallback = 'audio/mpeg',
): string {
  const fromName = inferMimeTypeFromUrl(`https://localhost/${name}`, '');
  if (fromName) return fromName;
  const fmt = (formatHint ?? '').toLowerCase();
  if (/vbr\s*mp3|\bmp3\b/.test(fmt)) return 'audio/mpeg';
  if (/opus/.test(fmt)) return 'audio/ogg';
  if (/ogg|vorbis/.test(fmt)) return 'audio/ogg';
  if (/flac/.test(fmt)) return 'audio/flac';
  if (/m4a|mp4.*audio|aac/.test(fmt)) return 'audio/mp4';
  if (/wav|aiff?/.test(fmt)) return 'audio/wav';
  if (/webm/.test(fmt)) return 'audio/webm';
  return fallback;
}

/** True for MIME types the WebKitGTK audio pipeline can demux (§4). */
export function isPlayableAudioMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  const base = mime.split(';')[0].trim();
  if (!base) return false;
  if (NOT_AUDIO_MIME.some((r) => r.test(base))) return false;
  if (PLAYABLE_AUDIO_MIME.some((r) => r.test(base))) return true;
  // Generic binary with an audio URL is carried as-is (§5: never alter bytes);
  // the element decides. Anything else is not playable.
  if (/^application\/octet-stream$/i.test(base)) return true;
  return false;
}

/** True when the MIME is definitely a non-audio error page (§2). */
export function isDefinitelyNotAudio(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return NOT_AUDIO_MIME.some((r) => r.test(mime.split(';')[0].trim()));
}

export interface MediaHeaderSnapshot {
  status: number;
  contentType?: string | null;
  contentLength?: number | null;
  acceptRanges?: string | null;
  contentRange?: string | null;
  /** True when at least one redirect was followed to reach this response. */
  redirected?: boolean;
}

export interface MediaHeaderVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Validate an observed HTTP media response (§2, §6, §7).
 * Pure — the caller supplies already-fetched headers (server-side probe,
 * service-worker, or test fixture). Redirects must already be followed:
 * only the FINAL response is judged.
 */
export function validateMediaHeaders(h: MediaHeaderSnapshot): MediaHeaderVerdict {
  const { status } = h;
  if (status === 404) return { ok: false, reason: 'http-404' };
  if (status === 403) return { ok: false, reason: 'http-403' };
  if (status === 401) return { ok: false, reason: 'http-401' };
  if (status === 429) return { ok: false, reason: 'http-429' };
  if (status >= 500) return { ok: false, reason: `http-${status}` };
  if (status !== 200 && status !== 206) {
    return { ok: false, reason: `http-${status}` };
  }
  const ct = (h.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ct) return { ok: false, reason: 'missing-content-type' };
  if (isDefinitelyNotAudio(ct)) {
    return {
      ok: false,
      reason: ct.includes('html')
        ? 'html-response-instead-of-audio'
        : ct.includes('json')
          ? 'json-response-instead-of-audio'
          : 'invalid-content-type',
    };
  }
  if (!isPlayableAudioMime(ct) && ct !== 'application/octet-stream') {
    return { ok: false, reason: 'invalid-content-type' };
  }
  const len = h.contentLength;
  if (typeof len === 'number' && Number.isFinite(len) && len <= 0) {
    return { ok: false, reason: 'empty-response' };
  }
  return { ok: true, reason: status === 206 ? 'partial-content' : 'ok' };
}

export interface RangeSupport {
  supported: boolean;
  detail: 'partial-content' | 'accept-ranges' | 'not-supported' | 'unknown';
}

/** Classify HTTP Range behavior from an observed range probe (§6). */
export function classifyRangeSupport(h: MediaHeaderSnapshot): RangeSupport {
  if (h.status === 206 && h.contentRange) {
    return { supported: true, detail: 'partial-content' };
  }
  const ar = (h.acceptRanges ?? '').toLowerCase();
  if (ar.includes('bytes')) return { supported: true, detail: 'accept-ranges' };
  if (h.status === 200) return { supported: false, detail: 'not-supported' };
  return { supported: false, detail: 'unknown' };
}

/** Map a MediaError code to its spec name (§9). */
export function mediaErrorName(code: number | null | undefined): string {
  switch (code) {
    case 1:
      return 'MEDIA_ERR_ABORTED';
    case 2:
      return 'MEDIA_ERR_NETWORK';
    case 3:
      return 'MEDIA_ERR_DECODE';
    case 4:
      return 'MEDIA_ERR_SRC_NOT_SUPPORTED';
    default:
      return 'MEDIA_ERR_UNKNOWN';
  }
}

/** Classify an element-level MediaError into a playback category (§20). */
export function classifyMediaError(code: number | null | undefined): PlaybackFailureKind {
  switch (code) {
    case 1:
      return 'network-failure'; // aborted fetch — surfaced as interrupted load
    case 2:
      return 'network-failure';
    case 3:
      return 'decode-failure';
    case 4:
      return 'unsupported-format';
    default:
      return 'decode-failure';
  }
}

/**
 * Classify a resolve/play failure (thrown Error) into a playback category.
 * ProviderError codes stay authoritative; message substrings only refine
 * HTTP-flavored messages that already traveled as plain Errors.
 */
export function classifyResolveError(e: unknown): PlaybackFailureKind {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  if (/unsupported audio format|src_not_supported|mime|codec|demux|unsupported-format/.test(msg)) {
    return 'unsupported-format';
  }
  if (/http 404|not found|no playable|unavailable for this|no playable audio/.test(msg)) {
    return 'track-unavailable';
  }
  if (/http 403|http 401|forbidden|unauthorized|restricted|private/.test(msg)) {
    return 'track-unavailable';
  }
  if (/http 429|rate-limit|rate limit/.test(msg)) return 'provider-unavailable';
  if (/http 5\d\d|temporarily unavailable|service unavailable|bad gateway/.test(msg)) {
    return 'provider-unavailable';
  }
  if (/timed out|timeout|network|offline|fetch failed|failed to fetch|connection/.test(msg)) {
    return 'network-failure';
  }
  if (/unsafe audio url|unsafe/.test(msg)) return 'track-unavailable';
  const code = (e as { code?: string } | null)?.code;
  if (code === 'NOT_FOUND') return 'track-unavailable';
  if (code === 'UNSUPPORTED') return 'unsupported-format';
  if (code === 'TIMEOUT') return 'network-failure';
  if (code === 'RATE_LIMIT') return 'provider-unavailable';
  return 'track-unavailable';
}

/** Simple, honest user-facing message per category (§19). No internals. */
export function friendlyPlaybackMessage(
  kind: PlaybackFailureKind,
  providerLabel?: string,
): string {
  const where = providerLabel ? ` (${providerLabel})` : '';
  switch (kind) {
    case 'unsupported-format':
      return `Unsupported audio format${where}.`;
    case 'network-failure':
      return 'Audio stream unavailable — check your connection and try again.';
    case 'provider-unavailable':
      return `Audio stream unavailable${where} — the source is temporarily down.`;
    case 'track-unavailable':
      return 'Unable to play this track.';
    case 'decode-failure':
      return 'Unable to play this track.';
    case 'audio-output-muted':
      return 'Audio playback failed — output is muted. Check the volume and system mixer.';
  }
}

/** Full friendly line used by the store: category message + raw cause. */
export function classifiedPlaybackMessage(e: unknown, providerLabel?: string): string {
  const kind = classifyResolveError(e);
  const base = friendlyPlaybackMessage(kind, providerLabel);
  const raw = e instanceof Error ? e.message : String(e ?? 'Playback failed');
  return `${base} (${providerLabel ?? 'source'}: ${raw})`.slice(0, 500);
}

/**
 * Pipeline-stage failure codes for safe diagnostics (§6).
 * The raw error is always preserved separately; the UI shows only the
 * per-code sentence. Never a bare "Unable to play this track" without a
 * classified reason attached.
 */
export type PlaybackFailureCode =
  | 'SOURCE_INVALID'
  | 'SOURCE_UNAVAILABLE'
  | 'DOWNLOAD_FAILED'
  | 'TEMP_FILE_FAILED'
  | 'ASSET_URL_FAILED'
  | 'MEDIA_LOAD_FAILED'
  | 'MEDIA_PLAY_FAILED'
  | 'CLOCK_FROZEN'
  | 'PROVIDER_ERROR'
  | 'WEB_REFERENCE';

export interface ClassifiedFailure {
  code: PlaybackFailureCode;
  /** User-facing sentence (no internals, no raw error). */
  ui: string;
}

/**
 * Classify a playback failure into a pipeline stage code + UI sentence.
 * Pure and side-effect free. `isAirbeats` selects the provider-specific
 * wording ("AirBeats audio source could not be loaded.").
 */
export function classifyPlaybackFailure(e: unknown, isAirbeats: boolean): ClassifiedFailure {
  const msg = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  const air = (generic: string, airbeats: string): string => (isAirbeats ? airbeats : generic);
  if (/web page rather than|web-reference|web reference/.test(msg)) {
    return {
      code: 'WEB_REFERENCE',
      ui: air(
        'This result is a web reference and does not provide authorized playback in KNOX Music.',
        'AirBeats provided a web page rather than a playable audio source.',
      ),
    };
  }
  if (/invalid audio source|unsafe-protocol|unsafe audio url|unparseable-url|empty-url/.test(msg)) {
    return { code: 'SOURCE_INVALID', ui: 'This track has no valid audio source.' };
  }
  if (/temporary download failed|download interrupted|truncated|exceeds size cap|not audio|unrecognized-audio/.test(msg)) {
    return { code: 'TEMP_FILE_FAILED', ui: 'Audio download failed before playback could start.' };
  }
  if (/temporary audio failed to load|timed out while loading|canplay|loadedmetadata/.test(msg)) {
    return {
      code: 'MEDIA_LOAD_FAILED',
      ui: air('Audio source could not be loaded.', 'AirBeats audio source could not be loaded.'),
    };
  }
  if (/play\(\) rejected|notallowederror|aborterror.*play|interrupted by a call to pause/.test(msg)) {
    return { code: 'MEDIA_PLAY_FAILED', ui: 'Playback could not start on this device.' };
  }
  if (/clock did not advance|playback stalled|no sound clock/.test(msg)) {
    return {
      code: 'CLOCK_FROZEN',
      ui: 'Audio started but no sound followed. Check the output device and try again.',
    };
  }
  if (/http 404|not found|no playable/.test(msg)) {
    return { code: 'SOURCE_UNAVAILABLE', ui: 'This track is no longer available from this source.' };
  }
  if (/http 429|rate-limit|rate limit|http 5\d\d|temporarily unavailable|service unavailable|bad gateway|upstream/.test(msg)) {
    return { code: 'PROVIDER_ERROR', ui: 'The source is temporarily down. Try again shortly.' };
  }
  if (/timed out|timeout|network|fetch failed|failed to fetch|connection|offline/.test(msg)) {
    return { code: 'DOWNLOAD_FAILED', ui: 'Audio stream unavailable — check your connection and try again.' };
  }
  if (/unsupported audio format|src_not_supported|invalid-mime|unsupported-mime|codec|demux/.test(msg)) {
    return { code: 'SOURCE_INVALID', ui: 'Unsupported audio format.' };
  }
  if (/asset|convertfilesrc|object url/.test(msg)) {
    return { code: 'ASSET_URL_FAILED', ui: 'Temporary audio file could not be opened.' };
  }
  const code = (e as { code?: string } | null)?.code;
  if (code === 'NOT_FOUND') return { code: 'SOURCE_UNAVAILABLE', ui: 'This track is no longer available from this source.' };
  if (code === 'UNSUPPORTED') return { code: 'SOURCE_INVALID', ui: 'Unsupported audio format.' };
  if (code === 'TIMEOUT') return { code: 'DOWNLOAD_FAILED', ui: 'Audio stream unavailable — check your connection and try again.' };
  if (code === 'RATE_LIMIT') return { code: 'PROVIDER_ERROR', ui: 'The source is temporarily down. Try again shortly.' };
  return { code: 'SOURCE_UNAVAILABLE', ui: 'Unable to play this track.' };
}

export interface StreamCandidate {
  url: string;
  mimeType?: string;
}

export interface StreamCandidateVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Pre-flight gate BEFORE anything is assigned to the <audio> element (§2, §5).
 * Pure URL+MIME check (no network, no CORS risk): rejects empty/unsafe URLs
 * and definitely-non-audio MIME. Unknown MIME proceeds — the element is the
 * authoritative decoder and its MediaError is classified on failure.
 * Never appends extensions and never rewrites the URL.
 */
export function validateStreamCandidate(c: StreamCandidate): StreamCandidateVerdict {
  if (!c || typeof c.url !== 'string' || !c.url.trim()) {
    return { ok: false, reason: 'empty-url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(
      c.url,
      typeof window !== 'undefined' && window.location?.href ? window.location.href : 'http://localhost',
    );
  } catch {
    return { ok: false, reason: 'unparseable-url' };
  }
  const protocol = parsed.protocol.toLowerCase();
  // Tauri disk-temp asset URLs: v2 convertFileSrc emits http(s) on
  // asset.localhost (covered below); older/custom builds may emit asset://
  // or tauri://. Both are local-only (never remote attacker URLs) and only
  // ever produced by the Temporary Playback Buffer for the current track.
  // Remote provider/page URLs still require http(s)/blob — nothing else.
  if (
    protocol !== 'http:' &&
    protocol !== 'https:' &&
    protocol !== 'blob:' &&
    protocol !== 'asset:' &&
    protocol !== 'tauri:'
  ) {
    return { ok: false, reason: 'unsafe-protocol' };
  }
  if (c.mimeType && isDefinitelyNotAudio(c.mimeType)) {
    return { ok: false, reason: 'invalid-mime' };
  }
  if (c.mimeType && !isPlayableAudioMime(c.mimeType) && c.mimeType !== 'application/octet-stream') {
    return { ok: false, reason: 'unsupported-mime' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Sniff the first bytes of a download for HTML/JSON masquerading as audio
 * (§2, §17). Returns false when the payload is definitely an error page.
 * Pure and allocation-free on the hot path (inspects a small prefix only).
 */
export function looksLikeAudioBytes(prefix: Uint8Array | number[] | null | undefined): boolean {
  if (!prefix || prefix.length === 0) return false;
  const bytes = Array.isArray(prefix) ? prefix.slice(0, 64) : Array.from(prefix.slice(0, 64));
  // Skip BOM + ASCII whitespace.
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf || bytes[i] <= 0x20)) {
    // Handle UTF-8 BOM as a unit.
    if (bytes[i] === 0xef && bytes[i + 1] === 0xbb && bytes[i + 2] === 0xbf) {
      i += 3;
      continue;
    }
    if (bytes[i] === 0xef) break;
    i += 1;
  }
  const head = String.fromCharCode(...bytes.slice(i, i + 15)).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')) {
    return false;
  }
  if (head.startsWith('{"ok"') || head.startsWith('{"success"') || head.startsWith('{"error"')) {
    return false;
  }
  return true;
}

/**
 * Actual audio container determined from magic bytes — never hardcoded,
 * never inferred from provider labels alone (PHASE 9).
 *
 * Returns the detected container plus the canonical MIME for that
 * container, or null when the prefix is too short/ambiguous to identify.
 * `unknown-audio` means "not HTML/JSON, but no known signature matched" —
 * the <audio> element remains the authoritative decoder in that case.
 */
export type AudioContainer =
  | 'mp3'
  | 'mp4-m4a'
  | 'ogg'
  | 'flac'
  | 'wav'
  | 'webm'
  | 'unknown-audio';

export interface ContainerDetection {
  container: AudioContainer;
  /** Canonical MIME for the detected container (null when unknown). */
  mime: string | null;
}

export function detectAudioContainer(
  prefix: Uint8Array | number[] | null | undefined,
): ContainerDetection | null {
  if (!prefix || prefix.length < 4) return null;
  const b: number[] = Array.isArray(prefix) ? prefix.slice(0, 16) : Array.from(prefix.slice(0, 16));
  const ascii = (at: number, len: number): string => String.fromCharCode(...b.slice(at, at + len));
  // MP3: ID3 tag or MPEG frame sync (0xFF 0xE0 mask).
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    return { container: 'mp3', mime: 'audio/mpeg' };
  }
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    return { container: 'mp3', mime: 'audio/mpeg' };
  }
  // MP4/M4A: 'ftyp' box at offset 4.
  if (b.length >= 8 && ascii(4, 4) === 'ftyp') {
    return { container: 'mp4-m4a', mime: 'audio/mp4' };
  }
  // OGG (Vorbis/Opus): 'OggS'.
  if (ascii(0, 4) === 'OggS') {
    return { container: 'ogg', mime: 'audio/ogg' };
  }
  // FLAC: 'fLaC'.
  if (ascii(0, 4) === 'fLaC') {
    return { container: 'flac', mime: 'audio/flac' };
  }
  // WAV: 'RIFF....WAVE'.
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    return { container: 'wav', mime: 'audio/wav' };
  }
  // WebM/Matroska: EBML header 0x1A45DFA3.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { container: 'webm', mime: 'audio/webm' };
  }
  // ADTS AAC (no ID3): sync 0xFFFx + MPEG version bits.
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) {
    return { container: 'mp4-m4a', mime: 'audio/mp4' };
  }
  // Recognizably not an error page, but no known signature.
  if (looksLikeAudioBytes(prefix)) {
    return { container: 'unknown-audio', mime: null };
  }
  return null;
}

/**
 * Advisory network probe of a playback URL (diagnostics only).
 * Follows redirects (fetch default) and judges the FINAL response (§7).
 * CORS-blocked or aborted probes resolve `unknown` — they must never mark a
 * working track as broken. Only a definitive non-audio/failure response
 * resolves `invalid`. Never logs URLs.
 */
export async function probeMediaUrl(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<
  | { status: 'valid'; headers: MediaHeaderSnapshot }
  | { status: 'invalid'; reason: string; headers: MediaHeaderSnapshot }
  | { status: 'unknown'; reason: string }
> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Range probe: cheap (first bytes only) and exercises §6 behavior.
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { Range: 'bytes=0-1023' },
    });
    const headers: MediaHeaderSnapshot = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      contentLength: res.headers.get('content-length') ? Number(res.headers.get('content-length')) : null,
      acceptRanges: res.headers.get('accept-ranges'),
      contentRange: res.headers.get('content-range'),
      redirected: res.redirected === true,
    };
    try {
      await res.arrayBuffer().catch(() => null);
    } catch {
      /* body is advisory only */
    }
    const verdict = validateMediaHeaders(headers);
    if (verdict.ok) return { status: 'valid', headers };
    // A bare 200-without-range-support still plays (progressive download) —
    // only hard failures (HTML/JSON/HTTP errors/empty) are invalid here.
    if (verdict.reason === 'ok' || verdict.reason === 'partial-content') {
      return { status: 'valid', headers };
    }
    return { status: 'invalid', reason: verdict.reason, headers };
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError') return { status: 'unknown', reason: 'timeout' };
    // TypeError("Failed to fetch") is the CORS signature — genuinely unknown.
    return { status: 'unknown', reason: 'cors-or-network-unknown' };
  } finally {
    clearTimeout(timer);
  }
}
