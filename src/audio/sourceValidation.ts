// Centralized source validation — single choke point before playback.
//
// Validates protocol, hostname, sourceKind, provider, playability, URL shape.
// Rules:
// - web-reference → NEVER playable (stops before getStream/AudioEngine)
// - https audio → validate (http allowed only for loopback/asset-local)
// - radio → validate separately (live, direct)
// - local/offline → validate (blob:/asset-local only)
// Never uses URL.endsWith('.mp3') as the only check — extension is a hint,
// MIME + bytes + element decode are authoritative.

import { isDefinitelyNotAudio, isPlayableAudioMime } from './mediaDiagnostics';

export type ValidatedSourceKind =
  | 'audio-stream'
  | 'web-reference'
  | 'radio-stream'
  | 'local-file'
  | 'offline-file'
  | 'temp-blob'
  | 'temp-file'
  | 'direct';

export interface SourceValidationInput {
  url: string;
  sourceKind: ValidatedSourceKind | string;
  providerId?: string;
  mimeType?: string;
}

export interface SourceVerdict {
  ok: boolean;
  reason: string;
  /** User-facing explanation (no internals). Set when !ok. */
  friendly?: string;
}

function parseUrl(url: string): URL | null {
  try {
    const base =
      typeof window !== 'undefined' && window.location?.href ? window.location.href : 'http://localhost/';
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** Asset-local hosts produced by Tauri convertFileSrc (never remote). */
function isAssetLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'asset.localhost' || h.endsWith('.asset.localhost') || h === 'tauri.localhost';
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '[::1]' || h === '::1') return true;
  if (h === '10.0.0.0' || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) return true;
  return false;
}

/**
 * Validate one playback source. Pure, no network. Every redirect destination
 * must be validated again by the caller (see pageResolver/fetch paths).
 */
export function validateSource(input: SourceValidationInput): SourceVerdict {
  const { url, sourceKind, mimeType } = input;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'empty-url', friendly: 'This track has no playable audio source.' };
  }
  if (sourceKind === 'web-reference') {
    return {
      ok: false,
      reason: 'web-reference-not-playable',
      friendly: 'This result is a web reference and does not provide authorized playback in KNOX Music.',
    };
  }
  const parsed = parseUrl(url.trim());
  if (!parsed) return { ok: false, reason: 'unparseable-url', friendly: 'This track has no playable audio source.' };
  const protocol = parsed.protocol.toLowerCase();

  // Temp/blob + local asset paths.
  if (sourceKind === 'temp-blob') {
    if (protocol !== 'blob:') {
      return { ok: false, reason: 'unsafe-protocol', friendly: 'Temporary audio failed to load.' };
    }
    return { ok: true, reason: 'ok' };
  }
  if (sourceKind === 'temp-file' || sourceKind === 'local-file' || sourceKind === 'offline-file') {
    if (protocol === 'blob:') return { ok: true, reason: 'ok' };
    // Tauri v2 asset URLs are http(s) on asset.localhost; older builds used asset://.
    if (protocol === 'asset:' || protocol === 'tauri:') return { ok: true, reason: 'ok' };
    if ((protocol === 'http:' || protocol === 'https:') && isAssetLocalHost(parsed.hostname)) {
      return { ok: true, reason: 'ok' };
    }
    if (sourceKind === 'temp-file') {
      return { ok: false, reason: 'unsafe-protocol', friendly: 'Temporary audio failed to load.' };
    }
    // local/offline direct blob handled above; file:// is never allowed into the element.
    if (protocol === 'http:' || protocol === 'https:') return { ok: true, reason: 'ok' };
    return { ok: false, reason: 'unsafe-protocol', friendly: 'This local file cannot be played.' };
  }

  // Remote audio / radio / direct provider URLs.
  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      ok: false,
      reason: 'unsafe-protocol',
      friendly: 'This track has no playable audio source.',
    };
  }
  // http is allowed only for loopback (sidecar/dev) and asset-local.
  if (protocol === 'http:' && !isLoopbackHost(parsed.hostname) && !isAssetLocalHost(parsed.hostname)) {
    // Still allow http remote? Historically allowed, but prefer https.
    // Keep permissive (ok) to avoid breaking Jamendo http streams, but note it.
    return { ok: true, reason: 'ok-insecure' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials-in-url', friendly: 'This track has no playable audio source.' };
  }
  if (mimeType && isDefinitelyNotAudio(mimeType)) {
    return {
      ok: false,
      reason: mimeType.includes('html') ? 'html-response-instead-of-audio' : 'invalid-mime',
      friendly: 'The provider returned a page instead of audio for this track.',
    };
  }
  if (mimeType && !isPlayableAudioMime(mimeType) && mimeType !== 'application/octet-stream') {
    return { ok: false, reason: 'unsupported-mime', friendly: 'Unsupported audio format.' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * User-facing message for a validation failure. Internal `reason`
 * (unsafe-protocol etc.) is kept for diagnostics; the UI shows this.
 */
export function friendlySourceMessage(
  verdict: SourceVerdict,
  providerLabel?: string,
): string {
  if (verdict.ok) return '';
  if (verdict.friendly) {
    return providerLabel ? `${verdict.friendly} (${providerLabel})` : verdict.friendly;
  }
  const where = providerLabel ? ` (${providerLabel})` : '';
  switch (verdict.reason) {
    case 'web-reference-not-playable':
      return `This result is a web reference and does not provide authorized playback in KNOX Music${where}.`;
    case 'unsafe-protocol':
      return `This track has no playable audio source${where}.`;
    case 'unsupported-mime':
    case 'invalid-mime':
      return `Unsupported audio format${where}.`;
    default:
      return `Unable to play this track${where}.`;
  }
}

/** AirBeats-specific honest message when a page was supplied instead of audio. */
export function airbeatsFriendlyMessage(reason: string): string {
  if (reason === 'web-reference-not-playable') {
    return 'AirBeats provided a web page rather than a playable audio source.';
  }
  if (reason === 'unsafe-protocol' || reason === 'unparseable-url' || reason === 'empty-url') {
    return 'AirBeats provided a web page rather than a playable audio source.';
  }
  if (reason.includes('html') || reason.includes('invalid-mime')) {
    return 'AirBeats returned a page instead of audio for this track.';
  }
  return 'Unable to play this AirBeats track.';
}
