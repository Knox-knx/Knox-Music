// downloadsApi — UI entry point for offline downloads.
//
// Capability-aware semantics preserved: streamable ≠ downloadable ≠
// redistributable. Only tracks whose provider explicitly permits offline
// expose download; the desktop shell never bypasses restrictions.

import type { Song } from '../core/types';
import { useDownloads } from '../downloads/DownloadManager';

export const downloadsApi = {
  get state() {
    return useDownloads.getState();
  },
  subscribe(fn: (s: ReturnType<typeof useDownloads.getState>) => void): () => void {
    return useDownloads.subscribe(fn);
  },
  async list() {
    await useDownloads.getState().load().catch(() => undefined);
    return useDownloads.getState().items;
  },
  /** Enqueue one track. Rejects when the provider forbids offline. */
  async create(song: Song): Promise<string> {
    return useDownloads.getState().enqueue(song);
  },
  async pause(id: string): Promise<void> {
    await useDownloads.getState().pause(id);
  },
  async resume(id: string): Promise<void> {
    await useDownloads.getState().resume(id);
  },
  async retry(id: string): Promise<void> {
    await useDownloads.getState().retry(id);
  },
  async remove(id: string, deleteFile = true): Promise<void> {
    await useDownloads.getState().remove(id, deleteFile);
  },
  async clearCompleted(): Promise<void> {
    await useDownloads.getState().clearCompleted();
  },
};
