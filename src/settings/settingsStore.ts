import { create } from 'zustand';
import { settingsRepo } from '../data/repositories';
import type { RepeatMode } from '../core/states';
import type { SmartCacheAutoClear } from '../cache/cacheTypes';
import { SMART_CACHE_AUTO_CLEAR_DEFAULT } from '../cache/cacheTypes';

export type UIStyle =
  | 'glassmorphism'
  | 'claymorphism'
  | 'neubrutalism'
  | 'pixel_art'
  | 'spatial_ui'
  | 'neomorphism';

export type LiveWallpaperPreset =
  | 'aurora_prism'
  | 'cyber_waves'
  | 'neon_nebula'
  | 'custom'
  | 'normal_default'
  | 'normal_custom';

export type WallpaperMode = 'video' | 'normal';

export interface KnoxSettings {
  theme: 'dark' | 'light' | 'system';
  uiStyle: UIStyle;
  accent: 'dynamic' | 'default' | 'custom';
  customAccent: string;
  animations: boolean;
  blur: boolean;
  compact: boolean;
  /** Battery-efficient live/custom wallpaper background in Glassmorphism UI. */
  liveWallpaperEnabled: boolean;
  wallpaperMode: WallpaperMode;
  liveWallpaperPreset: LiveWallpaperPreset;
  customLiveWallpaperName: string;
  customLiveWallpaperType: 'video' | 'image' | '';
  customLiveWallpaperUrl: string;
  customVideoWallpaperName: string;
  customNormalWallpaperName: string;
  autoplay: boolean;
  /** YouTube Up Next: playing a YouTube song auto-queues the playlist and
   *  downloads all tracks in the background (Settings → Playback). */
  youtubeUpNext: boolean;
  /** Persisted repeat mode (Settings → Playback → Repeat). Player store syncs to this. */
  repeatMode: RepeatMode;
  gapless: boolean;  crossfade: boolean;
  crossfadeSec: number;
  normalize: boolean;
  rememberPosition: boolean;
  autoSavePlayed: boolean;
  outputDeviceId: string;
  wifiOnly: boolean;
  offlineQuality: 'Low' | 'Normal' | 'High' | 'Best Available';
  maxOfflineBytes: number; // -1 = unlimited
  autoCleanup: boolean;
  cacheTtlDays: number;
  unplayedTtlDays: number; // -1 = never
  maxConcurrentDownloads: number;
  // --- Smart Cache: automatic persistent playback cache (bounded,
  // disposable). STRICTLY separate from explicit offline downloads, which
  // live separately and are never auto-deleted.
  /** Smart Cache master switch (Settings → Playback). Default true. */
  smartCacheEnabled: boolean;
  /** Max Smart Cache bytes before LRU eviction. Default 512 MB. */
  maxSmartCacheBytes: number;
  /** Smart Cache entry age retention in days. Default 30. */
  smartCacheTtlDays: number;
  /**
   * Smart Cache auto-clear after playback (Settings → Playback → Smart
   * Cache). Default "immediate": the entry is removed right after its
   * natural end. Existing installs without a value migrate to "immediate".
   */
  smartCacheAutoClear: SmartCacheAutoClear;
  requestTimeoutSec: number;
  launchOnStartup: boolean;
  resumePrevious: boolean;
  resumeAutoplay: boolean;
  notifDownloadComplete: boolean;
  notifDownloadFailed: boolean;
  notifPlayback: boolean;
  providersEnabled: Record<string, boolean>;
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: KnoxSettings = {
  theme: 'dark',
  uiStyle: 'glassmorphism',
  accent: 'default',
  customAccent: '#8b5cf6',
  animations: true,
  blur: true,
  compact: false,
  liveWallpaperEnabled: true,
  wallpaperMode: 'video',
  liveWallpaperPreset: 'aurora_prism',
  customLiveWallpaperName: '',
  customLiveWallpaperType: '',
  customLiveWallpaperUrl: '',
  customVideoWallpaperName: '',
  customNormalWallpaperName: '',
  autoplay: true,
  youtubeUpNext: true,
  repeatMode: 'OFF',
  gapless: true,
  crossfade: false,
  crossfadeSec: 5,
  normalize: false,
  rememberPosition: true,
  autoSavePlayed: false,
  outputDeviceId: 'default',
  wifiOnly: true,
  offlineQuality: 'High',
  maxOfflineBytes: 5 * 1024 * 1024 * 1024,
  autoCleanup: false,
  cacheTtlDays: 7,
  unplayedTtlDays: -1,
  maxConcurrentDownloads: 2,
  requestTimeoutSec: 15,
  smartCacheEnabled: true,
  maxSmartCacheBytes: 512 * 1024 * 1024,
  smartCacheTtlDays: 30,
  smartCacheAutoClear: SMART_CACHE_AUTO_CLEAR_DEFAULT,
  launchOnStartup: false,
  resumePrevious: true,
  resumeAutoplay: false,
  notifDownloadComplete: true,
  notifDownloadFailed: true,
  notifPlayback: true,
  providersEnabled: {
    local: true,
    sample: true,
    youtube: true,
    'youtube-music': true,
    spotify: true,
    jiosaavn: true,
    lrclib: true,
    'radio-browser': true,
  },
  onboarded: false,
};

interface SettingsStore extends KnoxSettings {
  loaded: boolean;
  load: () => Promise<void>;
  patch: (p: Partial<KnoxSettings>) => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KnoxSettings)[]) {
      (merged as Record<string, unknown>)[key] = await settingsRepo.get(`settings.${key}`, DEFAULT_SETTINGS[key]);
    }
    // Migrate legacy customLiveWallpaperName into video/normal name fields if needed
    if (merged.customLiveWallpaperName && !merged.customVideoWallpaperName && !merged.customNormalWallpaperName) {
      if (merged.customLiveWallpaperType === 'image') {
        merged.customNormalWallpaperName = merged.customLiveWallpaperName;
      } else {
        merged.customVideoWallpaperName = merged.customLiveWallpaperName;
      }
    }
    if (merged.wallpaperMode !== 'video' && merged.wallpaperMode !== 'normal') {
      merged.wallpaperMode = merged.customLiveWallpaperType === 'image' ? 'normal' : 'video';
    }
    // Migrate removed provider toggles and ensure in-app servers are present.
    const pe = { ...(merged.providersEnabled ?? {}) } as Record<string, boolean>;
    delete pe['airbeats'];
    delete pe['freetouse'];
    delete pe['jamendo'];
    delete pe['internet-archive'];
    if (!('youtube' in pe)) pe['youtube'] = true;
    if (!('youtube-music' in pe)) pe['youtube-music'] = true;
    if (!('spotify' in pe)) pe['spotify'] = true;
    if (!('jiosaavn' in pe)) pe['jiosaavn'] = true;
    merged.providersEnabled = pe;
    // Migrate Smart Cache auto-clear: existing installs without a value (or
    // with an unknown value) default to "immediate". Never resets unrelated
    // settings — only this key is normalized.
    {
      const raw = (merged as Record<string, unknown>).smartCacheAutoClear;
      merged.smartCacheAutoClear =
        raw === 'immediate' || raw === '1h' || raw === '6h' || raw === '24h' || raw === 'never'
          ? (raw as typeof merged.smartCacheAutoClear)
          : SMART_CACHE_AUTO_CLEAR_DEFAULT;
    }
    set({ ...merged, loaded: true });
    applyTheme(merged.theme);
    applyUIStyle(merged.uiStyle || 'glassmorphism');
    // One-time migration: drop the retired Temporary Playback tuning key
    // (Smart Cache needs no retention-minutes concept). Best-effort, never
    // blocks settings load.
    void (async () => {
      try {
        const db = (await import('../data/db')).getDb();
        await db.settings.delete('settings.tempPlaybackRetentionMinutes').catch(() => undefined);
      } catch { /* migration is best-effort */ }
    })();
  },
  patch: async (p) => {
    set(p);
    for (const [k, v] of Object.entries(p)) {
      await settingsRepo.set(`settings.${k}`, v);
    }
    if (p.theme) applyTheme(p.theme);
    if (p.uiStyle) applyUIStyle(p.uiStyle);
  },
}));

