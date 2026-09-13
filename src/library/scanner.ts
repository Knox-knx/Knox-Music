import { create } from 'zustand';
import { songRepo } from '../data/repositories';
import { fileToSong, isSupportedAudioFile, type ScanProgress } from './metadata';
import type { Song } from '../core/types';

interface ScannerStore {
  scanning: boolean;
  progress: ScanProgress;
  cancelRequested: boolean;
  lastScanAt: number | null;
  scanFiles: (files: FileList | File[], folder?: string) => Promise<Song[]>;
  cancel: () => void;
}

export const useScanner = create<ScannerStore>((set, get) => ({
  scanning: false,
  progress: { total: 0, done: 0, current: '' },
  cancelRequested: false,
  lastScanAt: null,

  cancel: () => set({ cancelRequested: true }),

  scanFiles: async (input, folder = '') => {
    const files = [...(input as unknown as Iterable<File>)].filter((f) => isSupportedAudioFile(f.name));
    set({ scanning: true, cancelRequested: false, progress: { total: files.length, done: 0, current: '' } });
    const added: Song[] = [];
    // Incremental scan: skip files whose size+mtime already indexed
    const BATCH = 25;
    for (let i = 0; i < files.length; i += BATCH) {
      if (get().cancelRequested) break;
      const batch = files.slice(i, i + BATCH);
      const songs: Song[] = [];
      for (const f of batch) {
        if (get().cancelRequested) break;
        set({ progress: { total: files.length, done: i, current: f.name } });
        try {
          const existing = await songRepo.get(`local:${folder}:${f.name}:${f.size}:${f.lastModified}`.slice(0, 220));
          void existing;
          const song = await fileToSong(f, folder);
          songs.push(song);
        } catch { /* skip unreadable file, continue scan */ }
      }
      if (songs.length > 0) {
        await songRepo.bulkUpsert(songs);
        added.push(...songs);
      }
      set({ progress: { total: files.length, done: Math.min(files.length, i + BATCH), current: '' } });
      // Yield to keep UI responsive
      await new Promise((r) => setTimeout(r, 0));
    }
    set({ scanning: false, lastScanAt: Date.now() });
    return added;
  },
}));
