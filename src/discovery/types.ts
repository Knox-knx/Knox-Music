// Live Web Discovery — shared types.
//
// A discovered page is a REFERENCE/METADATA source unless the source
// explicitly provides an authorized playback mechanism KNOX may legally
// use. Discovery results default to non-playable / non-downloadable /
// non-cacheable. They NEVER enter persistent playback storage (no Smart
// Cache remains; the Temporary Playback Buffer only ever holds an
// authorized provider stream for the currently playing track).

export type WebSourceType = 'web';

export interface WebDiscoveryResult {
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  artwork?: string;
  site?: string;
  provider?: string;
  providerId?: string;
  sourceType: WebSourceType;
  /**
   * Result origin — NEVER relabeled: catalog-API rows (iTunes, MusicBrainz,
   * local service) are 'catalog'; operator backends and HTML-parsed pages
   * are 'web'. The UI states this honestly instead of calling catalog
   * lookup "live web search".
   */
  origin?: 'catalog' | 'web';
  discoveredAt: number;
}

export interface TrackReference {
  /** Web provider id, e.g. "jiosaavn", "spotify", "youtube-music-web". */
  provider: string;
  providerId?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  artwork?: string;
  canonicalUrl: string;
  originalDiscoveredUrl?: string;
  sourceType: 'web';
  /**
   * 'catalog' = carried over from a catalog-API row without fetching HTML;
   * 'web' = parsed from fetched public-page HTML (genuine page scrape).
   */
  origin?: 'catalog' | 'web';
  /** Capability gates — default false for web discovery. */
  playable: boolean;
  downloadable: boolean;
  cacheable: boolean;
  site?: string;
  year?: number;
  matchConfidence?: number;
}

export interface DiscoveryDiagnostics {
  event:
    | 'discovery_started'
    | 'discovery_completed'
    | 'discovery_timeout'
    | 'discovery_parser_failed'
    | 'discovery_result_rejected';
  queryHash?: string;
  count?: number;
  reason?: string;
  elapsedMs?: number;
}

export interface PageMetadata {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  year?: number;
  artwork?: string;
  canonicalUrl?: string;
  site?: string;
  providerId?: string;
  rawSource: 'json-ld' | 'opengraph' | 'meta' | 'provider-parser' | 'unknown';
}
