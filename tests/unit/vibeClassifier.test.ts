import { describe, it, expect } from 'vitest';
import type { Song } from '../../src/core/types';
import {
  detectMusicVibe,
  enforceArtistDiversity,
  isSameSongOrVariant,
  cleanSongTitle,
  normalizeArtistName,
} from '../../src/audio/vibeClassifier';

function testSong(id: string, title: string, artist: string, extra?: Partial<Song>): Song {
  return {
    id: `youtube:${id}`,
    providerId: 'youtube',
    providerTrackId: id,
    title,
    artist,
    album: '',
    durationMs: 200000,
    artworkUrl: undefined,
    downloadAllowed: true,
    isLocalFile: false,
    isOfflineAvailable: false,
    isFavorite: false,
    playCount: 0,
    addedAt: Date.now(),
    capabilities: { searchable: true, streamable: true, downloadable: true, offline: true, previewOnly: false },
    ...extra,
  } as Song;
}

describe('vibeClassifier', () => {
  it('detects Bollywood Sufi vibe for Sajjda and Rahat Fateh Ali Khan', () => {
    const song = testSong('1', 'Sajjda', 'Rahat Fateh Ali Khan');
    const vibe = detectMusicVibe(song);
    expect(vibe.vibe).toBe('bollywood_sufi');
    expect(vibe.genreLabel).toContain('Sufi');
    expect(vibe.relatedQueries.length).toBeGreaterThan(0);
    expect(vibe.relatedQueries[0]).toContain('sufi');
  });

  it('detects Phonk vibe for drift phonk tracks and phonk producers', () => {
    const song1 = testSong('2', 'Metamorphosis', 'INTERWORLD');
    const vibe1 = detectMusicVibe(song1);
    expect(vibe1.vibe).toBe('phonk');
    expect(vibe1.genreLabel).toContain('Phonk');

    const song2 = testSong('3', 'Murder In My Mind (Drift Phonk)', 'Kordhell');
    const vibe2 = detectMusicVibe(song2);
    expect(vibe2.vibe).toBe('phonk');
  });

  it('detects Punjabi vibe for Punjabi artists and titles', () => {
    const song = testSong('4', '295', 'Sidhu Moose Wala');
    const vibe = detectMusicVibe(song);
    expect(vibe.vibe).toBe('punjabi');
  });

  it('cleans song titles and identifies remixes/variants as the same song', () => {
    expect(cleanSongTitle('Sajjda (Official Music Video) [4K]')).toBe('sajjda');
    expect(cleanSongTitle('Sajjda (Slowed + Reverb)')).toBe('sajjda');
    expect(cleanSongTitle('Sajjda (Remix)')).toBe('sajjda');

    const original = testSong('1', 'Sajjda', 'Rahat Fateh Ali Khan');
    const remix = testSong('2', 'Sajjda (Remix)', 'Rahat Fateh Ali Khan');
    expect(isSameSongOrVariant(remix, original)).toBe(true);

    const differentSong = testSong('3', 'Kun Faya Kun', 'A.R. Rahman');
    expect(isSameSongOrVariant(differentSong, original)).toBe(false);
  });

  it('enforces artist diversity: never plays the same singer immediately after the current song', () => {
    const current = testSong('c1', 'Sajjda', 'Rahat Fateh Ali Khan');

    const candidates = [
      testSong('s1', 'Teri Ore', 'Rahat Fateh Ali Khan'), // Same singer as current!
      testSong('s2', 'O Re Piya', 'Rahat Fateh Ali Khan'), // Same singer as current!
      testSong('s3', 'Kun Faya Kun', 'A.R. Rahman'),      // Different singer!
      testSong('s4', 'Mitwa', 'Shankar Mahadevan'),       // Different singer!
      testSong('s5', 'Javeda Zaanbaan', 'Kshitij Tarey'), // Different singer!
    ];

    const diverse = enforceArtistDiversity(candidates, current, 1);

    // The FIRST upcoming track MUST NOT be Rahat Fateh Ali Khan!
    expect(diverse[0].artist).not.toBe('Rahat Fateh Ali Khan');
    expect(diverse[0].title).toBe('Kun Faya Kun');

    // No consecutive same artists anywhere in the result
    for (let i = 0; i < diverse.length - 1; i++) {
      expect(normalizeArtistName(diverse[i].artist)).not.toBe(
        normalizeArtistName(diverse[i + 1].artist),
      );
    }
  });

  it('enforces artist diversity for Phonk: diverse producers instead of repeating one artist', () => {
    const current = testSong('c1', 'Metamorphosis', 'INTERWORLD');

    const candidates = [
      testSong('p1', 'Rapture', 'INTERWORLD'),     // Same artist
      testSong('p2', 'Close Eyes', 'DVRST'),       // Different artist
      testSong('p3', 'Live Another Day', 'Kordhell'), // Different artist
      testSong('p4', 'Sahara', 'Hensonn'),         // Different artist
    ];

    const diverse = enforceArtistDiversity(candidates, current, 1);
    expect(diverse[0].artist).toBe('DVRST');
    expect(diverse[1].artist).toBe('Kordhell');
    expect(diverse[2].artist).toBe('Hensonn');
  });
});
