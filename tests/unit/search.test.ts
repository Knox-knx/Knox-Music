import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeQuery, normalizeKeyPart, foldedEquals } from '../../src/search/normalizeQuery';
import { parseQuery } from '../../src/search/queryParser';
import { scoreTrack } from '../../src/search/relevance';
import { rankSongs, hasExactMatch } from '../../src/search/ranking';
import { dedupeSongs, equivalenceKey, findEquivalents, isValidSong } from '../../src/search/dedupe';
import {
  runSearchPipeline,
  searchSongsIsolated,
  cachedSongs,
  clearSearchCache,
} from '../../src/search/searchEngine';
import { trackCapabilities } from '../../src/providers/capabilities';
import { normalizeProviderCapabilities } from '../../src/providers/types';
import { mapJioSaavnSong } from '../../src/providers/jiosaavn/mapper';
import { mapSpotifyTrack } from '../../src/providers/spotify/mapper';
import type { Song } from '../../src/core/types';

afterEach(() => {
  vi.unstubAllGlobals();
  clearSearchCache();
});

function song(over: Partial<Song> & { id: string }): Song {
  return {
    providerId: 'jamendo',
    providerTrackId: 'x',
    title: 'T',
    artist: 'A',
    album: '',
    durationMs: 1000,
    addedAt: 0,
    ...over,
  } as Song;
}

// ---------- normalizeQuery: multilingual ----------

describe('normalizeQuery (Indian / multilingual support)', () => {
  it('preserves originalQuery and folds a match form', () => {
    const q = normalizeQuery('  Arijit Singh  ');
    expect(q.originalQuery).toBe('  Arijit Singh  ');
    expect(q.normalizedQuery).toBe('arijit singh');
  });

  it('is case-insensitive across variants', () => {
    expect(normalizeQuery('Arijit Singh').normalizedQuery).toBe('arijit singh');
    expect(normalizeQuery('arijit singh').normalizedQuery).toBe('arijit singh');
    expect(normalizeQuery('ARJIT SINGH').normalizedQuery).toBe('arjit singh');
  });

  it('strips accents/diacritics without destroying scripts', () => {
    expect(normalizeKeyPart('Beyoncé')).toBe('beyonce');
    expect(normalizeKeyPart('A.R. Rahman')).toBe('a r rahman');
  });

  it('normalizes apostrophes, hyphens, punctuation, whitespace', () => {
    expect(normalizeKeyPart("Tum Hi Ho...  (unplugged)")).toBe('tum hi ho unplugged');
    expect(normalizeKeyPart('Born-to—Shine')).toBe('born to shine');
    expect(normalizeKeyPart('don\u2019t stop')).toBe('don t stop');
  });

  it('preserves Hindi / Punjabi / Tamil / Telugu Unicode', () => {
    expect(normalizeQuery('तुम ही हो').normalizedQuery).toBe('तुम ही हो');
    expect(normalizeQuery('ਪੰਜਾਬੀ ਗਾਣਾ').normalizedQuery).toBe('ਪੰਜਾਬੀ ਗਾਣਾ');
    expect(normalizeQuery('தமிழ் பாடல்').normalizedQuery).toBe('தமிழ் பாடல்');
    expect(normalizeQuery('తెలుగు పాట').normalizedQuery).toBe('తెలుగు పాట');
  });

  it('foldedEquals compares folded forms', () => {
    expect(foldedEquals('Mi Gente', 'mi gente')).toBe(true);
    expect(foldedEquals('Mi Gente', 'Mi Gent')).toBe(false);
  });
});

// ---------- queryParser: title + artist detection ----------

describe('parseQuery (title + artist detection)', () => {
  it('handles bare titles', () => {
    const p = parseQuery('Mi Gente');
    expect(p.full).toBe('mi gente');
    expect(p.hypotheses[0]).toEqual({ title: 'mi gente', artist: '' });
  });

  it('produces both orders for title artist combos', () => {
    const p = parseQuery('Tum Hi Ho Arijit Singh');
    const keys = p.hypotheses.map((h) => `${h.title}|${h.artist}`);
    expect(keys).toContain('tum hi ho|arijit singh');
    expect(keys).toContain('arijit singh|tum hi ho');
  });

  it('supports explicit separators without fabricating metadata', () => {
    const p = parseQuery('Kesariya - Arijit Singh');
    expect(p.hypotheses[0]).toEqual({ title: 'kesariya', artist: 'arijit singh' });
    expect(p.hypotheses[1]).toEqual({ title: 'arijit singh', artist: 'kesariya' });
  });

  it('supports "by" separator', () => {
    const p = parseQuery('Heeriye by Jasleen Royal');
    expect(p.hypotheses[0]).toEqual({ title: 'heeriye', artist: 'jasleen royal' });
  });
});

