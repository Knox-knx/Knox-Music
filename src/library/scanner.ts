import { create } from 'zustand';
import { songRepo } from '../data/repositories';
import { fileToSong, isSupportedAudioFile, probeDurationViaElement, unsupportedExtensionReason, type ScanProgress } from './metadata';
import { saveLocalFileBytes, sniffLocalBytes } from './localFiles';
import { saveDirectoryGrant, type DirectoryGrantHandle } from './folderGrants';
import { logger } from '../core/logger';
import type { Song } from '../core/types';

export type MediaPermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

interface ScannerStore {
  scanning: boolean;
  progress: ScanProgress;
  cancelRequested: boolean;
  lastScanAt: number | null;
  /** Inline permission state for the Local-files section (§3.1). */
  permission: MediaPermissionState;
  permissionDenied: boolean;
  scanFiles: (files: FileList | File[], folder?: string) => Promise<Song[]>;
  /** Full device/directory scan via File System Access (falls back to picker). */
  scanDevice: () => Promise<Song[]>;
  /** Reconcile zero-duration rows whose blob is still alive (§3.2/§3.3). */
  repairZeroDurations: () => Promise<number>;
  /** Remove local entries whose file no longer exists (§3.3). */
  pruneMissing: (alivePaths: Set<string>) => Promise<number>;
  setPermission: (p: MediaPermissionState) => void;
  openPermissionSettings: () => Promise<void>;
  cancel: () => void;
}

const PERMISSION_KEY = 'knox.mediaPermission';

function loadPermission(): MediaPermissionState {
  try {
    const v = localStorage.getItem(PERMISSION_KEY);
    if (v === 'granted' || v === 'denied' || v === 'unavailable') return v;
  } catch { /* private mode */ }
  return 'unknown';
}

function savePermission(p: MediaPermissionState) {
  try { localStorage.setItem(PERMISSION_KEY, p); } catch { /* ignore */ }
}

type FSHandle = {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
  values?: () => AsyncIterableIterator<FSHandle>;
};

async function collectFromDirectory(dir: FSHandle, out: { file: File; path: string }[], prefix: string, depth = 0): Promise<void> {
  if (depth > 8 || out.length > 5000) return;
  try {
    const values = dir.values?.();
    if (!values) return;
    for await (const entry of values) {
      if (entry.kind === 'file') {
        if (!isSupportedAudioFile(entry.name)) continue;
        try {
          const f = await entry.getFile?.();
          if (f) out.push({ file: f, path: prefix ? `${prefix}/${entry.name}` : entry.name });
        } catch { /* skip unreadable */ }
      } else if (entry.kind === 'directory') {
        // Skip OS noise + hidden dirs.
        if (entry.name.startsWith('.') || entry.name === 'Android') continue;
        await collectFromDirectory(entry, out, prefix ? `${prefix}/${entry.name}` : entry.name, depth + 1);
      }
    }
  } catch { /* permission revoked mid-walk — return what we have */ }
}

