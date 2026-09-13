// AirBeats provider — raw API shapes.
//
// Base URL: https://api.airbeats.xyz (no authentication required — verified
// live: no key/token headers, `access-control-allow-origin: *`).
//
// Contract below was observed directly from the live API on 2026-09-09.
// Only endpoints that returned HTTP 200 with `success: true` are modelled:
//   GET /api/search/songs?query=&page=&limit=   → SongSearchResponse
//   GET /api/search/albums?query=&limit=        → AlbumSearchResponse
//   GET /api/search/artists?query=&limit=       → ArtistSearchResponse
//   GET /api/search/playlists?query=&limit=     → PlaylistSearchResponse
//   GET /api/songs/{id}                         → SongDetailResponse (data: SongFull[])
//   GET /api/songs?link=                        → SongDetailResponse
//   GET /api/artists/{id}                       → ArtistDetailResponse
//   GET /api/artists/{id}/songs                 → ArtistSongsResponse
//   GET /api/albums?id=        (QUERY param — path /api/albums/{id} is 404)
//   GET /api/playlists?id=     (QUERY param — path /api/playlists/{id} is 404)
//
// Documented-but-broken live (deliberately NOT modelled as working):
//   GET /api/songs/{id}/lyrics      → 404 "route not found" (even hasLyrics=true)
//   GET /api/songs/{id}/suggestions → 500 "undefined is not an object"

export const AIRBEATS_PROVIDER_ID = 'airbeats';
export const AIRBEATS_PROVIDER_NAME = 'AirBeats';
export const AIRBEATS_DEFAULT_BASE_URL = 'https://api.airbeats.xyz';

/** Per-track copyright is reported by the API; surfaced as Song.license. */
export const AIRBEATS_LICENSE_FALLBACK = 'AirBeats catalog audio — rights belong to the label/copyright holder reported per track';

/** Duration unit reported by the API (verified: 144 ≈ 2:24 song). */
export const AIRBEATS_DURATION_IS_SECONDS = true;

/** Search page/limit behavior observed live. */
export const AIRBEATS_DEFAULT_LIMIT = 20;
export const AIRBEATS_MAX_LIMIT = 50;
export const AIRBEATS_DEFAULT_PAGE = 0;

export interface AirbeatsImage {
  quality?: string;
  url?: string;
}

export interface AirbeatsDownloadVariant {
  quality?: string;
  url?: string;
}

export interface AirbeatsArtistRef {
  id?: string;
  name?: string;
  role?: string;
  image?: AirbeatsImage[];
  type?: string;
  url?: string;
}

export interface AirbeatsArtists {
  primary?: AirbeatsArtistRef[];
  featured?: AirbeatsArtistRef[];
  all?: AirbeatsArtistRef[];
}

export interface AirbeatsAlbumRef {
  id?: string;
  name?: string;
  url?: string;
}

/** Full song record — identical shape in search results and detail. */
export interface AirbeatsSong {
  id?: string;
  name?: string;
  type?: string;
  /** Release year as a string (e.g. "2025"). */
  year?: string | number | null;
  releaseDate?: string | null;
  /** Length in SECONDS (verified). */
  duration?: number | string | null;
  label?: string;
  explicitContent?: boolean;
  playCount?: number | string | null;
  language?: string;
  hasLyrics?: boolean;
  lyricsId?: string | null;
  /** Canonical provider page for this track. */
  url?: string;
  copyright?: string;
  album?: AirbeatsAlbumRef;
  artists?: AirbeatsArtists;
  image?: AirbeatsImage[];
  /** Quality-tiered playable files, ascending (12kbps … 320kbps). */
  downloadUrl?: AirbeatsDownloadVariant[];
}

export interface AirbeatsAlbumResult {
  id?: string;
  name?: string;
  description?: string;
  url?: string;
  year?: number | string | null;
  type?: string;
  playCount?: number | string | null;
  language?: string;
  explicitContent?: boolean;
  artists?: AirbeatsArtists;
  image?: AirbeatsImage[];
}

export interface AirbeatsArtistResult {
  id?: string;
  name?: string;
  role?: string;
  image?: AirbeatsImage[];
  type?: string;
  url?: string;
}

export interface AirbeatsPlaylistResult {
  id?: string;
  name?: string;
  type?: string;
  image?: AirbeatsImage[];
  url?: string;
  songCount?: number | null;
  language?: string;
  explicitContent?: boolean;
}

export interface AirbeatsArtistBio {
  text?: string;
  sequence?: number;
  title?: string;
}

export interface AirbeatsArtistDetail {
  id?: string;
  name?: string;
  url?: string;
  type?: string;
  followerCount?: number | null;
  fanCount?: string | number | null;
  isVerified?: boolean | null;
  dominantLanguage?: string | null;
  dominantType?: string | null;
  bio?: AirbeatsArtistBio[] | null;
  dob?: string | null;
  fb?: string | null;
  twitter?: string | null;
  wiki?: string | null;
  availableLanguages?: string[];
  isRadioPresent?: boolean | null;
  image?: AirbeatsImage[];
  topSongs?: AirbeatsSong[];
}

export interface AirbeatsAlbumDetail extends AirbeatsAlbumResult {
  songCount?: number | null;
  songs?: AirbeatsSong[];
}

export interface AirbeatsPlaylistDetail {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  year?: number | string | null;
  playCount?: number | string | null;
  language?: string;
  explicitContent?: boolean;
  url?: string;
  songCount?: number | null;
  /** Note: playlist detail uses a flat artist array (unlike songs/albums). */
  artists?: AirbeatsArtistRef[];
  image?: AirbeatsImage[];
  songs?: AirbeatsSong[];
}

/** Success envelope: { success: true, data: … } */
export interface AirbeatsSuccess<T> {
  success: true;
  data: T;
}

/** Failure envelope observed live: { success: false, message } or ZodError. */
export interface AirbeatsFailure {
  success: false;
  message?: string;
  error?: { issues?: { path?: (string | number)[]; message?: string }[]; name?: string };
}

export interface AirbeatsSongSearchData {
  total?: number;
  start?: number;
  results?: AirbeatsSong[];
}

export interface AirbeatsAlbumSearchData {
  total?: number;
  start?: number;
  results?: AirbeatsAlbumResult[];
}

export interface AirbeatsArtistSearchData {
  total?: number;
  start?: number;
  results?: AirbeatsArtistResult[];
}

export interface AirbeatsPlaylistSearchData {
  total?: number;
  start?: number;
  results?: AirbeatsPlaylistResult[];
}

export interface AirbeatsArtistSongsData {
  total?: number;
  songs?: AirbeatsSong[];
}

export type AirbeatsSongSearchResponse = AirbeatsSuccess<AirbeatsSongSearchData> & Partial<AirbeatsFailure>;
export type AirbeatsSongDetailResponse = AirbeatsSuccess<AirbeatsSong[]> & Partial<AirbeatsFailure>;
