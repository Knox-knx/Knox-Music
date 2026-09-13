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
      try {
        const { sidecarGetJson } = await import('../../desktop/localApi');
        const data = await sidecarGetJson<T>(YOUTUBEMUSIC_SIDECAR_NAME, path, query, Math.min(timeoutMs, 20000));
        if (data !== null) {
          if (signal?.aborted) return undefined;
          return data;
        }
        // Gateway unreachable in-shell → fall through to direct below.
      } catch {
        /* fall through to direct sidecar URL */
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
