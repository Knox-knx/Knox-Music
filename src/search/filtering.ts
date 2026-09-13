// Scoped search view: provider filter + failure attribution (pure, testable).
//
// Rules (§4):
// - The selected provider id is compared against `result.providerId` only —
//   never against display labels.
// - Discovery-only results (stream === false, e.g. YouTube Music) are valid
//   search results: capability filtering never removes them here.
// - Failures are scoped to the active filter. An unrelated provider being
//   down must not hide valid results, must not trigger a false "all sources
//   down" state, and must not nag while the user browses a healthy source.
// - "No results" is true only when the *visible* (filtered) set is empty.
// - "All sources" shows every provider's results, including youtube-music.
// - A provider-only filter shows only that provider's results.

import type { Album, Artist, Playlist, Song } from '../core/types';

export const ONLINE_PROVIDER_IDS = [
  'jamendo',
  'internet-archive',
  'freetouse',
  'airbeats',
  'youtube-music',
] as const;

export interface ScopedSearchInput {
  songs: Song[];
  artists: Artist[];
  albums: Album[];
  playlists: Playlist[];
  /** Provider ids that reported a failure for this search. */
  failures: string[];
  /** 'all' or a concrete provider id (compared against result.providerId). */
  providerFilter: string;
  /** Ids of currently enabled providers. */
  enabledIds: string[];
  loading: boolean;
  error: string | null;
  query: string;
}

export interface ScopedSearchView {
  visibleSongs: Song[];
  visibleArtists: Artist[];
  visibleAlbums: Album[];
  visiblePlaylists: Playlist[];
  /** Failures relevant to the active filter (empty when healthy). */
  scopedFailures: string[];
  /** Scoped failures restricted to online providers. */
  onlineFailures: string[];
  /** True only when the visible (filtered) set is genuinely empty. */
  visibleEmpty: boolean;
  /** True when every *relevant* source failed (scoped, never global). */
  allFailed: boolean;
}

export function scopeSearchView(input: ScopedSearchInput): ScopedSearchView {
  const {
    songs, artists, albums, playlists, failures, providerFilter,
    enabledIds, loading, error, query,
  } = input;
  const filtered = providerFilter !== 'all';
  const visibleSongs = filtered ? songs.filter((s) => s.providerId === providerFilter) : songs;
  const visibleArtists = filtered ? artists.filter((a) => a.providerId === providerFilter) : artists;
  const visibleAlbums = filtered ? albums.filter((a) => a.providerId === providerFilter) : albums;
  const visiblePlaylists = filtered
    ? playlists.filter((p) => (p.providerId ?? '') === providerFilter)
    : playlists;

  // Accuracy (§19): a provider that actually delivered results for this
  // search is never reported as failed — a failure in one kind (e.g.
  // artists) must not taint its successful songs.
  const succeededIds = new Set<string>();
  for (const s of songs) if (s?.providerId) succeededIds.add(s.providerId);
  for (const a of artists) if (a?.providerId) succeededIds.add(a.providerId);
  for (const a of albums) if (a?.providerId) succeededIds.add(a.providerId);
  for (const p of playlists) if (p?.providerId) succeededIds.add(p.providerId);
  const honestFailures = failures.filter((f) => !succeededIds.has(f));
  const scopedFailures = filtered ? honestFailures.filter((f) => f === providerFilter) : [...honestFailures];
  const onlineFailures = scopedFailures.filter((f) => (ONLINE_PROVIDER_IDS as readonly string[]).includes(f));
  const scopedOnlineEnabled = filtered
    ? (ONLINE_PROVIDER_IDS as readonly string[]).includes(providerFilter) && enabledIds.includes(providerFilter) ? 1 : 0
    : enabledIds.filter((id) => (ONLINE_PROVIDER_IDS as readonly string[]).includes(id)).length;
  const scopedEnabled = filtered ? (enabledIds.includes(providerFilter) ? 1 : 0) : enabledIds.length;

  const visibleEmpty = !loading && !error && query.trim().length > 0
    && visibleSongs.length === 0 && visibleArtists.length === 0
    && visibleAlbums.length === 0 && visiblePlaylists.length === 0;
  const allOnlineFailed = visibleEmpty && scopedOnlineEnabled > 0 && onlineFailures.length >= scopedOnlineEnabled;
  const allFailed = allOnlineFailed
    || (visibleEmpty && scopedFailures.length > 0 && scopedFailures.length >= Math.max(1, scopedEnabled));

  return {
    visibleSongs, visibleArtists, visibleAlbums, visiblePlaylists,
    scopedFailures, onlineFailures, visibleEmpty, allFailed,
  };
}
