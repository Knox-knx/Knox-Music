// KNOX MASTER SEARCH + WEB DISCOVERY + AIRBEATS — acceptance tests.
//
// Covers Phase 27: search, ranking, dedupe, AirBeats, web discovery,
// playback classification, offline truthfulness. All mocked — no live
// network, no anti-bot bypass, no DRM/auth bypass.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseQuery } from '../../src/search/queryParser';
import { normalizeQuery, normalizeKeyPart } from '../../src/search/normalizeQuery';
import { rankSongs } from '../../src/search/ranking';
import { dedupeSongs, findEquivalents, groupEquivalents, durationsMatch } from '../../src/search/dedupe';
import { runSearchPipeline, searchSongsIsolated } from '../../src/search/searchEngine';
import { songToCandidate, isPlayableCandidate, isWebReference } from '../../src/search/trackCandidate';
import { validateSource, friendlySourceMessage } from '../../src/audio/sourceValidation';
import { validateStreamCandidate } from '../../src/audio/mediaDiagnostics';
import { validateDiscoveryUrl } from '../../src/discovery/ssrfGuard';
import { extractPageMetadata } from '../../src/discovery/metadataExtractor';
import { detectMusicPage, registerBuiltinWebPageProviders } from '../../src/discovery/providerDetector';
import { scoreDiscoveryMatch } from '../../src/discovery/trackMatcher';
import { scoreWebCandidate } from '../../src/discovery/web/musicPageMatcher';
import { detectProviderOrWeb } from '../../src/discovery/web/providerDetector';
import { candidateFromReference } from '../../src/discovery/web/webCandidate';
import {
  readWebDiscoveryCache,
  writeWebDiscoveryCache,
  clearWebDiscoveryCache,
} from '../../src/discovery/web/webDiscoveryCache';
import {
  registerWebSearchAdapter,
  clearWebSearchAdapters,
  searchAdapters,
} from '../../src/discovery/web/webSearchAdapter';
import {
  __resetWebSearchRateLimitsForTests,
  __clearWebSearchCacheForTests,
} from '../../src/discovery/webSearch';
import { JioSaavnProvider } from '../../src/providers/jiosaavn/provider';
import { mapJioSaavnSong } from '../../src/providers/jiosaavn/mapper';
import type { Song } from '../../src/core/types';

afterEach(() => {
  vi.unstubAllGlobals();
  clearWebSearchAdapters();
  clearWebDiscoveryCache();
  __resetWebSearchRateLimitsForTests();
  __clearWebSearchCacheForTests();
});

function song(over: Partial<Song> & { id: string }): Song {
  return {
    providerId: 'jamendo',
    providerTrackId: 'x',
    title: 'T',
    artist: 'A',
    album: '',
    durationMs: 180000,
    addedAt: 0,
    ...over,
  } as Song;
}

// ---------- SEARCH: query handling ----------

