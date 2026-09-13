// Web Discovery — provider detection (domain-based).
//
// music.example.com → provider "example". Unknown domains → provider "web"
// (never falsely identified). referenceUrl is preserved with meaningful
// page-identifying params (v=, list=, id=, i=); tracking params stripped.

export {
  detectMusicPage,
  registerWebPageProvider,
  listWebPageProviders,
  clearWebPageProviders,
  getWebPageProvider,
  stripTrackingParams,
  lastPathSegment,
  registerBuiltinWebPageProviders,
} from '../providerDetector';
export type { WebPageProvider, WebPageKind, DetectedPage } from '../providerDetector';

import { detectMusicPage as detect } from '../providerDetector';

/** Detect a music page, falling back to generic provider "web". */
export function detectProviderOrWeb(rawUrl: string): {
  providerId: string;
  displayName: string;
  canonicalUrl: string;
  pageId: string | null;
} {
  const d = detect(rawUrl);
  if (d) {
    return {
      providerId: d.webProviderId,
      displayName: d.displayName,
      canonicalUrl: d.canonicalUrl,
      pageId: d.pageId,
    };
  }
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return { providerId: 'web', displayName: host || 'Web', canonicalUrl: rawUrl, pageId: null };
  } catch {
    return { providerId: 'web', displayName: 'Web', canonicalUrl: rawUrl, pageId: null };
  }
}