export function applyTheme(theme: KnoxSettings['theme']) {
  const root = document.documentElement;
  const effective = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  root.dataset.theme = effective;
  if (root.dataset.uiStyle === 'claymorphism') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#e4d8c8');
  } else if (root.dataset.uiStyle === 'neubrutalism') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#fffdf0');
  } else if (root.dataset.uiStyle === 'pixel_art') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#131024');
  } else if (root.dataset.uiStyle === 'spatial_ui') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#070916');
  } else if (root.dataset.uiStyle === 'neomorphism') {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#1c202b');
  } else {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'light' ? '#ffffff' : '#0b0b12');
  }
}

export function applyUIStyle(style: UIStyle) {
  const root = document.documentElement;
  const s = style || 'glassmorphism';
  root.dataset.uiStyle = s;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (s === 'claymorphism') {
    metaTheme?.setAttribute('content', '#e4d8c8');
  } else if (s === 'neubrutalism') {
    metaTheme?.setAttribute('content', '#fffdf0');
  } else if (s === 'pixel_art') {
    metaTheme?.setAttribute('content', '#131024');
  } else if (s === 'spatial_ui') {
    metaTheme?.setAttribute('content', '#070916');
  } else if (s === 'neomorphism') {
    metaTheme?.setAttribute('content', '#1c202b');
  } else {
    const theme = useSettings.getState().theme;
    applyTheme(theme);
  }
}

export function qualityBytesPerSong(q: KnoxSettings['offlineQuality']): number {
  switch (q) {
    case 'Low': return 3 * 1024 * 1024;
    case 'Normal': return 5 * 1024 * 1024;
    case 'High': return 8 * 1024 * 1024;
    case 'Best Available': return 15 * 1024 * 1024;
  }
}

export function useSetting<K extends keyof KnoxSettings>(key: K): KnoxSettings[K] {
  return useSettings((s) => s[key]);
}
