// YouTube provider barrel — preserves the existing provider-directory
// convention (`src/providers/<name>/provider.ts` + helpers).
export { YouTubeProvider, YOUTUBE_PROVIDER_ID, YOUTUBE_LICENSE } from './provider';
export * from './mapper';
export * from './types';
export {
  ensurePermanentYouTubeTrack,
  getPermanentYouTubeEntry,
  hasPermanentYouTube,
  getYouTubeSidecarBaseUrl,
  isValidYouTubeVideoId,
  youtubeSongId,
  youtubeVideoIdOf,
  isYouTubeSong,
  validateYouTubeAudioBytes,
  useYouTubeProgress,
  YOUTUBE_STAGE_LABEL,
} from './youtubeOffline';
export type { YouTubeDownloadStage, PermanentYouTubeAsset } from './youtubeOffline';