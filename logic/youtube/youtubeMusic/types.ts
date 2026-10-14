// YouTube Music sidecar shapes (controlled schema — never raw upstream).
export interface YouTubeMusicTrackJson {
  id?: string; // "youtube-music:<videoId>"
  title?: string;
  artist?: string;
  album?: string;
  duration?: number; // seconds
  artwork?: string | null;
  year?: number | null;
  videoId?: string;
  provider?: string;
  artistId?: string;
  albumId?: string;
}

export interface YouTubeMusicSearchResponse {
  results?: YouTubeMusicTrackJson[];
}

export interface YouTubeMusicTrackResponse {
  track?: YouTubeMusicTrackJson | null;
}

export interface YouTubeMusicArtistResponse {
  artist?: { id?: string; name?: string; provider?: string } | null;
}

export interface YouTubeMusicAlbumResponse {
  album?: { id?: string; title?: string; provider?: string } | null;
}

export interface YouTubeMusicErrorBody {
  error?: { code?: string; message?: string };
}

/** Map a sidecar error code to a stable provider log label. */
export function sidecarErrorLabel(code: string | undefined): string {
  switch ((code ?? '').toUpperCase()) {
    case 'INVALID_QUERY': return 'invalid query';
    case 'TIMEOUT': return 'timeout';
    case 'RATE_LIMITED': return 'rate limited';
    case 'NOT_FOUND': return 'not found';
    case 'INVALID_RESPONSE': return 'bad upstream response';
    case 'UPSTREAM_UNAVAILABLE': return 'upstream unavailable';
    default: return 'unavailable';
  }
}
