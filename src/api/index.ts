// knox API — single import surface for UI code.
//
//   import { searchApi, playerApi, radioApi } from '../api';
//
// Components must use these facades, never `fetch(providerUrl)` and never
// provider classes directly. Transport (in-process Core vs IPC vs localhost
// HTTP) is invisible to callers.

export * from './client';
export { searchApi, type SearchKind, type SearchResult } from './search';
export { playerApi } from './player';
export { radioApi } from './radio';
export { lyricsApi } from './lyrics';
export { libraryApi, playlistsApi, favoritesApi, historyApi } from './library';
export { downloadsApi } from './downloads';
export { settingsApi } from './settings';
