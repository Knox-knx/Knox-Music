// Per-track capability resolution.
//
// SEARCH ≠ STREAMING ≠ DOWNLOAD ≠ OFFLINE. A commercial catalog provider may
// report search YES / metadata YES / streaming provider-controlled /
// download NO / offline NO — that is valid and must be shown honestly.
// Never pretend a preview stream is a download, and never hide a track just
// because downloading is disallowed (see Jamendo audiodownload_allowed).

import type { Song, StreamType, TrackCapabilities } from '../core/types';
import type { MusicProvider } from './types';

/**
 * Nominal playable length of a provider-controlled preview.
 * The engine's real `audio.duration` refines this once metadata loads.
 */
export const PREVIEW_DURATION_MS = 30_000;

/**
 * Provider ids whose current implementation only supplies short previews,
 * never the full recording. Explicit allowlist — never inferred
 * from duration, and never applied to full-stream providers.
 * (Empty: no bundled provider is preview-only.)
 */
const PREVIEW_ONLY_PROVIDER_IDS = new Set<string>([]);

/**
 * True when this track only offers a short preview, not the full recording.
 *
 * Explicit signals win (track flags, then capabilities); the known
 * preview-only provider catalog is the fallback. NEVER inferred from
 * duration and NEVER from `streamUrl != null`:
 *   SEARCH ≠ FULL STREAMING,  STREAMING ≠ DOWNLOAD,  PREVIEW ≠ FULL TRACK.
 */
export function isPreviewSong(song: Song | null | undefined): boolean {
  if (!song) return false;
  if (song.previewOnly === true) return true;
  if (song.streamType === 'preview') return true;
  if (song.capabilities?.previewOnly === true) return true;
  if (PREVIEW_ONLY_PROVIDER_IDS.has(song.providerId)) return true;
  return false;
}

/** Explicit stream kind for a track (defaults to "full" for playable tracks). */
export function streamTypeFor(song: Song): StreamType {
  if (song.streamType) return song.streamType;
  return isPreviewSong(song) ? 'preview' : 'full';
}

/** Honest playable length: preview length for previews, catalog duration otherwise. */
export function previewDurationFor(song: Song): number {
  const explicit = song.previewDurationMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.round(explicit);
  }
  return PREVIEW_DURATION_MS;
}

/**
 * Duration the UI may display for playback progress / rows.
 * For previews this is the preview length — never the full commercial
 * duration reported by the catalog API.
 */
export function displayDurationFor(song: Song): number {
  return isPreviewSong(song) ? previewDurationFor(song) : song.durationMs;
}

/** Resolve per-track capabilities from provider flags + track license state. */
export function trackCapabilities(song: Song, provider?: MusicProvider): TrackCapabilities {
  const caps = provider?.capabilities;
  // Strict: never infer playability from URL presence alone.
  // - Discovery-only providers (supportsStreaming=false, e.g. YouTube Music,
  //   web references) are NEVER streamable, even with a stray URL snapshot.
  // - web-* ids are references by construction.
  // - Otherwise streamable when a URL snapshot exists OR the provider can
  //   resolve one lazily at play time (e.g. Internet Archive metadata).
  const providerAllowsStreaming = provider ? caps?.supportsStreaming !== false : (song.capabilities?.streamable !== false);
  const isWebRef = song.providerId.startsWith('web-');
  const hasSnapshot = Boolean(song.streamUrl);
  const canResolveLazily =
    (caps?.supportsStreaming ?? false) && (song.providerId === 'internet-archive' || song.providerId === 'jamendo' || song.providerId === 'airbeats' || song.providerId === 'freetouse');
  const streamable = !isWebRef && providerAllowsStreaming && (hasSnapshot || canResolveLazily);
  const downloadable = song.downloadAllowed === true && Boolean(song.downloadUrl);
  // Preview-only is explicit (track flags / known preview catalog) — a
  // preview stream is never downloadable or offline-capable.
  const previewOnly = isPreviewSong(song) || (caps?.previewOnly ?? false);
  return {
    searchable: true,
    streamable,
    downloadable: previewOnly ? false : downloadable,
    offline: previewOnly ? false : downloadable && (caps?.supportsOffline ?? false),
    previewOnly,
  };
}

/** Attach resolved capabilities to a track (pure — returns a copy). */
export function withCapabilities(song: Song, provider?: MusicProvider): Song {
  const capabilities = trackCapabilities(song, provider);
  return {
    ...song,
    previewOnly: capabilities.previewOnly,
    streamType: song.streamType ?? (capabilities.previewOnly ? 'preview' : 'full'),
    capabilities,
  };
}