describe('query handling', () => {
  it('handles soch / hardy sandhu soch / hyphen variants', () => {
    for (const q of ['soch', 'hardy sandhu soch', 'hardy sandhu - soch', 'soch hardy sandhu', 'punjabi soch']) {
      const p = parseQuery(q);
      expect(p.full.length).toBeGreaterThan(0);
      expect(p.originalQuery).toBe(q);
    }
    const explicit = parseQuery('hardy sandhu - soch');
    expect(explicit.hypotheses[0]).toEqual({ title: 'hardy sandhu', artist: 'soch' });
    const walker = parseQuery('alan walker - alone');
    expect(walker.hypotheses[0]).toEqual({ title: 'alan walker', artist: 'alone' });
  });

  it('supports quoted phrases without destroying them', () => {
    const p = parseQuery('"hardy sandhu" "soch"');
    expect(p.quoted).toContain('hardy sandhu');
    expect(p.quoted).toContain('soch');
    const keys = p.hypotheses.map((h) => `${h.title}|${h.artist}`);
    expect(keys).toContain('hardy sandhu|soch');
  });

  it('preserves Unicode (Hindi/Punjabi/English mixed)', () => {
    expect(normalizeQuery('अरिजीत सिंह').normalizedQuery).toBe('अरिजीत सिंह');
    expect(normalizeQuery('hardy sandhu soch').normalizedQuery).toBe('hardy sandhu soch');
    expect(normalizeQuery('arijit singh tum hi ho').normalizedQuery).toBe('arijit singh tum hi ho');
    expect(normalizeKeyPart('  Soch   HARDY  ').length).toBeGreaterThan(0);
    const p = parseQuery('अरिजीत सिंह तुम ही हो');
    expect(p.originalQuery).toBe('अरिजीत सिंह तुम ही हो');
    expect(p.full.length).toBeGreaterThan(0);
  });

  it('normalizes punctuation/hyphens/apostrophes for comparison only', () => {
    expect(normalizeKeyPart("don't")).toBe('don t');
    expect(normalizeKeyPart('hardy-sandhu')).toBe('hardy sandhu');
    expect(normalizeKeyPart('the weeknd — blinding lights')).toBe('the weeknd blinding lights');
  });

  it('empty query yields no hypotheses abuse', () => {
    const p = parseQuery('   ');
    expect(p.hypotheses).toEqual([]);
    expect(runSearchPipeline([song({ id: 'a:1', providerTrackId: '1', title: 'X', artist: 'Y' })], '').songs).toHaveLength(1);
  });

  it('stale request: aborted provider search returns [] and never overwrites', async () => {
    const c = new AbortController();
    c.abort();
    const p = new JioSaavnProvider();
    // Aborted searchSongs returns [] (never throws stale data).
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(p.searchSongs('soch', c.signal)).resolves.toEqual([]);
  });

  it('provider timeout/failure isolation: one down never breaks others', async () => {
    const good = {
      id: 'good', name: 'good',
      capabilities: { supportsSearch: true, supportsStreaming: true, supportsOffline: true, supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true },
      searchSongs: async () => [song({ id: 'good:1', providerId: 'good', providerTrackId: '1', title: 'Soch', artist: 'Hardy' })],
      searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
      getSong: async () => null, getArtist: async () => null, getAlbum: async () => null,
      getPlaylist: async () => null, getAlbumTracks: async () => [],
      getStream: async () => { throw new Error('no'); }, getArtwork: async () => null, getLyrics: async () => null,
    };
    const bad = { ...good, id: 'bad', searchSongs: async () => { throw new Error('down'); } };
    const { songs: out, failures } = await searchSongsIsolated([good, bad] as never, 'soch');
    expect(out).toHaveLength(1);
    expect(failures).toEqual(['bad']);
  });
});

// ---------- RANKING ----------

describe('ranking', () => {
  it('exact title+artist outranks unrelated', () => {
    const exact = song({ id: 'a:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy Sandhu' });
    const unrelated = song({ id: 'b:2', providerId: 'jiosaavn', providerTrackId: '2', title: 'Something Else', artist: 'Nobody' });
    expect(rankSongs([unrelated, exact], 'hardy sandhu soch')[0].id).toBe('a:1');
  });

  it('playable exact outranks web reference', () => {
    const playable = song({ id: 'j:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy Sandhu', streamUrl: 'https://x/a.mp3', capabilities: { searchable: true, streamable: true, downloadable: true, offline: true, previewOnly: false } });
    const ref = song({ id: 'web-jiosaavn:1', providerId: 'web-jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy Sandhu', capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false } });
    const ranked = rankSongs([ref, playable], 'hardy sandhu soch');
    expect(ranked[0].id).toBe('j:1');
  });

  it('artist match beats unrelated; metadata confidence is tiebreak only', () => {
    const artistHit = song({ id: 'a:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Other Song', artist: 'Arijit Singh' });
    const unrelated = song({ id: 'b:2', providerId: 'jiosaavn', providerTrackId: '2', title: 'ZZZ', artist: 'YYY' });
    expect(rankSongs([unrelated, artistHit], 'arijit singh')[0].id).toBe('a:1');
  });
});

// ---------- DEDUPE ----------

