// AirBeats health — lightweight reachability probe.
//
// A single short-timeout search against the live API; never hammers it
// (no retries, 5s cap, no polling here — callers decide cadence and the
// ProviderHealthManager owns cooldown/recovery). Never throws: failures
// surface as a state, and playback is never touched.

import { logger } from '../../core/logger';
import { fetchJson } from '../http';
import { providerEnv } from '../env';
import { AIRBEATS_PROVIDER_ID } from './types';

export type AirbeatsHealthState = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';

export interface AirbeatsHealth {
  providerId: string;
  state: AirbeatsHealthState;
  /** Round-trip latency of the probe, when one completed. */
  latencyMs: number | null;
  /** Short diagnostic (never a raw stack trace). */
  detail: string | null;
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * Probe the live API once. AVAILABLE = well-formed success envelope with a
 * results array; DEGRADED = reachable but malformed/empty-contract;
 * UNAVAILABLE = timeout/network/HTTP error. Never throws.
 */
export async function checkAirbeatsHealth(): Promise<AirbeatsHealthState> {
  return (await airbeatsHealth()).state;
}

export async function airbeatsHealth(): Promise<AirbeatsHealth> {
  const started = Date.now();
  const fail = (state: AirbeatsHealthState, detail: string): AirbeatsHealth => ({
    providerId: AIRBEATS_PROVIDER_ID,
    state,
    latencyMs: null,
    detail,
  });
  try {
    const url = `${providerEnv.airbeatsBaseUrl}/api/search/songs?query=${encodeURIComponent('a')}&limit=1`;
    const body = await fetchJson<{ success?: boolean; data?: { results?: unknown } }>(url, {
      timeoutMs: PROBE_TIMEOUT_MS,
      retries: 0,
    });
    const latencyMs = Date.now() - started;
    if (body && body.success === true && Array.isArray(body.data?.results)) {
      return { providerId: AIRBEATS_PROVIDER_ID, state: 'AVAILABLE', latencyMs, detail: null };
    }
    logger.warn('airbeats', 'AIRBEATS_HEALTH degraded (malformed probe response)');
    return { providerId: AIRBEATS_PROVIDER_ID, state: 'DEGRADED', latencyMs, detail: 'Unexpected response shape' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('airbeats', 'AIRBEATS_HEALTH probe failed', msg);
    return fail('UNAVAILABLE', 'AirBeats is temporarily unavailable.');
  }
}
