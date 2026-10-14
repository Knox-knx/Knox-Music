import { describe, it, expect } from 'vitest';
import { isSupportedAudioFile, findDuplicates } from '../../src/library/metadata';
import type { Song } from '../../src/core/types';

const song = (over: Partial<Song> & { id: string }): Song => ({
  providerId: 'local', providerTrackId: over.id, title: 'T', artist: 'A', album: 'B',
  durationMs: 180000, addedAt: 0, ...over,
});

describe('isSupportedAudioFile', () => {
  it('accepts common formats, rejects others', () => {
    for (const ext of ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus']) {
      expect(isSupportedAudioFile(`track.${ext}`)).toBe(true);
    }
    expect(isSupportedAudioFile('cover.jpg')).toBe(false);
    expect(isSupportedAudioFile('song.exe')).toBe(false);
  });
});

describe('findDuplicates', () => {
  it('groups same title/artist/duration/size, never deletes', () => {
    const a = song({ id: 'a', title: 'Song', artist: 'A', durationMs: 180000 });
    const b = song({ id: 'b', title: 'Song', artist: 'A', durationMs: 180500 });
    const c = song({ id: 'c', title: 'Other', artist: 'A', durationMs: 180000 });
    const sizes = new Map([['a', 5000000], ['b', 5001000], ['c', 5000000]]);
    const groups = findDuplicates([a, b, c], sizes);
    expect(groups).toHaveLength(1);
    expect(groups[0].songs.map((s) => s.id).sort()).toEqual(['a', 'b']);
    // input untouched
    expect([a, b, c]).toHaveLength(3);
  });

  it('returns no groups when everything is unique', () => {
    const songs = [song({ id: 'a', title: 'One' }), song({ id: 'b', title: 'Two' })];
    expect(findDuplicates(songs, new Map())).toHaveLength(0);
  });
});