describe('dedupe', () => {
  it('same song across providers stays visible with variants grouped', () => {
    const a = song({ id: 'jiosaavn:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy Sandhu', durationMs: 200000 });
    const b = song({ id: 'spotify:2', providerId: 'spotify', providerTrackId: '2', title: 'Soch', artist: 'Hardy Sandhu', durationMs: 202000 });
    expect(dedupeSongs([a, b, { ...a }])).toHaveLength(2);
    expect(findEquivalents(a, [a, b])).toEqual([b]);
    const groups = groupEquivalents([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sources).toHaveLength(2);
  });

  it('different songs with same title never merge', () => {
    const a = song({ id: 'a:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy Sandhu' });
    const b = song({ id: 'b:2', providerId: 'jiosaavn', providerTrackId: '2', title: 'Soch', artist: 'Someone Else' });
    expect(findEquivalents(a, [a, b])).toEqual([]);
    expect(groupEquivalents([a, b])).toHaveLength(2);
  });

  it('duration mismatch splits groups', () => {
    expect(durationsMatch(200000, 203000)).toBe(true);
    expect(durationsMatch(200000, 300000)).toBe(false);
    const a = song({ id: 'a:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Soch', artist: 'Hardy', durationMs: 200000 });
    const b = song({ id: 'b:2', providerId: 'spotify', providerTrackId: '2', title: 'Soch', artist: 'Hardy', durationMs: 400000 });
    expect(findEquivalents(a, [a, b])).toEqual([]);
  });
});

// ---------- TRACK CANDIDATE / PLAYABILITY ----------

describe('playability classification', () => {
  it('audio-stream is playable; web-reference never is', () => {
    const audio = song({ id: 'j:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'S', artist: 'A', streamUrl: 'https://x/a.mp3', capabilities: { searchable: true, streamable: true, downloadable: true, offline: true, previewOnly: false } });
    const ref = song({ id: 'web-x:1', providerId: 'web-jiosaavn', providerTrackId: '1', title: 'S', artist: 'A', capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false } });
    const ca = songToCandidate(audio, { supportsStreaming: true });
    const cr = songToCandidate(ref, {});
    expect(ca.sourceKind).toBe('audio-stream');
    expect(ca.playable).toBe(true);
    expect(isPlayableCandidate(ca)).toBe(true);
    expect(cr.sourceKind).toBe('web-reference');
    expect(cr.playable).toBe(false);
    expect(isWebReference(cr)).toBe(true);
    expect(isPlayableCandidate(cr)).toBe(false);
  });

  it('never infers playability from URL alone (discovery-only with stray URL stays reference)', () => {
    const yt = song({ id: 'y:1', providerId: 'web-music', providerTrackId: 'v1', title: 'S', artist: 'A', streamUrl: 'https://x/stray.mp3', capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false }, sourceUrl: 'https://music.youtube.com/watch?v=v1' });
    const c = songToCandidate(yt, { supportsStreaming: false });
    expect(c.sourceKind).toBe('web-reference');
    expect(c.playable).toBe(false);
    expect(c.streamUrl).toBeUndefined();
  });
});

// ---------- SOURCE VALIDATION ----------

describe('source validation', () => {
  it('web-reference is never playable', () => {
    const v = validateSource({ url: 'https://example.com/song/x', sourceKind: 'web-reference' });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('web-reference-not-playable');
    expect(friendlySourceMessage(v)).toMatch(/web reference/i);
  });

  it('https audio passes; private IP/localhost page blocked at discovery layer', () => {
    expect(validateSource({ url: 'https://aac.saavncdn.com/x_320.mp4', sourceKind: 'audio-stream', mimeType: 'audio/mp4' }).ok).toBe(true);
    expect(validateDiscoveryUrl('http://127.0.0.1/song/x').ok).toBe(false);
    expect(validateDiscoveryUrl('http://localhost/song/x').ok).toBe(false);
    expect(validateDiscoveryUrl('http://192.168.1.10/song/x').ok).toBe(false);
    expect(validateDiscoveryUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateDiscoveryUrl('https://www.jiosaavn.com/song/soch/abc').ok).toBe(true);
  });

  it('unsafe protocols rejected with honest message (internal keeps reason)', () => {
    const v = validateStreamCandidate({ url: 'ftp://example.com/x.mp3' });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unsafe-protocol');
    const sv = validateSource({ url: 'ftp://example.com/x.mp3', sourceKind: 'audio-stream' });
    expect(sv.ok).toBe(false);
    expect(friendlySourceMessage(sv, 'JioSaavn')).not.toMatch(/unsafe-protocol/);
  });

  it('temp-blob requires blob:, temp-file accepts asset-local', () => {
    expect(validateSource({ url: 'blob:http://localhost/123', sourceKind: 'temp-blob' }).ok).toBe(true);
    expect(validateSource({ url: 'https://example.com/a.mp3', sourceKind: 'temp-blob' }).ok).toBe(false);
    expect(validateSource({ url: 'http://asset.localhost/x.m4a', sourceKind: 'temp-file' }).ok).toBe(true);
    expect(validateSource({ url: 'asset://localhost/x.m4a', sourceKind: 'temp-file' }).ok).toBe(true);
  });
});

// ---------- JIOSAAVN IN-APP SERVER ----------

describe('jiosaavn classification', () => {
  function jiosaavnRaw(over: Record<string, unknown> = {}) {
    return {
      id: 'abc123',
      title: 'Soch',
      artist: 'Hardy Sandhu',
      album: 'Album',
      durationSec: 200,
      artworkUrl: 'https://img/a.jpg',
      streamUrl: 'https://aac.saavncdn.com/x_96.mp4',
      sourceUrl: 'https://www.jiosaavn.com/song/soch/xyz',
      ...over,
    };
  }

  it('authorized stream maps to audio-stream (playable) and upgrades to 320kbps', () => {
    const s = mapJioSaavnSong(jiosaavnRaw() as never)!;
    expect(s.providerId).toBe('jiosaavn');
    expect(s.streamUrl).toBe('https://aac.saavncdn.com/x_320.mp4');
    expect(s.sourceUrl).toContain('jiosaavn.com');
    const c = songToCandidate(s, { supportsStreaming: true });
    expect(c.sourceKind).toBe('audio-stream');
    expect(c.playable).toBe(true);
  });

  it('record without direct CDN tier remains streamable via in-app audio server', () => {
    const s = mapJioSaavnSong(jiosaavnRaw({ streamUrl: undefined }) as never)!;
    expect(s.streamUrl).toBeUndefined();
    expect(s.capabilities?.streamable).toBe(true);
    expect(s.downloadAllowed).toBe(true);
  });

  it('getStream resolves authorized https audio with offline permission', async () => {
    const p = new JioSaavnProvider();
    const stream = await p.getStream(song({ id: 'jiosaavn:abc', providerId: 'jiosaavn', providerTrackId: 'abc', title: 'Soch', artist: 'Hardy', streamUrl: 'https://aac.saavncdn.com/x_320.mp4', downloadUrl: 'https://aac.saavncdn.com/x_320.mp4', downloadAllowed: true }));
    expect(stream.url).toMatch(/^https:\/\//);
    expect(stream.mimeType).toBe('audio/mp4');
    expect(stream.allowsOffline).toBe(true);
  });
});

// ---------- WEB DISCOVERY ----------

describe('web discovery', () => {
  it('adapter abstraction isolates failures (one down, one up)', async () => {
    registerWebSearchAdapter({
      id: 'good', displayName: 'Good',
      search: async () => [{ url: 'https://music.apple.com/song/x/123', title: 'Soch' }],
    });
    registerWebSearchAdapter({
      id: 'bad', displayName: 'Bad',
      search: async () => { throw new Error('down'); },
    });
    const { results, failures } = await searchAdapters('hardy sandhu soch');
    expect(results).toHaveLength(1);
    expect(failures).toEqual(['bad']);
  });

  it('no adapter → honest unavailable (never faked)', async () => {
    const { results, failures } = await searchAdapters('soch');
    expect(results).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('JSON-LD MusicRecording preferred over weak metadata', () => {
    const html = `<html><head><link rel="canonical" href="https://example.com/song/soch" />
      <script type="application/ld+json">{"@type":"MusicRecording","name":"Soch","byArtist":{"name":"Hardy Sandhu"},"duration":"PT4M10S"}</script>
      <title>Wrong Title - Someone</title></head><body></body></html>`;
    const meta = extractPageMetadata(html, 'https://example.com/song/soch');
    expect(meta?.title).toBe('Soch');
    expect(meta?.artist).toBe('Hardy Sandhu');
    expect(meta?.rawSource).toBe('json-ld');
  });

  it('OpenGraph + canonical URL extracted', () => {
    const html = `<html><head><meta property="og:title" content="Soch" /><meta property="og:image" content="https://img/a.jpg" />
      <link rel="canonical" href="https://example.com/song/soch" /></head></html>`;
    const meta = extractPageMetadata(html, 'https://example.com/song/soch', { site: 'Example' });
    expect(meta?.title).toBe('Soch');
    expect(meta?.canonicalUrl).toContain('example.com');
  });

  it('malformed HTML returns null (never throws)', () => {
    expect(extractPageMetadata('', 'https://example.com/')).toBeNull();
    expect(extractPageMetadata('<html><<>>', 'https://example.com/')).toBeNull();
  });

  it('provider detection labels known sites, unknown → web', () => {
    registerBuiltinWebPageProviders();
    expect(detectMusicPage('https://music.apple.com/in/song/soch/123')?.webProviderId).toBe('apple-music');
    expect(detectMusicPage('https://musicbrainz.org/recording/abc')?.webProviderId).toBe('musicbrainz');
    expect(detectMusicPage('https://unknown.example.com/song/soch') ).toBeNull();
    expect(detectProviderOrWeb('https://unknown.example.com/song/soch').providerId).toBe('web');
  });

  it('music matching: strong for Soch/Hardy, weak for wrong artist', () => {
    const strong = candidateFromReference({
      provider: 'apple-music', title: 'Soch', artist: 'Hardy Sandhu',
      canonicalUrl: 'https://music.apple.com/song/soch/1', sourceType: 'web',
      playable: false, downloadable: false, cacheable: false,
    });
    const weak = candidateFromReference({
      provider: 'apple-music', title: 'Soch', artist: 'Completely Different',
      canonicalUrl: 'https://music.apple.com/song/soch/2', sourceType: 'web',
      playable: false, downloadable: false, cacheable: false,
    });
    expect(scoreWebCandidate(strong, 'hardy sandhu soch').confidence).toBeGreaterThan(70);
    expect(scoreWebCandidate(weak, 'hardy sandhu soch').confidence).toBeLessThan(60);
    expect(scoreDiscoveryMatch(strong as never, { title: 'Soch', artist: 'Hardy Sandhu' } as never).confidence).toBeGreaterThan(85);
  });

  it('web cache is short-lived metadata only (no audio/creds)', () => {
    const c = candidateFromReference({
      provider: 'web', title: 'Soch', artist: 'Hardy',
      canonicalUrl: 'https://example.com/soch', sourceType: 'web',
      playable: false, downloadable: false, cacheable: false,
    });
    writeWebDiscoveryCache('hardy sandhu soch', [c]);
    expect(readWebDiscoveryCache('hardy sandhu soch')).toHaveLength(1);
    expect(readWebDiscoveryCache('HARDY SANDHU SOCH')).toHaveLength(1);
    expect(readWebDiscoveryCache('other')).toBeNull();
  });

  it('oversized/timeout/redirect/private-IP guards exist (pure validators)', () => {
    expect(validateDiscoveryUrl('https://example.com/' + 'a'.repeat(3000)).ok).toBe(false);
    expect(validateDiscoveryUrl('http://169.254.169.254/latest/').ok).toBe(false);
    expect(validateDiscoveryUrl('https://user:pass@example.com/').ok).toBe(false);
  });
});

// ---------- OFFLINE TRUTHFULNESS ----------

describe('offline status honesty', () => {
  it('candidate without verified file is not offline-file', () => {
    const s = song({ id: 'j:1', providerId: 'jamendo', providerTrackId: '1', title: 'S', artist: 'A', streamUrl: 'https://x/a.mp3', downloadAllowed: true });
    const c = songToCandidate(s, { hasOfflineFile: false });
    expect(c.sourceKind).not.toBe('offline-file');
  });

  it('verified file upgrades to offline-file (playable)', () => {
    const s = song({ id: 'j:1', providerId: 'jamendo', providerTrackId: '1', title: 'S', artist: 'A' });
    const c = songToCandidate(s, { hasOfflineFile: true });
    expect(c.sourceKind).toBe('offline-file');
    expect(c.playable).toBe(true);
    expect(isPlayableCandidate(c)).toBe(true);
  });
});

// ---------- QUERY MATRIX (§20: offline, deterministic, no network) ----------

describe('query matrix (real-world queries, fixed fixtures)', () => {
  const soch = song({ id: 'ab:1', providerId: 'airbeats', providerTrackId: '1', title: 'Soch', artist: 'Harrdy Sandhu', streamUrl: 'https://x/a.mp4' });
  const sochNaSake = song({ id: 'ab:2', providerId: 'airbeats', providerTrackId: '2', title: 'Soch Na Sake-Sab Tera', artist: 'Neeti Mohan, Harrdy Sandhu', streamUrl: 'https://x/b.mp4' });
  const alone = song({ id: 'j:1', providerId: 'jamendo', providerTrackId: '1', title: 'Alone', artist: 'Alan Walker', streamUrl: 'https://x/c.mp3' });
  const spectre = song({ id: 'j:2', providerId: 'jamendo', providerTrackId: '2', title: 'The Spectre', artist: 'Alan Walker', streamUrl: 'https://x/d.mp3' });
  const kesariya = song({ id: 'ab:3', providerId: 'airbeats', providerTrackId: '3', title: 'Kesariya', artist: 'Arijit Singh', streamUrl: 'https://x/e.mp4' });
  const blinding = song({ id: 'f:1', providerId: 'freetouse', providerTrackId: '1', title: 'Blinding Lights', artist: 'The Weeknd', streamUrl: 'https://x/f.mp3' });
  const tumHiHo = song({ id: 'ab:4', providerId: 'airbeats', providerTrackId: '4', title: 'Tum Hi Ho', artist: 'अरिजीत सिंह', streamUrl: 'https://x/g.mp4' });
  const pool = [sochNaSake, soch, alone, spectre, kesariya, blinding, tumHiHo];

  const matrix: { query: string; wantTop: string; wantTopType: string; wantExact: boolean }[] = [
    { query: 'hardy sandhu soch', wantTop: 'ab:1', wantTopType: 'exact', wantExact: true },
    { query: 'soch', wantTop: 'ab:1', wantTopType: 'exact', wantExact: true },
    { query: 'soch hardy sandhu', wantTop: 'ab:1', wantTopType: 'exact', wantExact: true },
    { query: '"hardy sandhu" soch', wantTop: 'ab:1', wantTopType: 'exact', wantExact: true },
    { query: 'alan walker alone', wantTop: 'j:1', wantTopType: 'exact', wantExact: true },
    { query: 'the spectre alan walker', wantTop: 'j:2', wantTopType: 'exact', wantExact: true },
    { query: 'arijit singh', wantTop: 'ab:3', wantTopType: 'strong', wantExact: false },
    { query: 'the weeknd blinding lights', wantTop: 'f:1', wantTopType: 'exact', wantExact: true },
    { query: 'अरिजीत सिंह', wantTop: 'ab:4', wantTopType: 'strong', wantExact: false },
  ];

  for (const row of matrix) {
    it(`matrix: ${row.query}`, () => {
      const out = runSearchPipeline(pool, row.query);
      expect(out.songs[0].id).toBe(row.wantTop);
      expect(out.songs[0].matchType).toBe(row.wantTopType);
      expect(out.hasExactMatch).toBe(row.wantExact);
      expect(out.hasStrongMatch).toBe(true);
      // Spot record per §20.
      const spot = {
        query: row.query,
        exactMatch: out.hasExactMatch,
        resultCount: out.songs.length,
        playableCount: out.songs.filter((s) => s.capabilities?.streamable !== false || !!s.streamUrl).length,
        webReferenceCount: out.songs.filter((s) => s.providerId.startsWith('web-')).length,
        airbeatsCount: out.songs.filter((s) => s.providerId === 'airbeats').length,
        errors: out.failures,
      };
      expect(spot.resultCount).toBe(pool.length);
      expect(spot.errors).toEqual([]);
    });
  }

  it('matrix: nonsense query yields no exact/strong match', () => {
    const out = runSearchPipeline(pool, 'zxqwv nonsense123');
    expect(out.hasExactMatch).toBe(false);
    expect(out.hasStrongMatch).toBe(false);
    expect(out.songs.every((s) => s.matchType === 'partial' || s.matchType === 'related')).toBe(true);
  });
});

// ---------- FUZZY RELEVANCE UNITS ----------

describe('fuzzy relevance units', () => {
  it('token typo tolerance is bounded', async () => {
    const { tokenFuzzyEqual, tokensCover, tokensEqualSet } = await import('../../src/search/relevance');
    expect(tokenFuzzyEqual('hardy', 'harrdy')).toBe(true);
    expect(tokenFuzzyEqual('j', 'balvin')).toBe(false);
    expect(tokenFuzzyEqual('david', 'balvin')).toBe(false);
    expect(tokenFuzzyEqual('tumax', 'balvin')).toBe(false);
    expect(tokenFuzzyEqual('abc', 'abd')).toBe(false);
    expect(tokensCover('neeti mohan harrdy sandhu', 'hardy sandhu')).toBe(true);
    expect(tokensCover('david tumax', 'j balvin')).toBe(false);
    expect(tokensEqualSet('soch', 'soch na sake sab tera')).toBe(false);
    expect(tokensEqualSet('hardy sandhu', 'harrdy sandhu')).toBe(true);
  });

  it('wrong-artist same-title is never exact', async () => {
    const { parseQuery } = await import('../../src/search/queryParser');
    const { scoreTrack } = await import('../../src/search/relevance');
    const r = scoreTrack({ title: 'Mi Gente', artist: 'David Tumax' }, parseQuery('Mi Gente J Balvin'));
    expect(r.matchType).not.toBe('exact');
    const ok = scoreTrack({ title: 'Mi Gente', artist: 'J Balvin' }, parseQuery('Mi Gente J Balvin'));
    expect(ok.matchType).toBe('exact');
    expect(ok.relevanceScore).toBe(100);
  });
});

// ---------- PLAYBACK FAILURE CLASSIFICATION (§6) ----------

describe('playback failure classification', () => {
  it('maps stages to codes with useful UI text (raw preserved by caller)', async () => {
    const { classifyPlaybackFailure } = await import('../../src/audio/mediaDiagnostics');
    expect(classifyPlaybackFailure(new Error('AirBeats provided a web page rather than a playable audio source'), true))
      .toMatchObject({ code: 'WEB_REFERENCE', ui: expect.stringMatching(/web page/) });
    expect(classifyPlaybackFailure(new Error('Invalid audio source (unsafe-protocol)'), false).code).toBe('SOURCE_INVALID');
    expect(classifyPlaybackFailure(new Error('Temporary download failed (HTTP 500)'), true).code).toBe('TEMP_FILE_FAILED');
    expect(classifyPlaybackFailure(new Error('Temporary audio failed to load (MEDIA_ERR_SRC_NOT_SUPPORTED code 4)'), true))
      .toMatchObject({ code: 'MEDIA_LOAD_FAILED', ui: 'AirBeats audio source could not be loaded.' });
    expect(classifyPlaybackFailure(new Error('clock did not advance after play()'), false).code).toBe('CLOCK_FROZEN');
    expect(classifyPlaybackFailure(new Error('Not found (HTTP 404)'), false).code).toBe('SOURCE_UNAVAILABLE');
    // Generic errors never surface bare: always a code + sentence.
    const g = classifyPlaybackFailure(new Error('boom'), false);
    expect(g.code).toBeTruthy();
    expect(g.ui).toBeTruthy();
    expect(g.ui).not.toBe('boom');
  });
});

// ---------- PLAYBACK DIAGNOSTIC FORMAT (§25) ----------

describe('KNOX_PLAYBACK_DIAGNOSTIC format', () => {
  it('emits the exact scrubbed single-line vocabulary', async () => {
    const { buildPlaybackDiagnostic, formatPlaybackDiagnostic } = await import('../../src/audio/playbackDebug');
    const d = buildPlaybackDiagnostic({
      song: { id: 'airbeats:x', providerId: 'airbeats', providerTrackId: 'x', title: 'Soch', artist: 'Harrdy Sandhu' } as never,
      cache: 'MISS',
      source: 'PROVIDER',
      sourceUrl: 'https://aac.saavncdn.com/026/abc_320.mp4?sig=SECRET&token=XYZ',
      container: 'mp4-m4a',
      playCalled: true,
      playResolved: false,
      playRejected: new Error('boom'),
      timeBefore: 0,
      timeAfter: 0,
      clockAdvancing: false,
      lastMediaEvent: 'error',
      audioError: 'MEDIA_ERR_SRC_NOT_SUPPORTED(4)',
      stage: 'MEDIA_LOAD',
    });
    const line = formatPlaybackDiagnostic(d);
    expect(line).toContain('KNOX_PLAYBACK_DIAGNOSTIC');
    expect(line).toContain('provider=airbeats');
    expect(line).toContain('cache=MISS');
    expect(line).toContain('source_protocol=https');
    expect(line).toContain('source_host=aac.saavncdn.com');
    expect(line).toContain('stage=MEDIA_LOAD');
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('token=');
    expect(line).not.toContain('/026/abc_320.mp4');
  });
});
