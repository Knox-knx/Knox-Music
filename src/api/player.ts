// playerApi — UI entry point for playback (singleton AudioEngine stays).
//
// Chain (unchanged): App → usePlayer → singleton AudioEngine → one element.
// The desktop shell and local server never create players. Search/API
// failures never stop playback — errors surface as state, not exceptions
// into the audio path.

import type { Song } from '../core/types';
import type { RadioStation } from '../providers/radio/types';
import { usePlayer } from '../audio/playerStore';

export const playerApi = {
  get state() {
    return usePlayer.getState();
  },
  subscribe(fn: (s: ReturnType<typeof usePlayer.getState>) => void): () => void {
    return usePlayer.subscribe(fn);
  },
  async playSongs(songs: Song[], startIndex = 0): Promise<void> {
    await usePlayer.getState().playSongs(songs, startIndex);
  },
  async playSong(song: Song, queue?: Song[]): Promise<void> {
    await usePlayer.getState().playSong(song, queue);
  },
  async playStation(station: RadioStation): Promise<void> {
    await usePlayer.getState().playStation(station);
  },
  stopRadio(): void {
    usePlayer.getState().stopRadio();
  },
  async toggle(): Promise<void> {
    await usePlayer.getState().toggle();
  },
  async next(auto?: boolean): Promise<void> {
    await usePlayer.getState().next(auto);
  },
  async prev(): Promise<void> {
    await usePlayer.getState().prev();
  },
  seek(ms: number): void {
    usePlayer.getState().seek(ms);
  },
  setVolume(v: number): void {
    usePlayer.getState().setVolume(v);
  },
  setMuted(m: boolean): void {
    usePlayer.getState().setMuted(m);
  },
  setOfflineMode(off: boolean): void {
    usePlayer.getState().setOfflineMode(off);
  },
};
