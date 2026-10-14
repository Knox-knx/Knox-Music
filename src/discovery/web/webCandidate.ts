// Web Discovery — candidate normalization.
//
// Every discovered page becomes an explicit web-reference:
// sourceKind=web-reference, playable=false. referenceUrl preserved exactly
// enough to open the original page (meaningful IDs kept).

import type { TrackReference } from '../types';
import type { WebCandidate } from './types';
import { detectProviderOrWeb } from './providerDetector';

export function candidateFromReference(ref: TrackReference): WebCandidate {
  const d = detectProviderOrWeb(ref.canonicalUrl);
  let confidence = 0.5;
  if (ref.title && ref.artist) confidence = 0.9;
  else if (ref.title || ref.artist) confidence = 0.7;
  if (ref.durationMs) confidence = Math.min(1, confidence + 0.05);
  if (ref.artwork) confidence = Math.min(1, confidence + 0.05);
  if (typeof ref.matchConfidence === 'number') {
    confidence = Math.min(1, Math.max(confidence, ref.matchConfidence / 100));
  }
  return {
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    durationMs: ref.durationMs,
    artwork: ref.artwork,
    canonicalUrl: ref.canonicalUrl,
    originalDiscoveredUrl: ref.originalDiscoveredUrl ?? ref.canonicalUrl,
    providerId: ref.provider ?? d.providerId,
    site: ref.site ?? d.displayName,
    sourceKind: 'web-reference',
    playable: false,
    metadataConfidence: Math.round(confidence * 100) / 100,
  };
}

export function candidateToReference(c: WebCandidate): TrackReference {
  return {
    provider: c.providerId,
    providerId: undefined,
    title: c.title,
    artist: c.artist,
    album: c.album,
    durationMs: c.durationMs,
    artwork: c.artwork,
    canonicalUrl: c.canonicalUrl,
    originalDiscoveredUrl: c.originalDiscoveredUrl,
    sourceType: 'web',
    playable: false,
    downloadable: false,
    cacheable: false,
    site: c.site,
    matchConfidence: Math.round(c.metadataConfidence * 100),
  };
}
