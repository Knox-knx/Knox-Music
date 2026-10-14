// Web Discovery — search adapter compatibility layer (§12).
//
// The canonical adapter contract lives in ../webSearch.ts
// (WebSearchAdapter + registerWebSearchAdapter, executed by searchWeb).
// This module re-exports that contract and adapts its result shape to the
// web/ subsystem's WebSearchResult ({url,title,snippet,domain}).
// Single execution path — no duplicate registries, no divergent timeouts.

import {
  registerWebSearchAdapter as registerCanonical,
  listWebSearchProviders,
  clearWebSearchProviders,
  searchWeb,
  type WebSearchAdapter as CanonicalAdapter,
} from '../webSearch';
import type { WebSearchResult } from './types';

export type { WebSearchAdapter } from '../webSearch';

export function registerWebSearchAdapter(a: CanonicalAdapter): void {
  registerCanonical(a);
}

export function listWebSearchAdapters(): { id: string; displayName: string }[] {
  return listWebSearchProviders().map((p) => ({ id: p.id, displayName: p.displayName }));
}

/** Test seam: clear the shared registry (same backing store as searchWeb). */
export function clearWebSearchAdapters(): void {
  clearWebSearchProviders();
}

/**
 * Fan out across registered adapters with full isolation + honest
 * timeouts (delegates to searchWeb). Never throws — returns mapped
 * results + failure ids. Honors AbortSignal so stale searches never
 * overwrite newer queries.
 */
export async function searchAdapters(
  query: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; limit?: number } = {},
): Promise<{ results: WebSearchResult[]; failures: string[] }> {
  const { results, failures } = await searchWeb(query, opts);
  return {
    results: results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: [r.artist, r.album].filter(Boolean).join(' · ') || undefined,
      domain: (() => {
        try {
          return new URL(r.url).hostname;
        } catch {
          return r.site;
        }
      })(),
    })),
    failures,
  };
}
