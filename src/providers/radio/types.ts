// Dedicated live-radio provider abstraction. Radio stations are NOT songs:
// no duration, no offline, no download — only a live stream URL.

export interface RadioStation {
  id: string; // `radio-browser:<stationuuid>`
  providerId: 'radio-browser';
  stationUuid: string;
  name: string;
  streamUrl: string;
  homepage?: string;
  favicon?: string;
  country?: string;
  countryCode?: string;
  language?: string;
  tags: string[];
  codec?: string;
  bitrate?: number;
  votes?: number;
  lastCheckOk: boolean;
}

export interface RadioProvider {
  readonly id: 'radio-browser';
  readonly name: string;
  searchStations(query: string, signal?: AbortSignal): Promise<RadioStation[]>;
  getStation(stationUuid: string, signal?: AbortSignal): Promise<RadioStation | null>;
  getPopularStations(signal?: AbortSignal): Promise<RadioStation[]>;
  getStationsByCountry(country: string, signal?: AbortSignal): Promise<RadioStation[]>;
  getStationsByLanguage(language: string, signal?: AbortSignal): Promise<RadioStation[]>;
  getStationsByTag(tag: string, signal?: AbortSignal): Promise<RadioStation[]>;
  /** True when the station recently checked OK (broken stations filtered by default). */
  checkStation(station: RadioStation, signal?: AbortSignal): Promise<boolean>;
  /** Resolve the current playable stream URL (click-count endpoint, with fallback). */
  getPlayableUrl(station: RadioStation, signal?: AbortSignal): Promise<string>;
}
