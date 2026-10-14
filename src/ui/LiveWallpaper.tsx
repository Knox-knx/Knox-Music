import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../settings/settingsStore';
import { getDb } from '../data/db';
import { settingsRepo } from '../data/repositories';

export const CUSTOM_WALLPAPER_BLOB_KEY = 'custom_live_wallpaper_blob';
export const CUSTOM_VIDEO_WALLPAPER_KEY = 'custom_video_wallpaper_blob';
export const CUSTOM_NORMAL_WALLPAPER_KEY = 'custom_normal_wallpaper_blob';

/** In-memory object URL cache for instant 0ms preview on file selection. */
const memoryWallpaperUrls = new Map<string, string>();

function setMemoryUrl(key: string, blob: Blob | null): string | null {
  const prev = memoryWallpaperUrls.get(key);
  if (prev) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* ignore */
    }
    memoryWallpaperUrls.delete(key);
  }
  if (!blob || blob.size <= 0) return null;
  try {
    const url = URL.createObjectURL(blob);
    memoryWallpaperUrls.set(key, url);
    return url;
  } catch {
    return null;
  }
}

async function fileToPersistedBlob(file: File, defaultMime: string): Promise<{ blob: Blob; mimeType: string }> {
  const mimeType = file.type || defaultMime;
  try {
    const buf = await file.arrayBuffer();
    return { blob: new Blob([buf], { type: mimeType }), mimeType };
  } catch {
    return { blob: new Blob([file], { type: mimeType }), mimeType };
  }
}

async function putWallpaperBlobInDb(key: string, blob: Blob, mimeType: string): Promise<void> {
  const db = getDb();
  await db.artwork.put({
    key,
    blob,
    mimeType,
    updatedAt: Date.now(),
  });
}

async function getWallpaperBlobFromDb(key: string): Promise<Blob | null> {
  try {
    const db = getDb();
    const row = await db.artwork.get(key);
    if (row?.blob instanceof Blob && row.blob.size > 0) {
      return row.blob;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Save a user-selected Video Wallpaper file (MP4/WebM/MOV) and activate Video Wallpaper mode. */
export async function saveCustomVideoWallpaperFile(file: File): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'mp4';
  const defaultMime =
    ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
  const { blob, mimeType } = await fileToPersistedBlob(file, defaultMime);
  setMemoryUrl(CUSTOM_VIDEO_WALLPAPER_KEY, blob);
  setMemoryUrl(CUSTOM_WALLPAPER_BLOB_KEY, blob);
  await putWallpaperBlobInDb(CUSTOM_VIDEO_WALLPAPER_KEY, blob, mimeType);
  await putWallpaperBlobInDb(CUSTOM_WALLPAPER_BLOB_KEY, blob, mimeType);

  await useSettings.getState().patch({
    liveWallpaperEnabled: true,
    wallpaperMode: 'video',
    liveWallpaperPreset: 'custom',
    customVideoWallpaperName: file.name,
    customLiveWallpaperName: file.name,
    customLiveWallpaperType: 'video',
    customLiveWallpaperUrl: '',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('knox:wallpaper-updated'));
  }
}

/** Save a user-selected Normal (Static Image) Wallpaper file and activate Normal Wallpaper mode. */
export async function saveCustomNormalWallpaperFile(file: File): Promise<void> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpeg';
  const defaultMime =
    ext === 'png'
      ? 'image/png'
      : ext === 'webp'
        ? 'image/webp'
        : ext === 'gif'
          ? 'image/gif'
          : 'image/jpeg';
  const { blob, mimeType } = await fileToPersistedBlob(file, defaultMime);
  setMemoryUrl(CUSTOM_NORMAL_WALLPAPER_KEY, blob);
  setMemoryUrl(CUSTOM_WALLPAPER_BLOB_KEY, blob);
  await putWallpaperBlobInDb(CUSTOM_NORMAL_WALLPAPER_KEY, blob, mimeType);
  await putWallpaperBlobInDb(CUSTOM_WALLPAPER_BLOB_KEY, blob, mimeType);

  await useSettings.getState().patch({
    liveWallpaperEnabled: true,
    wallpaperMode: 'normal',
    liveWallpaperPreset: 'normal_custom',
    customNormalWallpaperName: file.name,
    customLiveWallpaperName: file.name,
    customLiveWallpaperType: 'image',
    customLiveWallpaperUrl: '',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('knox:wallpaper-updated'));
  }
}

/** Unified helper that routes video files to Video Wallpaper and images to Normal Wallpaper. */
export async function saveCustomLiveWallpaperFile(file: File): Promise<void> {
  const isVideo =
    file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name);
  if (isVideo) {
    await saveCustomVideoWallpaperFile(file);
  } else {
    await saveCustomNormalWallpaperFile(file);
  }
}

