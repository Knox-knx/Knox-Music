// AirBeats provider — public surface (mirrors the youtubeMusic/ layout).
export { AirbeatsProvider, AIRBEATS_LICENSE, fetchAirbeatsTrackJson } from './provider';
export { airbeatsClient, messageForAirbeatsError, toAirbeatsError } from './client';
export {
  AIRBEATS_DOWNLOAD_UNAVAILABLE,
  AIRBEATS_INVALID_RESPONSE,
  AIRBEATS_AUTH_REQUIRED,
  AIRBEATS_RATE_LIMITED,
  AIRBEATS_STREAM_UNAVAILABLE,
  AIRBEATS_TIMEOUT,
  AIRBEATS_TRACK_NOT_FOUND,
  AIRBEATS_UNAVAILABLE,
} from './client';
export {
  airbeatsDurationMs,
  artistNames,
  mapAirbeatsAlbum,
  mapAirbeatsArtist,
  mapAirbeatsPlaylist,
  mapAirbeatsSong,
  mapAirbeatsSongs,
  pickArtwork,
  pickStreamUrl,
} from './mapper';
export {
  AIRBEATS_DEFAULT_BASE_URL,
  AIRBEATS_PROVIDER_ID,
  AIRBEATS_PROVIDER_NAME,
} from './types';
export type {
  AirbeatsAlbumDetail,
  AirbeatsAlbumResult,
  AirbeatsArtistDetail,
  AirbeatsArtistResult,
  AirbeatsImage,
  AirbeatsPlaylistDetail,
  AirbeatsPlaylistResult,
  AirbeatsSong,
} from './types';
export { airbeatsHealth, checkAirbeatsHealth } from './health';
export type { AirbeatsHealth, AirbeatsHealthState } from './health';
