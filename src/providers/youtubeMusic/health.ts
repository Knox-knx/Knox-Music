// YouTube Music health — lightweight, never hammers InnerTube.
//
// A single short-timeout probe of the loopback sidecar. Health failures
// never throw and never crash KNOX; they surface as provider status.

import { logger } from '../../core/logger';
import { sidecarJson } from './client';

export type YouTubeMusicHealthState =
  | 'available'
  | 'unavailable'
  | 'disabled'
  | 'rate_limited'
  | 'timeout'
  | 'error';

/** Sidecar health probe (short timeout). False = unavailable, never throws. */
export async function checkYouTubeMusicHealth(): Promise<boolean> {
  try {
    const data = await sidecarJson<unknown>('health', '', 3000).catch(() => undefined);
    return data !== undefined;
  } catch (e) {
    logger.warn('youtube-music', 'YOUTUBE_MUSIC health probe failed', String(e));
    return false;
  }
}

export function healthStateFor(ok: boolean, enabled: boolean): YouTubeMusicHealthState {
  if (!enabled) return 'disabled';
  return ok ? 'available' : 'unavailable';
}