export async function clearCustomVideoWallpaper(): Promise<void> {
  setMemoryUrl(CUSTOM_VIDEO_WALLPAPER_KEY, null);
  try {
    await getDb().artwork.delete(CUSTOM_VIDEO_WALLPAPER_KEY);
  } catch {
    /* ignore */
  }
  await useSettings.getState().patch({
    wallpaperMode: 'video',
    liveWallpaperPreset: 'aurora_prism',
    customVideoWallpaperName: '',
    customLiveWallpaperName: '',
    customLiveWallpaperType: '',
    customLiveWallpaperUrl: '',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('knox:wallpaper-updated'));
  }
}

export async function clearCustomNormalWallpaper(): Promise<void> {
  setMemoryUrl(CUSTOM_NORMAL_WALLPAPER_KEY, null);
  try {
    await getDb().artwork.delete(CUSTOM_NORMAL_WALLPAPER_KEY);
  } catch {
    /* ignore */
  }
  await useSettings.getState().patch({
    wallpaperMode: 'normal',
    liveWallpaperPreset: 'normal_default',
    customNormalWallpaperName: '',
    customLiveWallpaperName: '',
    customLiveWallpaperType: '',
    customLiveWallpaperUrl: '',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('knox:wallpaper-updated'));
  }
}

export async function clearCustomLiveWallpaper(): Promise<void> {
  setMemoryUrl(CUSTOM_WALLPAPER_BLOB_KEY, null);
  setMemoryUrl(CUSTOM_VIDEO_WALLPAPER_KEY, null);
  setMemoryUrl(CUSTOM_NORMAL_WALLPAPER_KEY, null);
  try {
    const db = getDb();
    await db.artwork.delete(CUSTOM_WALLPAPER_BLOB_KEY);
    await db.artwork.delete(CUSTOM_VIDEO_WALLPAPER_KEY);
    await db.artwork.delete(CUSTOM_NORMAL_WALLPAPER_KEY);
  } catch {
    /* ignore */
  }
  await settingsRepo.set(CUSTOM_WALLPAPER_BLOB_KEY, null);
  await useSettings.getState().patch({
    wallpaperMode: 'video',
    liveWallpaperPreset: 'aurora_prism',
    customVideoWallpaperName: '',
    customNormalWallpaperName: '',
    customLiveWallpaperName: '',
    customLiveWallpaperType: '',
    customLiveWallpaperUrl: '',
  });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('knox:wallpaper-updated'));
  }
}

interface LiveWallpaperProps {
  /** Pause live wallpaper rendering when the FullPlayer sheet covers the viewport. */
  playerOpen?: boolean;
}

/**
 * Ultra-low-power Live & Normal Wallpaper layer for the Glassmorphism UI.
 * Only mounts when `uiStyle === 'glassmorphism'` and `liveWallpaperEnabled` is true.
 */
