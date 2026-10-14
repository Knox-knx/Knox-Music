// Live Web Discovery — orchestrator.
//
// Pipeline: query → parallel web search → provider/page detection →
// metadata extraction → normalized TrackReference → matching →
// deduplication → ranking. Never blocks provider search; every failure
// degrades to "empty discovery list". Emits scrubbed diagnostics.

import { logger } from '../core/logger';
import { scrubDiscoveryUrl, hashQuerySync } from './ssrfGuard';
import {
  registerBuiltinWebSearch,
  searchWeb,
  type WebSearchOptions,
} from './webSearch';
import { registerBuiltinWebPageProviders } from './providerDetector';
import { resolveMusicPage } from './pageResolver';
import { dedupeReferences, scoreDiscoveryMatch } from './trackMatcher';
import { readDiscoveryCache } from './discoveryCache';
import { normalizeKeyPart } from '../search/normalizeQuery';
import { parseQuery } from '../search/queryParser';
import { scoreTrack } from '../search/relevance';
import type { Song } from '../core/types';
import type { TrackReference } from './types';

export interface LiveDiscoveryOptions extends WebSearchOptions {
  /** Max pages to resolve (default 6). */
  maxPages?: number;
  /** Overall discovery budget (default 8s). */
  overallTimeoutMs?: number;
  /** When set, resolved references are confidence-scored against these songs. */
  matchAgainst?: Song[];
  fetchImpl?: typeof fetch;
}

export interface LiveDiscoveryOutcome {
  references: TrackReference[];
  failures: string[];
  timedOut: boolean;
}

/**
 * Per-run pipeline counters for development diagnostics (§14).
 * Counts only — never URLs, queries, or content. Read via
 * getLastDiscoveryStats() (devtools/tests).
 */
export interface DiscoveryPipelineStats {
  urlsFound: number;
  pagesAttempted: number;
  pagesFetched: number;
  pagesParsed: number;
  candidatesCreated: number;
  matched: number;
  filtered: number;
  merged: number;
  rendered: number;
  failures: string[];
}

let lastStats: DiscoveryPipelineStats | null = null;

/** Last run's pipeline counters (null before the first run). */
export function getLastDiscoveryStats(): DiscoveryPipelineStats | null {
  return lastStats;
}

function ensureBuiltin(): void {
  registerBuiltinWebSearch();
  registerBuiltinWebPageProviders();
}

function rankReferences(refs: TrackReference[], rawQuery: string): TrackReference[] {
  const parsed = parseQuery(rawQuery);
  return refs
    .map((r, i) => {
      const { relevanceScore } = scoreTrack(
        { title: r.title, artist: r.artist, album: r.album },
        parsed,
      );
      // Completeness bonus (metadata richness) — never outranks text match.
      let bonus = relevanceScore;
      if (r.artist) bonus += 2;
      if (r.durationMs) bonus += 1;
      if (r.artwork) bonus += 1;
      return { r: { ...r, matchConfidence: relevanceScore }, i, bonus };
    })
    .sort((a, b) => b.bonus - a.bonus || (a.r.title ?? '').localeCompare(b.r.title ?? '') || a.i - b.i)
    .map((x) => x.r);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout>;
  const gate = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([p.then((value) => ({ done: true as const, value })), gate]).finally(() =>
    clearTimeout(timer!),
  );
}

/**
 * Run live web discovery for one query. Never throws and never rejects —
 * failures yield an empty reference list so provider search continues.
 */
