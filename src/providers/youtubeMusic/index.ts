// YouTube Music provider barrel — preserves the existing provider-directory
// convention (`src/providers/<name>/provider.ts` + helpers).
export { YouTubeMusicProvider, YOUTUBE_MUSIC_LICENSE, YOUTUBE_MUSIC_PROVIDER_ID } from './provider';
export * from './mapper';
export * from './types';
export { searchYouTubeMusic, clearYouTubeMusicCache, validateQuery } from './search';
export { checkYouTubeMusicHealth } from './health';
