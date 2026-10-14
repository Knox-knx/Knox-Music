// Explicit state machines — never ambiguous booleans.

export type PlayerState =
  | 'IDLE'
  | 'LOADING'
  | 'PLAYING'
  | 'PAUSED'
  | 'BUFFERING'
  | 'COMPLETED'
  | 'ERROR';

export type DownloadState =
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REMOVED';

export type RepeatMode = 'OFF' | 'ALL' | 'ONE';

export interface OfflineTrackRecord {
  id: string; // song id
  provider: string;
  providerTrackId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  blob: Blob;
  mimeType: string;
  fileSize: number;
  quality: string;
  createdAt: number;
  lastPlayedAt?: number;
  isFavorite: boolean;
}

export interface DownloadRecord {
  id: string; // download id
  songId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  state: DownloadState;
  progress: number; // 0..1
  bytesReceived: number;
  bytesTotal?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}