export const LiveWallpaper: React.FC<LiveWallpaperProps> = React.memo(({ playerOpen = false }) => {
  const uiStyle = useSettings((s) => s.uiStyle);
  const enabled = useSettings((s) => s.liveWallpaperEnabled);
  const wallpaperMode = useSettings((s) => s.wallpaperMode);
  const preset = useSettings((s) => s.liveWallpaperPreset);
  const customType = useSettings((s) => s.customLiveWallpaperType);
  const customUrl = useSettings((s) => s.customLiveWallpaperUrl);

  const [docHidden, setDocHidden] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.hidden : false,
  );
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const isGlassmorphism = (uiStyle || 'glassmorphism') === 'glassmorphism';
  const effectiveMode: 'video' | 'normal' =
    wallpaperMode === 'normal' || preset === 'normal_default' || preset === 'normal_custom'
      ? 'normal'
      : 'video';

  // Listen for document visibility and wallpaper update events
  useEffect(() => {
    if (!isGlassmorphism || !enabled) return;

    const onVisibility = () => setDocHidden(document.hidden);
    const onWallpaperUpdate = () => setReloadTick((t) => t + 1);

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('knox:wallpaper-updated', onWallpaperUpdate);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('knox:wallpaper-updated', onWallpaperUpdate);
    };
  }, [isGlassmorphism, enabled]);

  // Load user-uploaded custom video or normal wallpaper Blob from memory or IndexedDB
  useEffect(() => {
    let createdUrl: string | null = null;
    let cancelled = false;

    if (!isGlassmorphism || !enabled) {
      setBlobUrl(null);
      return;
    }

    const wantsCustomVideo =
      effectiveMode === 'video' && preset === 'custom';
    const wantsCustomNormal =
      effectiveMode === 'normal' && (preset === 'normal_custom' || preset === 'custom');

    if (!wantsCustomVideo && !wantsCustomNormal) {
      setBlobUrl(null);
      return;
    }

    if (customUrl && customUrl.trim()) {
      setBlobUrl(customUrl.trim());
      return;
    }

    const primaryKey = wantsCustomVideo
      ? CUSTOM_VIDEO_WALLPAPER_KEY
      : CUSTOM_NORMAL_WALLPAPER_KEY;

    // 1. Immediate synchronous check in memory cache
    const memUrl =
      memoryWallpaperUrls.get(primaryKey) ||
      memoryWallpaperUrls.get(CUSTOM_WALLPAPER_BLOB_KEY);
    if (memUrl) {
      setBlobUrl(memUrl);
      return;
    }

    // 2. Load persisted Blob from IndexedDB artwork table
    void (async () => {
      try {
        let blob = await getWallpaperBlobFromDb(primaryKey);
        if (!blob) {
          blob = await getWallpaperBlobFromDb(CUSTOM_WALLPAPER_BLOB_KEY);
        }
        if (cancelled) return;
        if (blob && blob.size > 0) {
          createdUrl = URL.createObjectURL(blob);
          memoryWallpaperUrls.set(primaryKey, createdUrl);
          setBlobUrl(createdUrl);
        } else {
          setBlobUrl(null);
        }
      } catch {
        if (!cancelled) setBlobUrl(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isGlassmorphism, enabled, effectiveMode, preset, customUrl, reloadTick]);

  const isPaused = docHidden || playerOpen;

  const ensureVideoPlaying = (vid: HTMLVideoElement | null) => {
    if (!vid) return;
    vid.muted = true;
    vid.defaultMuted = true;
    vid.playsInline = true;
    if (isPaused) {
      if (!vid.paused) vid.pause();
    } else {
      const p = vid.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => undefined);
      }
    }
  };

  // Control <video> playback state strictly according to visibility / player sheet state
  useEffect(() => {
    ensureVideoPlaying(videoRef.current);
  }, [isPaused, blobUrl]);

  if (!isGlassmorphism || !enabled) return null;

  // Normal (static image) wallpaper mode
  if (effectiveMode === 'normal') {
    const imgSrc =
      (preset === 'normal_custom' || preset === 'custom') && blobUrl
        ? blobUrl
        : '/image/bg.jpeg';
    return (
      <div
        className="knox-live-wallpaper mode-normal"
        aria-hidden="true"
        data-testid="knox-live-wallpaper"
      >
        <img
          className="knox-live-wallpaper-media knox-normal-wallpaper-img"
          src={imgSrc}
          alt=""
          decoding="async"
        />
        <div className="knox-live-wallpaper-vignette" />
      </div>
    );
  }

  // Video / Live wallpaper mode
  const resolvedCustomIsVideo =
    customType !== 'image' ||
    (blobUrl ? /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(blobUrl) : true);

  const fallbackOrbPreset =
    preset === 'cyber_waves' || preset === 'neon_nebula' ? preset : 'aurora_prism';

  return (
    <div
      className={`knox-live-wallpaper mode-video preset-${preset === 'custom' && blobUrl ? 'custom' : fallbackOrbPreset}${isPaused ? ' is-paused' : ''}`}
      aria-hidden="true"
      data-testid="knox-live-wallpaper"
    >
      {preset === 'custom' && blobUrl ? (
        resolvedCustomIsVideo ? (
          <video
            key={blobUrl}
            ref={(el) => {
              videoRef.current = el;
              if (el) ensureVideoPlaying(el);
            }}
            className="knox-live-wallpaper-media"
            src={blobUrl}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            disablePictureInPicture
            onLoadedMetadata={(e) => ensureVideoPlaying(e.currentTarget)}
            onCanPlay={(e) => ensureVideoPlaying(e.currentTarget)}
          />
        ) : (
          <img
            className="knox-live-wallpaper-media"
            src={blobUrl}
            alt=""
            decoding="async"
          />
        )
      ) : (
        <>
          <div className="knox-lw-orb knox-lw-orb-1" />
          <div className="knox-lw-orb knox-lw-orb-2" />
          <div className="knox-lw-orb knox-lw-orb-3" />
        </>
      )}
      <div className="knox-live-wallpaper-vignette" />
    </div>
  );
});
