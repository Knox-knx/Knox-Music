export const en = {
  'app.tagline': 'Your music, your device, your control.',
  'nav.home': 'Home',
  'nav.search': 'Search',
  'nav.library': 'Library',
  'nav.favorites': 'Favorites',
  'nav.playlists': 'Playlists',
  'nav.downloads': 'Downloads',
  'nav.history': 'History',
  'nav.settings': 'Settings',
  'nav.storage': 'Storage',
  'nav.about': 'About',
  'search.placeholder': 'Search songs, artists, albums...',
  'search.empty': 'No results. Try a different search.',
  'player.queue': 'Queue',
  'player.lyrics': 'Lyrics',
  'offline.available': 'Available Offline',
  'offline.unavailable': 'Offline download unavailable',
  'lyrics.unavailable': "Lyrics aren't available for this song.",
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.play': 'Play',
  'common.shuffle': 'Shuffle',
} as const;

export type I18nKey = keyof typeof en;
let lang: Record<string, string> = { ...en };

export function t(key: I18nKey): string {
  return lang[key] ?? en[key] ?? key;
}

export function setLocale(dict: Record<string, string>) {
  lang = { ...en, ...dict };
}
