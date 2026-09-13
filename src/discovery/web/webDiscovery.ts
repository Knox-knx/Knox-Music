// Web Discovery — orchestrator.
//
// USER QUERY → WEB SEARCH ADAPTER → SEARCH RESULTS → PUBLIC PAGE FETCH →
// HTML PARSER → STRUCTURED METADATA → PROVIDER DETECTION → MUSIC MATCHING →
// WEB CANDIDATE → KNOX RANKING.
//
// Produces actual public-web references (e.g. query "hardy sandhu soch"
// may discover a page with Soch/Hardy Sandhu). Reference-only:
// sourceKind=web-reference, playable=false. Never blocks provider search;
// every failure degrades honestly. Bounded: max 8–12 candidates, per-page
// timeout, overall budget, AbortController, short-lived cache.

import { logger } from '../../core/logger';
import { hashQuerySync } from '../ssrfGuard';
import { searchWeb, registerBuiltinWebSearch } from '../webSearch';
import { registerBuiltinWebPageProviders } from '../providerDetector';
import { resolveMusicPage } from '../pageResolver';
import { dedupeReferences } from '../trackMatcher';
import { parseQuery } from '../../search/queryParser';
import { scoreTrack } from '../../search/relevance';
import type { TrackReference } from '../types';
import type { WebCandidate } from './types';
import { candidateFromReference } from './webCandidate';
import { scoreWebCandidate } from './musicPageMatcher';
import { readWebDiscoveryCache, writeWebDiscoveryCache } from './webDiscoveryCache';

export interface WebDiscoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxPages?: number;
  overallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface WebDiscoveryOutcome {
  candidates: WebCandidate[];
  references: TrackReference[];
  failures: string[];
  timedOut: boolean;
  /** True when no adapter/backend was available (honest unavailable state). */
  unavailable: boolean;
}

function ensureBuiltin(): void {
  registerBuiltinWebSearch();
  registerBuiltinWebPageProviders();
}

function rankCandidates(cands: WebCandidate[], rawQuery: string): WebCandidate[] {
  const parsed = parseQuery(rawQuery);
  return cands
    .map((c, i) => {
      const { relevanceScore } = scoreTrack(
        { title: c.title, artist: c.artist, album: c.album },
        parsed,
      );
      let bonus = relevanceScore + c.metadataConfidence * 4;
      if (c.artist) bonus += 2;
      if (c.durationMs) bonus += 1;
      if (c.artwork) bonus += 1;
      return { c: { ...c, metadataConfidence: Math.min(1, relevanceScore / 100 + c.metadataConfidence * 0.2) }, i, bonus, relevanceScore };
    })
    .sort((a, b) => b.bonus - a.bonus || (a.c.title ?? '').localeCompare(b.c.title ?? '') || a.i - b.i)
    .map((x) => x.c);
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
 * Run web discovery for one query. Never throws. Returns candidates plus
 * the underlying TrackReferences for UI compat. When no search backend is
 * configured/available, returns { unavailable: true } — never faked.
 */
export async function discoverWebCandidates(
  rawQuery: string,
  opts: WebDiscoveryOptions = {},
): Promise<WebDiscoveryOutcome> {
  ensureBuiltin();
  const started = Date.now();
  const q = (rawQuery ?? '').trim().slice(0, 256);
  const qHash = hashQuerySync(q);
  logger.debug('discovery', 'discovery_started', { qHash });
  if (!q) return { candidates: [], references: [], failures: [], timedOut: false, unavailable: false };

  // Short-lived query cache (metadata only).
  try {
    const cached = readWebDiscoveryCache(q);
    if (cached) return { candidates: cached, references: [], failures: [], timedOut: false, unavailable: false };
  } catch {
    /* cache never breaks discovery */
  }

  const overallMs = opts.overallTimeoutMs ?? 8000;
  const maxPages = Math.min(opts.maxPages ?? 6, 8);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const overall = setTimeout(() => controller.abort(), overallMs);

  try {
    const { listWebSearchProviders } = await import('../webSearch');
    if (listWebSearchProviders().length === 0) {
      return { candidates: [], references: [], failures: ['web-discovery-unavailable'], timedOut: false, unavailable: true };
    }
    const searchP = searchWeb(q, {
      signal: controller.signal,
      timeoutMs: Math.min(opts.timeoutMs ?? 6000, overallMs - 500),
      limit: maxPages * 2,
      fetchImpl: opts.fetchImpl,
    });
    const searchR = await withTimeout(searchP, overallMs - 300);
    if (!searchR.done) {
      logger.warn('discovery', 'discovery_timeout', { qHash, elapsedMs: Date.now() - started });
      return { candidates: [], references: [], failures: ['timeout'], timedOut: true, unavailable: false };
    }
    const { results, failures } = searchR.value;
    if (results.length === 0) {
      const unavailable = failures.length === 0;
      logger.debug('discovery', 'discovery_completed', { qHash, count: 0, elapsedMs: Date.now() - started });
      return {
        candidates: [],
        references: [],
        failures,
        timedOut: false,
        unavailable,
      };
    }
    const slice = results.slice(0, maxPages);
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
      if (s.status === 'fulfilled' && s.value.done && s.value.value) resolved.push(s.value.value);
    }
    const usable = dedupeReferences(resolved.filter((r) => (r.title?.trim() || r.providerId) && r.canonicalUrl));
    // Music matching: reject unrelated pages (title/artist/duration/tokens).
    const matched = usable.filter((r) => {
      const c = candidateFromReference(r);
      return scoreWebCandidate(c, q).confidence >= 25;
    });
    const candidates = rankCandidates(matched.map(candidateFromReference), q).slice(0, 12);
    try {
      writeWebDiscoveryCache(q, candidates);
    } catch {
      /* ignore */
    }
    logger.debug('discovery', 'discovery_completed', {
      qHash,
      count: candidates.length,
      elapsedMs: Date.now() - started,
    });
    return { candidates, references: matched, failures, timedOut: false, unavailable: false };
  } catch (e) {
    if ((e as Error)?.name === 'AbortError' || controller.signal.aborted) {
      return { candidates: [], references: [], failures: ['timeout'], timedOut: true, unavailable: false };
    }
    return { candidates: [], references: [], failures: ['error'], timedOut: false, unavailable: false };
  } finally {
    clearTimeout(overall);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Compat: TrackReference outcome (used by SearchScreen/api). */
export async function discoverWebReferencesCompat(
  rawQuery: string,
  opts: WebDiscoveryOptions = {},
): Promise<{ references: TrackReference[]; failures: string[]; timedOut: boolean }> {
  const out = await discoverWebCandidates(rawQuery, opts);
  return { references: out.references, failures: out.failures, timedOut: out.timedOut };
}
