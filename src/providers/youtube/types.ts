// YouTube provider shapes — normalized for KNOX Music.

export interface YouTubeSearchResult {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  url: string;
  live: boolean;
  thumbnails?: YouTubeThumbnail[];
}

export interface YouTubeThumbnail {
  url: string;
  width: number;
  height: number;
}

export interface YouTubeDownloadResult {
  success: boolean;
  videoId: string;
  filePath?: string;
  title?: string;
  duration?: number;
  sizeBytes?: number;
  format?: string;
  errorCode?: string;
  message?: string;
}

export interface YouTubeProviderConfig {
  maxDurationSeconds: number;
  maxAudioBytes: number;
  downloadTimeoutMs: number;
  searchResults: number;
  tmpDir: string;
}

// Audio service config shape (matches services/audioService.js)
export interface AudioServiceConfig {
  maxAudioDurationSeconds: number;
  maxAudioBytes: number;
  downloadTimeoutMs: number;
  searchResults: number;
  tmpDir: string;
}

// Minimal logger interface
export interface YouTubeLogger {
  info?: (meta: object, msg: string) => void;
  warn?: (meta: object, msg: string) => void;
  error?: (meta: object, msg: string) => void;
  debug?: (meta: object, msg: string) => void;
}