// Web Discovery subsystem — public surface.
export type { WebSearchResult, WebCandidate, WebSourceKind, WebDiscoveryStatus } from './types';
export {
  registerWebSearchAdapter,
  listWebSearchAdapters,
  clearWebSearchAdapters,
  searchAdapters,
  type WebSearchAdapter,
} from './webSearchAdapter';
export { fetchPublicPageHtml, PAGE_FETCH_TIMEOUT_MS, PAGE_MAX_BYTES, PAGE_MAX_REDIRECTS } from './pageFetcher';
export { extractPageMetadata } from './pageParser';
export type { PageMetadata } from './pageParser';
export { detectProviderOrWeb } from './providerDetector';
export {
  detectMusicPage,
  registerWebPageProvider,
  listWebPageProviders,
  clearWebPageProviders,
  registerBuiltinWebPageProviders,
} from './providerDetector';
export { scoreWebCandidate, isMusicMatch } from './musicPageMatcher';
export { candidateFromReference, candidateToReference } from './webCandidate';
export {
  readWebDiscoveryCache,
  writeWebDiscoveryCache,
  clearWebDiscoveryCache,
  WEB_DISCOVERY_CACHE_TTL_MS,
} from './webDiscoveryCache';
export { discoverWebCandidates, discoverWebReferencesCompat } from './webDiscovery';
