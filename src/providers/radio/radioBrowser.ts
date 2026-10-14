// Radio Browser provider (https://www.radio-browser.info) — public API, no key.
// Docs: https://api.radio-browser.info
//
// - Broken stations filtered by default (`hidebroken=true` + lastcheckok gate).
// - No station is assumed permanently available: play time re-resolves the
//   stream via /json/url/:uuid and checkStation() revalidates on demand.
// - Radio NEVER supports offline/download — no such actions are exposed.
// - Browsers forbid overriding User-Agent via fetch(); the stock browser UA
//   is sent. Non-browser runtimes should send `KNOX Music/<version>`.

import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { Song } from '../../core/types';
import { fetchJson, requireSafeMediaUrl } from '../http';
import { providerEnv } from '../env';
import type { RadioProvider, RadioStation } from './types';

export const RADIO_PROVIDER_ID = 'radio-browser';
export const RADIO_UA = 'KNOX Music/1.0.0';

interface RbStation {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  language?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
  lastcheckok?: number | string;
}

const asBool = (v: number | string | undefined): boolean => v === 1 || v === '1';

/** Normalize one API record. Null when it can never play (no uuid / no URL). */
export function mapStation(s: RbStation): RadioStation | null {
  const uuid = (s.stationuuid ?? '').trim();
  const url = (s.url_resolved || s.url || '').trim();
  if (!uuid || !url) return null;
  const tags = (s.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    id: `${RADIO_PROVIDER_ID}:${uuid}`,
    providerId: RADIO_PROVIDER_ID,
    stationUuid: uuid,
    name: (s.name ?? '').trim() || 'Unknown station',
    streamUrl: url,
    homepage: s.homepage?.trim() || undefined,
    favicon: s.favicon?.trim() || undefined,
    country: s.country?.trim() || undefined,
    countryCode: s.countrycode?.trim() || undefined,
    language: s.language?.trim() || undefined,
    tags,
    codec: s.codec?.trim() || undefined,
    bitrate: typeof s.bitrate === 'number' && s.bitrate > 0 ? s.bitrate : undefined,
    votes: typeof s.votes === 'number' ? s.votes : undefined,
    lastCheckOk: asBool(s.lastcheckok),
  };
}

/** Song-shaped view so the single global player/queue/history can carry a station. */
export function stationToSong(st: RadioStation): Song {
  return {
    id: st.id,
    providerId: RADIO_PROVIDER_ID,
    providerTrackId: st.stationUuid,
    title: st.name,
    artist: [st.country, st.language].filter(Boolean).join(' • ') || 'Live radio',
    album: st.tags.slice(0, 3).join(', '),
    durationMs: 0, // live: no duration, UI shows LIVE
    artworkUrl: st.favicon,
    streamUrl: st.streamUrl,
    downloadAllowed: false,
    sourceUrl: st.homepage,
    genre: st.tags[0],
    capabilities: { searchable: true, streamable: true, downloadable: false, offline: false, previewOnly: false },
    addedAt: Date.now(),
  };
}

export class RadioBrowserProvider implements RadioProvider {
  readonly id = 'radio-browser' as const;
  readonly name = 'Radio Browser';

  private base(): string {
    return providerEnv.radioBrowserBaseUrl;
  }

  private async list(path: string, signal?: AbortSignal): Promise<RadioStation[]> {
    let data: unknown;
    try {
      data = await fetchJson<unknown>(`${this.base()}${path}`, {
        timeoutMs: providerEnv.requestTimeoutMs, retries: 2, signal,
      });
    } catch (e) {
      logger.warn('radio', `request failed (${path})`, String(e));
      throw e instanceof Error ? e : new Error('Radio request failed');
    }
    if (!Array.isArray(data)) return [];
    const out: RadioStation[] = [];
    for (const item of data as RbStation[]) {
      const st = mapStation(item);
      // Broken stations are filtered by default — never present dead streams.
      if (st && st.lastCheckOk) out.push(st);
    }
    return out;
  }

  async searchStations(query: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({
      name: q, hidebroken: 'true', order: 'votes', reverse: 'true', limit: '20',
    });
    return this.list(`/json/stations/search?${params.toString()}`, signal);
  }

  async getPopularStations(signal?: AbortSignal): Promise<RadioStation[]> {
    return this.list('/json/stations/topvote/20?hidebroken=true', signal);
  }

  async getStationsByCountry(country: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const c = country.trim();
    if (!c) return [];
    return this.list(`/json/stations/bycountry/${encodeURIComponent(c)}?hidebroken=true&order=votes&reverse=true&limit=20`, signal);
  }

  async getStationsByLanguage(language: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const l = language.trim();
    if (!l) return [];
    return this.list(`/json/stations/bylanguage/${encodeURIComponent(l)}?hidebroken=true&order=votes&reverse=true&limit=20`, signal);
  }

  async getStationsByTag(tag: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const t = tag.trim();
    if (!t) return [];
    return this.list(`/json/stations/bytag/${encodeURIComponent(t)}?hidebroken=true&order=votes&reverse=true&limit=20`, signal);
  }

  async getStation(stationUuid: string, signal?: AbortSignal): Promise<RadioStation | null> {
    const uuid = stationUuid.replace(/^radio-browser:/, '').trim();
    if (!uuid) return null;
    const stations = await this.list(`/json/stations/byuuid/${encodeURIComponent(uuid)}`, signal);
    return stations[0] ?? null;
  }

  async checkStation(station: RadioStation, signal?: AbortSignal): Promise<boolean> {
    try {
      const fresh = await this.getStation(station.stationUuid, signal);
      return fresh?.lastCheckOk ?? false;
    } catch {
      return false;
    }
  }

  async getPlayableUrl(station: RadioStation, signal?: AbortSignal): Promise<string> {
    // Click-count endpoint returns the current stream URL; fall back to the
    // last known resolved URL when it fails (never invent a URL).
    try {
      const data = await fetchJson<{ url?: string }>(
        `${this.base()}/json/url/${encodeURIComponent(station.stationUuid)}`,
        { timeoutMs: providerEnv.requestTimeoutMs, retries: 1, signal },
      );
      if (data?.url?.trim()) return requireSafeMediaUrl(data.url.trim());
    } catch (e) {
      logger.warn('radio', 'stream resolve failed, using cached URL', String(e));
    }
    if (!station.streamUrl) throw new ProviderError('NETWORK', 'Station stream is unavailable');
    return requireSafeMediaUrl(station.streamUrl);
  }
}

let singleton: RadioBrowserProvider | null = null;
export function getRadioProvider(): RadioBrowserProvider {
  if (!singleton) singleton = new RadioBrowserProvider();
  return singleton;
}