export const useScanner = create<ScannerStore>((set, get) => ({
  scanning: false,
  progress: { total: 0, done: 0, current: '' },
  cancelRequested: false,
  lastScanAt: (() => {
    try {
      const v = Number(localStorage.getItem('knox.lastScanAt') || '0');
      return v > 0 ? v : null;
    } catch { return null; }
  })(),
  permission: loadPermission(),
  permissionDenied: loadPermission() === 'denied',

  cancel: () => set({ cancelRequested: true }),
  setPermission: (p) => {
    savePermission(p);
    set({ permission: p, permissionDenied: p === 'denied' });
  },

  openPermissionSettings: async () => {
    // Android (Tauri): open the OS app-settings screen via the opener plugin.
    // Browser/desktop: there is no OS media permission — re-trigger the
    // picker so the user can grant directory access explicitly.
    try {
      const { isTauri } = await import('../desktop/detector');
      if (isTauri()) {
        try {
          const { openUrl } = await import('@tauri-apps/plugin-opener');
          await openUrl('app-settings:');
          return;
        } catch { /* fall through to picker retry */ }
      }
    } catch { /* browser — fall through */ }
    // Browser fallback: clear the denied flag so the inline row offers
    // "Scan device" / "Add files" again instead of dead-ending.
    savePermission('unknown');
    set({ permission: 'unknown', permissionDenied: false });
  },

  scanFiles: async (input, folder = '') => {
    const all = [...(input as unknown as Iterable<File>)];
    // Native decoder minimum: MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis (+ Opus/WebM).
    // Unsupported containers (.wma/.amr/…) are skipped at import with an
    // explicit logged reason — never a blocking decode error at tap time.
    // Corrupted headers inside a *supported* container still import (duration
    // 0) and fail gracefully at play time with skip + Tap-to-retry.
    const skipped: string[] = [];
    const files = all.filter((f) => {
      try {
        if (isSupportedAudioFile(f.name)) return true;
        const reason = unsupportedExtensionReason(f.name) ?? `unsupported file ${f.name}`;
        skipped.push(`${f.name}: ${reason}`);
        return false;
      } catch { return false; }
    });
    if (skipped.length > 0) {
      try { logger.warn('scanner', `skipped ${skipped.length} unsupported file(s)`, skipped.slice(0, 10).join('; ').slice(0, 500)); } catch { /* noop */ }
    }
    if (files.length === 0) {
      if (skipped.length > 0) {
        try {
          const { toast } = await import('../ui/toast');
          toast(`Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'} (not decodable on this device)`, 'warn');
        } catch { /* toast best-effort */ }
      }
      return [];
    }
    set({ scanning: true, cancelRequested: false, progress: { total: files.length, done: 0, current: '' } });
    const added: Song[] = [];
    const corrupt: string[] = [];
    // Background-chunked scan: small batches + a macrotask yield keep the
    // Library screen responsive while scanning (never blocks the UI thread).
    const BATCH = 10;
    try {
      for (let i = 0; i < files.length; i += BATCH) {
        if (get().cancelRequested) break;
        const batch = files.slice(i, i + BATCH);
        const songs: Song[] = [];
        for (const f of batch) {
          if (get().cancelRequested) break;
          set({ progress: { total: files.length, done: i, current: f.name } });
          try {
            // §11: content sniff BEFORE import — an HTML/JSON error page
            // mislabeled ".mp3" or a 0-byte/truncated download can never
            // decode. Reject at scan time with a logged reason instead of
            // importing a dead row that fails at every tap.
            try {
              const sniff = await sniffLocalBytes(f, f.name);
              if (sniff.errorPage) {
                corrupt.push(`${f.name}: not audio (error page mislabeled as audio)`);
                continue;
              }
              if (sniff.truncated) {
                corrupt.push(`${f.name}: file is empty or truncated (${sniff.size} bytes)`);
                continue;
              }
            } catch { /* sniff best-effort — import and let the element decide */ }
            const song = await fileToSong(f, folder);
            // §11: persist raw bytes — blob: URLs die on restart, bytes don't.
            // Playback mints a fresh URL per session from this store.
            void saveLocalFileBytes(song.id, f);
            // Merge key is the stable id (folder+name+size+mtime): re-scans
            // update existing rows (fixing 0:00/title) instead of duplicating.
            songs.push(song);
          } catch { /* skip unreadable file, continue scan */ }
        }
        if (songs.length > 0) {
          await songRepo.bulkUpsert(songs);
          added.push(...songs);
        }
        set({ progress: { total: files.length, done: Math.min(files.length, i + BATCH), current: '' } });
        await new Promise((r) => setTimeout(r, 0));
      }
      const at = Date.now();
      try { localStorage.setItem('knox.lastScanAt', String(at)); } catch { /* ignore */ }
      set({ scanning: false, lastScanAt: at });
      if (corrupt.length > 0) {
        try { logger.warn('scanner', `rejected ${corrupt.length} corrupt file(s) at import`, corrupt.slice(0, 10).join('; ').slice(0, 800)); } catch { /* noop */ }
        try {
          const { toast } = await import('../ui/toast');
          toast(`Skipped ${corrupt.length} corrupt file${corrupt.length === 1 ? '' : 's'} (not playable audio)`, 'warn');
        } catch { /* toast best-effort */ }
      }
      // A successful manual add proves access works — clear any denied flag.
      if (added.length > 0 && get().permissionDenied) {
        savePermission('granted');
        set({ permission: 'granted', permissionDenied: false });
      }
    } catch {
      set({ scanning: false });
    }
    return added;
  },

  scanDevice: async () => {
    // Platform media-read permission (§3.1):
    // - Android 13+: READ_MEDIA_AUDIO / older: READ_EXTERNAL_STORAGE
    // - iOS: media-library entitlement
    // - Web/desktop: File System Access directory grant.
    // The web has no pre-flight permission API for audio files, so the
    // directory picker IS the permission gate: AbortError = dismissed
    // (stay silent), NotAllowedError/SecurityError = denied (inline prompt).
    const picker = (window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FSHandle>;
    }).showDirectoryPicker;
    if (typeof picker !== 'function') {
      // No directory API (iOS Safari, older WebViews): fall back to the
      // file/folder inputs — the Library screen listens for this code.
      const err = new Error('Directory picking is not supported here — use Add files / Add folder instead.');
      (err as Error & { code?: string }).code = 'PICKER_UNSUPPORTED';
      throw err;
    }
    let dir: FSHandle;
    try {
      dir = await picker.call(window, { mode: 'read' });
      // Persist the grant so restarts never re-prompt for this folder —
      // restoreFolderGrants() re-validates it silently at boot.
      void saveDirectoryGrant(dir as unknown as DirectoryGrantHandle).catch(() => undefined);
    } catch (e) {
      const name = (e as Error)?.name ?? '';
      if (name === 'AbortError') return []; // user dismissed — not a denial
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        savePermission('denied');
        set({ permission: 'denied', permissionDenied: true });
      }
      throw e;
    }
    const collected: { file: File; path: string }[] = [];
    set({ scanning: true, cancelRequested: false, progress: { total: 0, done: 0, current: 'Reading device folders…' } });
    await collectFromDirectory(dir, collected, (dir as { name?: string }).name ?? '');
    if (collected.length === 0) {
      set({ scanning: false });
      savePermission('granted');
      set({ permission: 'granted', permissionDenied: false });
      return [];
    }
    // Reuse the chunked merge pipeline; folder is derived per-file below.
    const files = collected.map((c) => c.file);
    // Group by parent folder so localPath keeps its device-relative path.
    const byFolder = new Map<string, File[]>();
    for (const c of collected) {
      const folder = c.path.split('/').slice(0, -1).join('/') || 'Device';
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(c.file);
    }
    const allAdded: Song[] = [];
    const alive = new Set<string>();
    for (const [folder, list] of byFolder) {
      if (get().cancelRequested) break;
      const added = await get().scanFiles(list, folder);
      allAdded.push(...added);
      for (const s of added) if (s.localPath) alive.add(s.localPath);
    }
    // Full device scan prunes stale rows (file deleted outside the app).
    if (!get().cancelRequested && alive.size > 0) {
      try { await get().pruneMissing(alive); } catch { /* prune is best-effort */ }
    }
    savePermission('granted');
    set({ permission: 'granted', permissionDenied: false });
    return allAdded;
  },

  repairZeroDurations: async () => {
    // One-shot repair for the historical 0:00 rows. Pre-fix rows hold DEAD
    // blob: URLs (revoked on restart), so probing streamUrl directly always
    // fails — rehydrate a fresh URL from persisted bytes first (§11). Rows
    // with no persisted bytes need a re-scan (Add files / Scan device).
    // Bounded to 50 rows per call.
    let fixed = 0;
    try {
      const { freshLocalObjectUrl } = await import('./localFiles');
      const rows = await songRepo.list(0, 500, 'recent');
      const broken = rows.filter((s) => s.isLocalFile && !(s.durationMs > 0));
      for (const s of broken.slice(0, 50)) {
        try {
          let probeUrl = s.streamUrl;
          if (!probeUrl || probeUrl.startsWith('blob:')) {
            const fresh = await freshLocalObjectUrl(s).catch(() => null);
            if (fresh?.url) probeUrl = fresh.url;
            else continue; // no bytes stored — needs a re-scan, skip silently
          }
          if (!probeUrl) continue;
          const ms = await probeDurationViaElement(probeUrl);
          if (ms > 0) {
            await songRepo.upsert({ ...s, durationMs: ms, streamUrl: probeUrl });
            fixed += 1;
          }
        } catch { /* keep 0 — needs a re-scan */ }
      }
    } catch { /* repair never breaks library load */ }
    return fixed;
  },

  pruneMissing: async (alivePaths) => {
    // Only local rows are eligible; streamed/catalog rows are never touched.
    // Callers pass the fresh scan's path set — anything local NOT in the set
    // was deleted outside the app. Bounded per call; returns removed count.
    let removed = 0;
    try {
      const rows = await songRepo.list(0, 5000, 'recent');
      const stale = rows.filter((s) => s.isLocalFile && s.localPath && !alivePaths.has(s.localPath));
      // Safety: never wipe the whole library on an empty/partial scan.
      if (stale.length > 0 && stale.length < rows.length) {
        for (const s of stale.slice(0, 500)) {
          try { await songRepo.remove(s.id); removed += 1; } catch { /* continue */ }
        }
      }
    } catch { /* best-effort */ }
    return removed;
  },
}));
