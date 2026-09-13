// Provider abstraction — UI must depend only on this interface, never on a concrete API.
import type { Album, Artist, Playlist, Song, StreamType } from '../core/types';

export interface ProviderCapabilities {
  supportsSearch: boolean;
  supportsStreaming: boolean;
  supportsOffline: boolean;
  supportsLyrics: boolean;
  supportsArtwork: boolean;
  supportsArtists: boolean;
  supportsAlbums: boolean;
  /** Provider supplies rich metadata (titles, artists, artwork). Default true when supportsSearch. */
  supportsMetadata?: boolean;
  /** Provider offers direct downloads (independent from streaming/offline). */
  supportsDownloads?: boolean;
  /** Commercial catalog (e.g. store-backed metadata/previews) — search/metadata
   *  may be YES while download/offline are NO. That is valid. */
  commercialCatalog?: boolean;
  /**
   * True when this provider's streams are short previews only, never the
   * full recording. Preview-only streams are never downloadable or
   * offline-capable.
   */
  previewOnly?: boolean;
  /**
   * DEPRECATED (kept for provider declarations only): the persistent Smart
   * Playback Cache was removed — playback now uses the Temporary Playback
   * Buffer (short-lived, per-playback, auto-deleted). Nothing reads this
   * flag at runtime; per-track offline permission (`allowsOffline`) still
   * governs explicit user downloads.
   */
  supportsPlaybackCache?: boolean;
  /**
   * Preferred cache tier when the provider offers a choice of authorized
   * representations. KNOX never transcodes restricted content to fabricate
   * one — with a single representation the authorized bytes are cached as-is
   * and their real quality is recorded.
   */
  cacheQuality?: 'low' | 'medium' | 'high';
}

/**
 * Normalized provider capability view.
 * SEARCH ≠ STREAMING ≠ DOWNLOAD ≠ OFFLINE — each flag is independent.
 */
export interface NormalizedProviderCapabilities {
  search: boolean;
  metadata: boolean;
  streaming: boolean;
  downloads: boolean;
  offlineStorage: boolean;
  commercialCatalog: boolean;
  /** True when streams from this provider are previews only. */
  previewOnly: boolean;
}

/** Derive the normalized capability view from a provider's declared flags. */
export function normalizeProviderCapabilities(
  caps: ProviderCapabilities,
): NormalizedProviderCapabilities {
  return {
    search: caps.supportsSearch,
    metadata: caps.supportsMetadata ?? caps.supportsSearch,
    streaming: caps.supportsStreaming,
    downloads: caps.supportsDownloads ?? caps.supportsOffline,
    offlineStorage: caps.supportsOffline,
    commercialCatalog: caps.commercialCatalog ?? false,
    previewOnly: caps.previewOnly ?? false,
  };
}

export interface StreamResult {
  url: string;
  mimeType: string;
  quality: string;
  /** True only when the provider license/terms permit local offline storage. */
  allowsOffline: boolean;
  /** Preferred download endpoint when it differs from the stream URL. */
  downloadUrl?: string;
  license?: string;
  sourceUrl?: string;
  /**
   * True when this URL plays only a short preview, not the full recording.
   * Never inferred from duration — set explicitly by the provider.
   */
  previewOnly?: boolean;
  /** Explicit stream kind; mirrors previewOnly. */
  streamType?: StreamType;
  /** Actual playable preview length in ms when this is a preview. */
  previewDurationMs?: number;
}

export interface MusicProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly offlineNotice?: string;
  searchSongs(query: string, signal?: AbortSignal): Promise<Song[]>;
  searchArtists(query: string, signal?: AbortSignal): Promise<Artist[]>;
  searchAlbums(query: string, signal?: AbortSignal): Promise<Album[]>;
  searchPlaylists(query: string, signal?: AbortSignal): Promise<Playlist[]>;
  getSong(providerTrackId: string): Promise<Song | null>;
  getArtist(providerArtistId: string): Promise<Artist | null>;
  getAlbum(providerAlbumId: string): Promise<Album | null>;
  getPlaylist(providerPlaylistId: string): Promise<Playlist | null>;
  getAlbumTracks(providerAlbumId: string): Promise<Song[]>;
  getStream(song: Song): Promise<StreamResult>;
  getArtwork(song: Song): Promise<string | null>;
  getLyrics(song: Song): Promise<{ lines: { timeMs: number; text: string }[]; synced: boolean } | null>;
  /** Per-track offline permission (defaults to getStream().allowsOffline when absent). */
  canDownload?(song: Song): Promise<boolean>;
  /** Direct download URL when it differs from the stream URL. */
  getDownload?(song: Song): Promise<{ url: string; mimeType: string } | null>;
}
