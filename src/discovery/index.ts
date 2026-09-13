// Live Web Discovery — public surface.

export type {
  WebDiscoveryResult,
  TrackReference,
  DiscoveryDiagnostics,
  PageMetadata,
  WebSourceType,
} from './types';
export {
  validateDiscoveryUrl,
  isPrivateIpv4,
  scrubDiscoveryUrl,
  hashQuerySync,
} from './ssrfGuard';
export {
  searchWeb,
  registerWebSearchProvider,
  listWebSearchProviders,
  clearWebSearchProviders,
  registerBuiltinWebSearch,
  type WebSearchProvider,
  type WebSearchOptions,
} from './webSearch';
export {
  registerWebPageProvider,
  listWebPageProviders,
  clearWebPageProviders,
  getWebPageProvider,
  detectMusicPage,
  stripTrackingParams,
  registerBuiltinWebPageProviders,
  type WebPageProvider,
  type WebPageKind,
  type DetectedPage,
} from './providerDetector';
export { extractPageMetadata } from './metadataExtractor';
export { resolveMusicPage } from './pageResolver';
export {
  scoreDiscoveryMatch,
  matchDiscoveryToSongs,
  dedupeReferences,
  type DiscoveryMatch,
} from './trackMatcher';
export {
  readDiscoveryCache,
  writeDiscoveryCache,
  clearDiscoveryCache,
  DISCOVERY_CACHE_TTL_MS,
} from './discoveryCache';
export {
  discoverWebReferences,
  discoveryToSong,
  type LiveDiscoveryOptions,
  type LiveDiscoveryOutcome,
} from './webDiscovery';
export {
  localDesktopDiscoverySearch,
  discoverySearchViaLocalApi,
  discoverySearchViaPublicMetadata,
  fetchDiscoveryPageHtml,
  buildMusicBrainzQuery,
} from './localDiscoveryService';
export {
  itunesDiscoverySearch,
  itunesToResults,
  localItunesHitToResult,
} from './itunesSearch';
