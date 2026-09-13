import { create } from 'zustand';
import type { DownloadRecord, DownloadState } from '../core/states';
import type { Song } from '../core/types';
import { downloadRepo, offlineRepo } from '../data/repositories';
import { getProviderManager } from '../providers/ProviderManager';
import { storageManager } from '../storage/storageManager';
import { useSettings } from '../settings/settingsStore';
import { sanitizeFilename, uid } from '../core/utils';
import { isPreviewSong } from '../providers/capabilities';
import { logger } from '../core/logger';

interface DownloadStore {
  items: DownloadRecord[];
  load: () => Promise<void>;
  enqueue: (song: Song) => Promise<string>;
  enqueueMany: (songs: Song[]) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string, deleteFile?: boolean) => Promise<void>;
  clearCompleted: () => Promise<void>;
}

const controllers = new Map<string, AbortController>();

async function fetchToBlob(url: string, signal: AbortSignal, onProgress: (received: number, total?: number) => void): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || undefined;
  // Enforce a sane cap: 250 MB per track
  const CAP = 250 * 1024 * 1024;
  if (total && total > CAP) throw new Error('File exceeds 250 MB safety limit');
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > CAP) throw new Error('File exceeds 250 MB safety limit');
    chunks.push(value);
    onProgress(received, total);
  }
  const mime = res.headers.get('content-type') || 'audio/mpeg';
  return new Blob(chunks, { type: mime });
}

