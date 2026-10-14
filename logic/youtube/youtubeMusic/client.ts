// YouTube Music sidecar transport.
//
// Path: KNOX UI → ProviderManager → YouTubeMusicProvider → loopback sidecar
//   → YouTube Music / InnerTube (via bundled stdlib service).
//
// Desktop gateway first (local KNOX API → SidecarManager-owned process on
// its dynamic loopback port), direct sidecar URL as fallback (browser dev /
// manual `python3 app.py`). Returns `undefined` only when both paths fail —
// callers map that to an honest ProviderError (isolated, never a crash).

import { fetchJson } from '../http';
import { providerEnv } from '../env';

export const YOUTUBEMUSIC_SIDECAR_NAME = 'youtubemusic';

export type SidecarPath =
  | 'health'
  | `search`
  | `track/${string}`
  | `artist/${string}`
  | `album/${string}`;

/**
 * GET JSON from the sidecar. `undefined` = unreachable on every path.
 * Never throws for transport failures (callers decide the honest error).
 *
 * Structured upstream failures (`{error: {code, ...}}`, e.g. a 504 TIMEOUT
 * after an InnerTube stall) are RETURNED, not discarded: the provider maps
 * them to honest per-cause errors (TIMEOUT/RATE_LIMIT/NOT_FOUND) instead of
 * misreporting every transient stall as NETWORK "unavailable".
 */
export async function sidecarJson<T>(
  path: SidecarPath,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (signal?.aborted) return undefined;
  try {
    const { isTauri } = await import('../../desktop/detector');
    if (isTauri()) {
      const localApi = await import('../../desktop/localApi').catch(() => null);
      if (localApi) {
        try {
          const data = await localApi.sidecarGetJson<T>(YOUTUBEMUSIC_SIDECAR_NAME, path, query, Math.min(timeoutMs, 20000));
          if (data !== null) {
            if (signal?.aborted) return undefined;
            return data;
          }
          // Gateway unreachable in-shell → fall through to direct below.
        } catch (e) {
          // The sidecar answered through the gateway with a structured error
          // (upstream stall/limit/miss) — hand its body to the caller for
          // honest mapping. Only real transport failures use the direct URL.
          if (localApi.isSidecarUpstreamError(e)) {
            if (signal?.aborted) return undefined;
            return e.body as T;
          }
          /* fall through to direct sidecar URL */
        }
      }
    }
  } catch {
    /* detector import never fails in practice; direct path below */
  }
  if (signal?.aborted) return undefined;
  try {
    return await fetchJson<T>(`${providerEnv.youtubemusicBaseUrl}/api/${path}${query}`, {
      timeoutMs,
      retries: 1,
      signal,
    });
  } catch {
    return undefined;
  }
}
