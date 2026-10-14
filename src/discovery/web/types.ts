// Web Discovery subsystem — shared types.
//
// A discovered public music page is ALWAYS a web-reference (playable=false)
// unless an authorized KNOX provider supplies playback. A URL is never
// assumed to be audio. No credentials, cookies, tokens, or signed URLs are
// ever stored.

export type WebSourceKind = 'web-reference';

export interface WebSearchResult {
  url: string;
  title?: string;
  snippet?: string;
  domain?: string;
}

export interface WebCandidate {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  artwork?: string;
  canonicalUrl: string;
  originalDiscoveredUrl: string;
  /** Domain-derived provider id (e.g. "jiosaavn", "spotify", or "web"). */
  providerId: string;
  site?: string;
  sourceKind: WebSourceKind;
  playable: false;
  metadataConfidence: number;
}

export type WebDiscoveryStatus =
  | { state: 'ok'; candidates: WebCandidate[] }
  | { state: 'unavailable'; reason: string }
  | { state: 'empty' };
