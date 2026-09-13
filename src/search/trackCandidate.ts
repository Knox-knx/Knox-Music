// Unified search result model — TrackCandidate.
//
// Every provider (Jamendo, Internet Archive, FreeToUse, AirBeats,
// YouTube Music discovery, Radio Browser, local, web discovery) normalizes
// to this shape before ranking/dedupe/enrichment. Playability is EXPLICIT:
// a URL is never assumed to be audio, and referenceUrl is never promoted
// to streamUrl by guessing.

import type { Song } from '../core/types';

export type SourceKind =
  | 'audio-stream'
  | 'web-reference'
  | 'radio-stream'
  | 'local-file'
  | 'offline-file';

export interface TrackCandidate {
  id: string;
  providerId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  artwork?: string;
  year?: number;
  sourceKind: SourceKind;
  /** True only when KNOX holds an authorized playable audio source. */
  playable: boolean;
  /** Authorized audio bytes URL (only when playable + audio-stream/radio/offline/local). */
  streamUrl?: string;
  /** Public music page URL (always preserved for references). */
  referenceUrl?: string;
  capabilities: {
    canPlay: boolean;
    canOpenSource: boolean;
    canAddToLibrary: boolean;
  };
  matchScore?: number;
  matchType?: 'exact' | 'strong' | 'partial' | 'related';
  metadataConfidence?: number;
}

/** Provider ids that supply radio (live, direct URL, no temp buffer). */
const RADIO_PROVIDER_IDS = new Set(['radio-browser', 'radio']);

function isLocalSong(s: Song): boolean {
  return s.providerId === 'local' || s.isLocalFile === true || (s.streamUrl?.startsWith('blob:') ?? false);
}

/**
 * Strict classification: never infer playability from URL presence alone.
 * - web-* / discovery-only (supportsStreaming=false) → web-reference, playable=false
 * - radio providers → radio-stream, playable=true when a safe URL exists
 * - local files → local-file, playable=true
 * - offline repo hits are upgraded by the caller to offline-file (needs storage check)
 * - authorized provider streams (streamUrl + streamable capability) → audio-stream
 * - everything else → web-reference, playable=false
 */
export function classifySong(
  song: Song,
  opts: { supportsStreaming?: boolean; hasOfflineFile?: boolean } = {},
): Pick<TrackCandidate, 'sourceKind' | 'playable' | 'streamUrl' | 'referenceUrl'> {
  const supportsStreaming = opts.supportsStreaming;
  // Explicit offline file wins (caller verified storage).
  if (opts.hasOfflineFile === true) {
    return {
      sourceKind: 'offline-file',
      playable: true,
      streamUrl: undefined,
      referenceUrl: song.sourceUrl,
    };
  }
  if (isLocalSong(song)) {
    return {
      sourceKind: 'local-file',
      playable: true,
      streamUrl: song.streamUrl,
      referenceUrl: song.sourceUrl,
    };
  }
  if (RADIO_PROVIDER_IDS.has(song.providerId)) {
    const hasUrl = typeof song.streamUrl === 'string' && song.streamUrl.length > 0;
    return {
      sourceKind: 'radio-stream',
      playable: hasUrl,
      streamUrl: hasUrl ? song.streamUrl : undefined,
      referenceUrl: song.sourceUrl,
    };
  }
  // Discovery-only providers (YouTube Music) and web-* ids are references.
  const discoveryOnly =
    supportsStreaming === false ||
    song.providerId.startsWith('web-') ||
    song.capabilities?.streamable === false;
  if (discoveryOnly) {
    return {
      sourceKind: 'web-reference',
      playable: false,
      streamUrl: undefined,
      referenceUrl: song.sourceUrl ?? song.streamUrl,
    };
  }
  // Authorized audio stream: needs BOTH an explicit streamable capability
  // (or a provider that supports streaming) AND a stream URL snapshot.
  // A missing snapshot with a streaming provider is still audio-stream but
  // not yet playable (getStream() may resolve lazily, e.g. Internet Archive).
  const streamableCap = song.capabilities?.streamable !== false;
  const providerAllows = opts.supportsStreaming !== false;
  if (streamableCap && providerAllows) {
    if (song.streamUrl) {
      return {
        sourceKind: 'audio-stream',
        playable: true,
        streamUrl: song.streamUrl,
        referenceUrl: song.sourceUrl,
      };
    }
    // No snapshot yet (e.g. IA metadata lazily resolved): still an
    // audio-stream candidate, playable pending getStream().
    if (supportsStreaming === true || song.providerId === 'internet-archive') {
      return {
        sourceKind: 'audio-stream',
        playable: true,
        streamUrl: undefined,
        referenceUrl: song.sourceUrl,
      };
    }
  }
  return {
    sourceKind: 'web-reference',
    playable: false,
    streamUrl: undefined,
    referenceUrl: song.sourceUrl ?? song.streamUrl,
  };
}

/** Convert a Song to a TrackCandidate (pure, no I/O). */
export function songToCandidate(
  song: Song,
  opts: { supportsStreaming?: boolean; hasOfflineFile?: boolean } = {},
): TrackCandidate {
  const c = classifySong(song, opts);
  const canOpen = typeof c.referenceUrl === 'string' && c.referenceUrl.length > 0;
  return {
    id: song.id,
    providerId: song.providerId,
    title: song.title,
    artist: song.artist,
    album: song.album || undefined,
    durationMs: song.durationMs > 0 ? song.durationMs : undefined,
    artwork: song.artworkUrl,
    year: song.year,
    sourceKind: c.sourceKind,
    playable: c.playable,
    streamUrl: c.streamUrl,
    referenceUrl: c.referenceUrl,
    capabilities: {
      canPlay: c.playable,
      canOpenSource: canOpen,
      canAddToLibrary: true,
    },
    matchScore: song.relevanceScore,
    matchType: song.matchType,
    metadataConfidence: confidenceFor(song),
  };
}

/** Metadata richness 0–1 (never outranks text match; used as tiebreak). */
export function confidenceFor(song: Pick<Song, 'title' | 'artist' | 'album' | 'durationMs' | 'artworkUrl' | 'year'>): number {
  let score = 0;
  if (song.title && song.title.trim() && song.title !== 'Untitled') score += 0.3;
  if (song.artist && song.artist.trim() && song.artist !== 'Unknown artist') score += 0.3;
  if (song.album && song.album.trim()) score += 0.15;
  if (song.durationMs > 0) score += 0.15;
  if (song.artworkUrl) score += 0.1;
  return Math.min(1, Math.round(score * 100) / 100);
}

/** True when this candidate may enter the audio pipeline. */
export function isPlayableCandidate(c: Pick<TrackCandidate, 'sourceKind' | 'playable'>): boolean {
  if (!c.playable) return false;
  return c.sourceKind === 'audio-stream' || c.sourceKind === 'radio-stream' || c.sourceKind === 'local-file' || c.sourceKind === 'offline-file';
}

/** Web references must stop before provider.getStream() / AudioEngine. */
export function isWebReference(c: Pick<TrackCandidate, 'sourceKind' | 'playable'>): boolean {
  return c.sourceKind === 'web-reference' || !c.playable;
}