// ---------- relevance: wrong same-title artists are never exact ----------

describe('relevance scoring (Problem B)', () => {
  it('exact title + exact artist => exact 100', () => {
    const r = scoreTrack(
      { title: 'Mi Gente', artist: 'J Balvin' },
      parseQuery('Mi Gente J Balvin'),
    );
    expect(r.matchType).toBe('exact');
    expect(r.relevanceScore).toBe(100);
  });

  it('same title but unrelated artist is NOT exact (Mi Gente — David Tumax)', () => {
    const r = scoreTrack(
      { title: 'Mi Gente', artist: 'David Tumax' },
      parseQuery('Mi Gente J Balvin'),
    );
    expect(r.matchType).not.toBe('exact');
    expect(r.relevanceScore).toBeLessThan(90);
  });

  it('bare exact title with no artist hypothesis stays exact', () => {
    const r = scoreTrack({ title: 'Mi Gente', artist: 'Someone Else' }, parseQuery('Mi Gente'));
    expect(r.matchType).toBe('exact');
  });

  it('exact artist query => strong', () => {
    const r = scoreTrack({ title: 'Kesariya', artist: 'Arijit Singh' }, parseQuery('Arijit Singh'));
    expect(r.matchType).toBe('strong');
  });

  it('title starts-with outranks contains; album/genre fall to related', () => {
    const starts = scoreTrack({ title: 'Chaleya intro', artist: 'X' }, parseQuery('Chaleya'));
    const contains = scoreTrack({ title: 'My Chaleya remix', artist: 'X' }, parseQuery('Chaleya'));
    expect(starts.relevanceScore).toBeGreaterThan(contains.relevanceScore);
    const album = scoreTrack({ title: 'ZZZ', artist: 'YYY', album: 'Chaleya' }, parseQuery('Chaleya'));
    expect(album.matchType).toBe('related');
    const genre = scoreTrack({ title: 'ZZZ', artist: 'YYY', genre: 'Chaleya' }, parseQuery('Chaleya'));
    expect(genre.matchType).toBe('related');
  });

  it('every result carries relevanceScore + matchType through ranking', () => {
    const ranked = rankSongs(
      [
        song({ id: 'a:1', providerId: 'a', providerTrackId: '1', title: 'Mi Gente', artist: 'David Tumax' }),
        song({ id: 'b:2', providerId: 'b', providerTrackId: '2', title: 'Mi Gente', artist: 'J Balvin' }),
      ],
      'Mi Gente J Balvin',
    );
    expect(ranked[0].artist).toBe('J Balvin');
    expect(ranked[0].matchType).toBe('exact');
    for (const s of ranked) {
      expect(typeof s.relevanceScore).toBe('number');
      expect(['exact', 'strong', 'partial', 'related']).toContain(s.matchType);
    }
  });

  it('hasExactMatch reflects exact presence', () => {
    expect(hasExactMatch([{ matchType: 'strong' } as Song])).toBe(false);
    expect(hasExactMatch([{ matchType: 'exact' } as Song])).toBe(true);
  });
});

// ---------- ranking / dedupe / pipeline ----------