export async function discoverWebReferences(
  rawQuery: string,
  opts: LiveDiscoveryOptions = {},
): Promise<LiveDiscoveryOutcome> {
  ensureBuiltin();
  const started = Date.now();
  const q = (rawQuery ?? '').trim().slice(0, 256);
  const qHash = hashQuerySync(q);
  const overallMs = opts.overallTimeoutMs ?? 8000;
  const maxPages = Math.min(opts.maxPages ?? 6, 8);
  const stats: DiscoveryPipelineStats = {
    urlsFound: 0,
    pagesAttempted: 0,
    pagesFetched: 0,
    pagesParsed: 0,
    candidatesCreated: 0,
    matched: 0,
    filtered: 0,
    merged: 0,
    rendered: 0,
    failures: [],
  };
  const finish = (outcome: LiveDiscoveryOutcome): LiveDiscoveryOutcome => {
    stats.rendered = outcome.references.length;
    stats.failures = [...outcome.failures];
    lastStats = { ...stats };
    return outcome;
  };
  logger.debug('discovery', 'discovery_started', { qHash });
  logger.debug('discovery', 'WEB_SEARCH_STARTED', { qHash });
  if (!q) return finish({ references: [], failures: [], timedOut: false });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const overall = setTimeout(() => controller.abort(), overallMs);

  try {
    const searchP = searchWeb(q, {
      signal: controller.signal,
      timeoutMs: Math.min(opts.timeoutMs ?? 6000, overallMs - 500),
      limit: maxPages * 2,
      fetchImpl: opts.fetchImpl,
    });
    const searchR = await withTimeout(searchP, overallMs - 300);
    if (!searchR.done) {
      logger.warn('discovery', 'discovery_timeout', { qHash, elapsedMs: Date.now() - started });
      return finish({ references: [], failures: ['timeout'], timedOut: true });
    }
    const { results, failures } = searchR.value;
    stats.urlsFound = results.length;
    logger.debug('discovery', 'WEB_SEARCH_RESULTS', { qHash, count: results.length, failures });
    if (results.length === 0) {
      logger.debug('discovery', 'discovery_completed', { qHash, count: 0, elapsedMs: Date.now() - started });
      return finish({ references: [], failures, timedOut: false });
    }

    // Resolve pages in parallel (bounded), each isolated.
    const slice = results.slice(0, maxPages);
    stats.pagesAttempted = slice.length;
    logger.debug('discovery', 'WEB_PAGE_FETCH_STARTED', { qHash, count: slice.length });
    const settled = await Promise.allSettled(
      slice.map((r) =>
        withTimeout(
          resolveMusicPage(r.url, { signal: controller.signal, fetchImpl: opts.fetchImpl }),
          7000,
        ),
      ),
    );
    const resolved: TrackReference[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status !== 'fulfilled' || !s.value.done || !s.value.value) {
        // Fall back to the search-result metadata itself when the page fetch
        // fails but the search row already carries title/artist + a known
        // music-page URL shape. Still reference-only (never playable).
        const fb = slice[i];
        try {
          const { detectMusicPage } = await import('./providerDetector');
          const detected = detectMusicPage(fb.url);
          if (detected && (fb.title || fb.artist)) {
            const cached = readDiscoveryCache(detected.canonicalUrl);
            if (cached) {
              resolved.push(cached);
              continue;
            }
            resolved.push({
              provider: detected.webProviderId,
              providerId: detected.pageId ?? fb.providerId,
              title: fb.title,
              artist: fb.artist,
              album: fb.album,
              durationMs: fb.durationMs,
              artwork: fb.artwork,
              canonicalUrl: detected.canonicalUrl,
              originalDiscoveredUrl: fb.url,
              sourceType: 'web',
              // Carried catalog-API metadata — no page HTML was fetched.
              origin: fb.origin ?? 'catalog',
              playable: false,
              downloadable: false,
              cacheable: false,
              site: detected.displayName,
            });
          } else {
            logger.debug('discovery', 'discovery_parser_failed', {
              host: scrubDiscoveryUrl(fb.url),
            });
          }
        } catch {
          logger.debug('discovery', 'discovery_parser_failed', { host: scrubDiscoveryUrl(fb.url) });
        }
        continue;
      }
      const ref = s.value.value;
      // Enrich sparse page parses with the search row's own metadata:
      // the page was genuinely fetched + parsed (origin stays 'web'),
      // but static HTML often omits the artist that the catalog row
      // already carries. Only MISSING fields are filled — parsed values
      // (title, canonical URL, provider) always win. Never invents audio:
      // refs stay playable=false downstream.
      const fb = slice[i];
      if (!ref.artist && fb.artist) ref.artist = fb.artist;
      if (!ref.album && fb.album) ref.album = fb.album;
      if (!ref.durationMs && fb.durationMs) ref.durationMs = fb.durationMs;
      if (!ref.artwork && fb.artwork) ref.artwork = fb.artwork;
      resolved.push(ref);
    }

    stats.pagesFetched = resolved.length;
    stats.pagesParsed = resolved.length;
    stats.candidatesCreated = resolved.length;
    logger.debug('discovery', 'WEB_PAGE_FETCHED', { qHash, count: resolved.length });
    logger.debug('discovery', 'WEB_PAGE_PARSED', { qHash, count: resolved.length });

    // Drop references with no usable identity.
    const usable = resolved.filter((r) => {
      const ok = !!(r.title && r.title.trim()) || !!(r.providerId && r.canonicalUrl);
      if (!ok) {
        stats.filtered += 1;
        logger.debug('discovery', 'discovery_result_rejected', { reason: 'invalid-metadata' });
      }
      return ok;
    });
    stats.matched = usable.length;
    logger.debug('discovery', 'WEB_CANDIDATE_MATCHED', { qHash, count: usable.length });

    // Optional confidence scoring against provider songs (for "Find Playable
    // Version" ranking) — never merges automatically here.
    if (opts.matchAgainst && opts.matchAgainst.length > 0) {
      for (const r of usable) {
        let best = 0;
        for (const s of opts.matchAgainst) {
          const m = scoreDiscoveryMatch(r, s);
          if (m.confidence > best) best = m.confidence;
        }
        r.matchConfidence = best;
      }
    }

    const merged = dedupeReferences(usable);
    stats.merged = merged.length;
    logger.debug('discovery', 'WEB_CANDIDATE_MERGED', { qHash, count: merged.length });
    const ranked = rankReferences(merged, q);
    logger.debug('discovery', 'discovery_completed', {
      qHash,
      count: ranked.length,
      elapsedMs: Date.now() - started,
    });
    void normalizeKeyPart;
    return finish({ references: ranked, failures, timedOut: false });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || controller.signal.aborted) {
      logger.warn('discovery', 'discovery_timeout', { qHash, elapsedMs: Date.now() - started });
      return finish({ references: [], failures: ['timeout'], timedOut: true });
    }
    logger.warn('discovery', 'discovery_completed', { qHash, count: 0, elapsedMs: Date.now() - started });
    return finish({ references: [], failures: ['error'], timedOut: false });
  } finally {
    clearTimeout(overall);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Convert a TrackReference to a discovery-only Song view for the UI. */
export function discoveryToSong(ref: TrackReference): Song {
  const site = ref.site ?? ref.provider;
  const id = `web-${ref.provider}:${BufferSafe(ref.canonicalUrl)}`;
  return {
    id,
    providerId: `web-${ref.provider}`,
    providerTrackId: ref.providerId ?? ref.canonicalUrl,
    title: ref.title?.trim() || 'Unknown title',
    artist: ref.artist?.trim() || 'Unknown artist',
    album: ref.album?.trim() || '',
    durationMs: typeof ref.durationMs === 'number' && ref.durationMs > 0 ? Math.round(ref.durationMs) : 0,
    artworkUrl: ref.artwork,
    sourceUrl: ref.canonicalUrl,
    downloadAllowed: false,
    streamType: undefined,
    previewOnly: false,
    year: ref.year,
    addedAt: Date.now(),
    relevanceScore: ref.matchConfidence,
    capabilities: {
      searchable: true,
      streamable: false,
      downloadable: false,
      offline: false,
      previewOnly: false,
    },
    genre: site ? `Web reference · ${site}` : 'Web reference',
  } as Song;
}

function BufferSafe(s: string): string {
  // Stable short id from URL (no crypto dependency in UI path).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Re-export the pipeline pieces for tests/consumers.
export { searchWeb } from './webSearch';
export type { TrackReference };
