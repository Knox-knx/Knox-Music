// radioApi — UI entry point for Radio Browser (live, stream-only).
//
// Same AudioEngine, same playerMode ('track' | 'radio'), no second element.
// Radio is never downloadable/offline; seek is a no-op for live streams.
// Failures preserve song state where applicable (see playerStore).

import type { RadioStation } from '../providers/radio/types';
import { getRadioProvider } from '../providers/radio/radioBrowser';
import { useSettings } from '../settings/settingsStore';
import { assertQuery } from './client';

function radioEnabled(): boolean {
  return useSettings.getState().providersEnabled['radio-browser'] !== false;
}

export const radioApi = {
  async search(query: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const q = assertQuery(query);
    if (!radioEnabled()) return [];
    return getRadioProvider().searchStations(q, signal);
  },
  async popular(signal?: AbortSignal): Promise<RadioStation[]> {
    if (!radioEnabled()) return [];
    return getRadioProvider().getPopularStations(signal);
  },
  async byCountry(country: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const c = assertQuery(country, 80);
    if (!radioEnabled()) return [];
    return getRadioProvider().getStationsByCountry(c, signal);
  },
  async byLanguage(language: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const l = assertQuery(language, 80);
    if (!radioEnabled()) return [];
    return getRadioProvider().getStationsByLanguage(l, signal);
  },
  async byTag(tag: string, signal?: AbortSignal): Promise<RadioStation[]> {
    const t = assertQuery(tag, 80);
    if (!radioEnabled()) return [];
    return getRadioProvider().getStationsByTag(t, signal);
  },
  /** Revalidate one station by uuid. False on blank ids or any failure. */
  async checkStation(uuid: string, signal?: AbortSignal): Promise<boolean> {
    const id = uuid.trim().slice(0, 128);
    if (!id) return false;
    if (!radioEnabled()) return false;
    try {
      const station = await getRadioProvider().getStation(id, signal);
      if (!station) return false;
      return getRadioProvider().checkStation(station, signal);
    } catch {
      return false;
    }
  },
};