export const useDownloads = create<DownloadStore>((set, get) => ({
  items: [],

  load: async () => {
    set({ items: await downloadRepo.list().catch(() => []) });
  },

  enqueue: async (song) => {
    const pm = getProviderManager();
    const provider = pm.get(song.providerId);
    if (!provider) throw new Error('Unknown provider');
    if (!provider.capabilities.supportsOffline) throw new Error('Offline download unavailable for this source');
    // Preview-only sources never grant offline rights —
    // reject explicitly even if a provider mis-reports its flags.
    if (isPreviewSong(song)) throw new Error('Previews cannot be saved offline — only full licensed tracks can be downloaded.');

    const { wifiOnly } = useSettings.getState();
    if (wifiOnly && 'connection' in navigator) {
      const conn = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
      if (conn && conn.type === 'cellular') throw new Error('Wi-Fi only downloads are enabled. Connect to Wi-Fi to download.');
    }

    const id = uid('dl');
    const rec: DownloadRecord = {
      id, songId: song.id, title: song.title, artist: song.artist,
      artworkUrl: song.artworkUrl, state: 'QUEUED', progress: 0,
      bytesReceived: 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
    await downloadRepo.put(rec);
    set({ items: await downloadRepo.list() });
    void processQueue();
    return id;
  },

  enqueueMany: async (songs) => {
    for (const s of songs) {
      try { await get().enqueue(s); } catch (e) { logger.warn('downloads', 'enqueue skipped', String(e)); }
    }
  },

  pause: async (id) => {
    controllers.get(id)?.abort();
    controllers.delete(id);
    await downloadRepo.update(id, { state: 'PAUSED' });
    set({ items: await downloadRepo.list() });
  },

  resume: async (id) => {
    await downloadRepo.update(id, { state: 'QUEUED', error: undefined });
    set({ items: await downloadRepo.list() });
    void processQueue();
  },

  cancel: async (id) => {
    controllers.get(id)?.abort();
    controllers.delete(id);
    await downloadRepo.update(id, { state: 'CANCELLED', progress: 0 });
    set({ items: await downloadRepo.list() });
  },

  retry: async (id) => {
    await downloadRepo.update(id, { state: 'QUEUED', error: undefined, progress: 0, bytesReceived: 0 });
    set({ items: await downloadRepo.list() });
    void processQueue();
  },

  remove: async (id, deleteFile = false) => {
    const rec = await downloadRepo.get(id);
    controllers.get(id)?.abort();
    controllers.delete(id);
    if (rec && deleteFile) await offlineRepo.remove(rec.songId).catch(() => undefined);
    await downloadRepo.update(id, { state: 'REMOVED' });
    set({ items: await downloadRepo.list() });
  },

  clearCompleted: async () => {
    await downloadRepo.clearCompleted();
    set({ items: await downloadRepo.list() });
  },
}));

let active = 0;

async function processQueue(): Promise<void> {
  const { maxConcurrentDownloads } = useSettings.getState();
  if (active >= maxConcurrentDownloads) return;
  const next = (await downloadRepo.list()).find((r) => r.state === 'QUEUED');
  if (!next) return;
  active++;
  try {
    await runDownload(next.id);
  } finally {
    active--;
    void processQueue();
  }
}

async function runDownload(id: string): Promise<void> {
  const rec = await downloadRepo.get(id);
  if (!rec || rec.state !== 'QUEUED') return;
  const controller = new AbortController();
  controllers.set(id, controller);

  await downloadRepo.update(id, { state: 'DOWNLOADING' });
  await useDownloads.getState().load();

  try {
    const pm = getProviderManager();
    // Resolve song: try offline list/offline DB via songId lookup through providers is out of scope;
    // reconstruct minimal song from record + provider lookup.
    const songId = rec.songId;
    const providerId = songId.split(':')[0] ?? 'sample';
    const provider = pm.get(providerId);
    if (!provider) throw new Error('Provider unavailable');
    if (!provider.capabilities.supportsOffline) throw new Error('Offline download unavailable for this source');

    // For local-file songs there is nothing to download — mark complete.
    const { getDb } = await import('../data/db');
    const existing = await getDb().songs.get(songId).catch(() => undefined);
    if (existing?.isLocalFile) {
      await downloadRepo.update(id, { state: 'COMPLETED', progress: 1 });
      await useDownloads.getState().load();
      return;
    }

    const trackId = songId.split(':').slice(1).join(':');
    const song = (await provider.getSong(trackId)) ?? existing ?? null;
    if (!song) throw new Error('Track no longer available from provider');
    // Per-track permission: provider.canDownload() wins when implemented,
    // otherwise fall back to getStream().allowsOffline.
    if (typeof provider.canDownload === 'function') {
      const ok = await provider.canDownload(song as Song);
      if (!ok) throw new Error('Provider does not permit offline storage for this track');
    }
    const stream = await provider.getStream(song as Song);
    if (!stream.allowsOffline) throw new Error('Provider does not permit offline storage for this track');

    const filename = sanitizeFilename(`${song.title} - ${(song as Song).artist}`);
    void filename;
    const { offlineQuality } = useSettings.getState();
    // Prefer the provider's dedicated download endpoint (e.g. Jamendo
    // audiodownload) when it differs from the expiring stream URL.
    let downloadUrl = stream.downloadUrl && stream.downloadUrl !== stream.url ? stream.downloadUrl : stream.url;
    if (typeof provider.getDownload === 'function') {
      try {
        const dl = await provider.getDownload(song as Song);
        if (dl?.url) downloadUrl = dl.url;
      } catch {
        // Keep the stream URL — getStream() already permitted offline.
      }
    }
    const { safeUrlOrUndefined } = await import('../core/utils');
    if (!safeUrlOrUndefined(downloadUrl)) throw new Error('Provider returned an unsafe download URL');
    const blob = await fetchToBlob(downloadUrl, controller.signal, (received, total) => {
      void downloadRepo.update(id, { bytesReceived: received, bytesTotal: total, progress: total ? received / total : 0 });
    });

    // Corrupted-file detection: empty bodies or truncated payloads never
    // become visible in the offline library.
    if (blob.size === 0) throw new Error('Downloaded file is empty (corrupted)');
    if (!blob.type.startsWith('audio/') && !blob.type.startsWith('application/octet-stream')) {
      throw new Error(`Unexpected file type (${blob.type || 'unknown'}) — download discarded`);
    }

    const check = await storageManager.canStore(blob.size);
    if (!check.ok) throw new Error(check.reason ?? 'Storage limit reached');

    // Atomic commit: only after full validation does the track become visible offline.
    await offlineRepo.put(song as Song, blob, offlineQuality);
    await downloadRepo.update(id, { state: 'COMPLETED', progress: 1, bytesReceived: blob.size, bytesTotal: blob.size });
    logger.info('downloads', `completed ${song.title}`);
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      const cur = await downloadRepo.get(id);
      if (cur && cur.state === 'DOWNLOADING') await downloadRepo.update(id, { state: 'PAUSED' });
    } else {
      await downloadRepo.update(id, { state: 'FAILED', error: e instanceof Error ? e.message : 'Download failed' });
      logger.error('downloads', 'failed', String(e));
    }
  } finally {
    controllers.delete(id);
    await useDownloads.getState().load();
  }
}

export function downloadStateLabel(s: DownloadState): string {
  switch (s) {
    case 'QUEUED': return 'Waiting';
    case 'DOWNLOADING': return 'Downloading';
    case 'PAUSED': return 'Paused';
    case 'COMPLETED': return 'Offline';
    case 'FAILED': return 'Failed';
    case 'CANCELLED': return 'Cancelled';
    case 'REMOVED': return 'Removed';
  }
}