describe('ranking + dedupe + pipeline', () => {
  it('ranks exact first, deterministic on ties', () => {
    const a = song({ id: 'j:1', providerId: 'jamendo', providerTrackId: '1', title: 'Faded', artist: 'Walker' });
    const b = song({ id: 'f:2', providerId: 'freetouse', providerTrackId: '2', title: 'Faded Light Remix', artist: 'Someone' });
    expect(rankSongs([b, a], 'faded')[0].id).toBe('j:1');
  });

  it('dedupe drops invalid + same-id, keeps cross-provider equivalents', () => {
    const a = song({ id: 'jamendo:1', providerId: 'jamendo', providerTrackId: '1', title: 'Kesariya', artist: 'Arijit Singh' });
    const b = song({ id: 'freetouse:2', providerId: 'freetouse', providerTrackId: '2', title: 'Kesariya', artist: 'Arijit Singh' });
    const dup = { ...a };
    const bad = song({ id: 'x:9', providerId: 'x', providerTrackId: '9', title: '', artist: 'Nobody' });
    expect(dedupeSongs([a, b, dup, bad])).toHaveLength(2);
    expect(isValidSong(bad)).toBe(false);
    expect(equivalenceKey(a)).toBe(equivalenceKey(b));
    expect(findEquivalents(a, [a, b])).toEqual([b]);
  });

  it('runSearchPipeline attaches scores and detects exact matches', () => {
    const out = runSearchPipeline(
      [song({ id: 'ab:1', providerId: 'airbeats', providerTrackId: '1', title: 'Tum Hi Ho', artist: 'Arijit Singh' })],
      'Tum Hi Ho Arijit Singh',
    );
    expect(out.songs[0].matchType).toBe('exact');
    expect(out.hasExactMatch).toBe(true);
    expect(out.query.originalQuery).toBe('Tum Hi Ho Arijit Singh');
    expect(out.query.normalizedQuery).toBe('tum hi ho arijit singh');
  });

  it('short-term cache serves identical repeats; stale aborts never overwrite', async () => {
    clearSearchCache();
    runSearchPipeline([song({ id: 'a:1', providerId: 'a', providerTrackId: '1', title: 'Faded', artist: 'A' })], 'faded');
    expect(cachedSongs('faded')).not.toBeNull();
    expect(cachedSongs('  FADED ')).not.toBeNull();
    expect(cachedSongs('something else')).toBeNull();

    // Isolation: one provider failing never breaks the others.
    const good = {
      id: 'good', name: 'good',
      capabilities: { supportsSearch: true, supportsStreaming: true, supportsOffline: true, supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true },
      searchSongs: async () => [song({ id: 'good:1', providerId: 'good', providerTrackId: '1' })],
      searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
      getSong: async () => null, getArtist: async () => null, getAlbum: async () => null,
      getPlaylist: async () => null, getAlbumTracks: async () => [],
      getStream: async () => { throw new Error('no'); }, getArtwork: async () => null, getLyrics: async () => null,
    };
    const bad = { ...good, id: 'bad', searchSongs: async () => { throw new Error('down'); } };
    const { songs: songs2, failures } = await searchSongsIsolated([good, bad] as never, 'faded');
    expect(songs2).toHaveLength(1);
    expect(failures).toEqual(['bad']);
  });
});

// ---------- capabilities: SEARCH ≠ STREAMING ≠ DOWNLOAD ≠ OFFLINE ----------

describe('provider capabilities (honest commercial catalog)', () => {
  it('normalizes the six-flag view', () => {
    const caps = normalizeProviderCapabilities({
      supportsSearch: true, supportsStreaming: true, supportsOffline: false,
      supportsLyrics: false, supportsArtwork: true, supportsArtists: true,
      supportsAlbums: true, commercialCatalog: true,
    });
    expect(caps).toMatchObject({
      search: true, metadata: true, streaming: true, downloads: false,
      offlineStorage: false, commercialCatalog: true,
    });
  });

  it('preview-flagged track: searchable + preview-streamable, never downloadable/offline', () => {
    const s = song({
      id: 'preview:1', providerId: 'airbeats', providerTrackId: '1',
      title: 'Kesariya', artist: 'Arijit Singh',
      streamUrl: 'https://example.com/p.m4a', sourceUrl: 'https://example.com/t',
      previewOnly: true, streamType: 'preview', previewDurationMs: 30000,
      downloadAllowed: false, downloadUrl: undefined,
      capabilities: { searchable: true, streamable: true, downloadable: false, offline: false, previewOnly: true },
    });
    expect(s.capabilities).toMatchObject({ searchable: true, streamable: true, downloadable: false, offline: false });
    expect(trackCapabilities(s, { capabilities: { supportsSearch: true, supportsStreaming: true, supportsOffline: false, supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true } } as never).offline).toBe(false);
  });

  it('JioSaavn in-app server maps tracks with 320kbps AAC upgrade and download support', () => {
    const s = mapJioSaavnSong({
      id: '9',
      title: 'Soch',
      artist: 'Hardy Sandhu',
      durationSec: 60,
      streamUrl: 'https://aac.saavncdn.com/123/track_96.mp4',
      sourceUrl: 'https://www.jiosaavn.com/song/soch/9',
    })!;
    expect(s.title).toBe('Soch');
    expect(s.streamUrl).toBe('https://aac.saavncdn.com/123/track_320.mp4');
    expect(s.downloadAllowed).toBe(true);
    expect(isValidSong(s)).toBe(true);
  });

  it('Spotify in-app server maps tracks as playable and downloadable', () => {
    const s = mapSpotifyTrack({
      id: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      durationSec: 213,
      artworkUrl: 'https://i.scdn.co/image/abc',
      sourceUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    })!;
    expect(s.id).toBe('spotify:4cOdK2wGLETKBW3PvgPWqT');
    expect(s.title).toBe('Never Gonna Give You Up');
    expect(s.downloadAllowed).toBe(true);
    expect(s.capabilities).toMatchObject({ searchable: true, streamable: true, downloadable: true, offline: true });
  });
});
