// YouTube provider — download-first permanent offline replay.
// Covers: search mapping (youtube:<videoId>), health layers, first-play
// single download, atomic permanent commit, validation, replay without
// network/yt-dlp, restart metadata, Smart Cache isolation, duplicate-play
// dedup, failure honesty, queue/favorites, provider separation, dynamic port.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../../src/data/db';
import { offlineRepo, songRepo, favoriteRepo } from '../../src/data/repositories';
import { YouTubeProvider } from '../../src/providers/youtube/provider';
import {
  ensurePermanentYouTubeTrack,
  getPermanentYouTubeEntry,
  hasPermanentYouTube,
  validateYouTubeAudioBytes,
  isValidYouTubeVideoId,
  youtubeSongId,
  youtubeVideoIdOf,
  __setYouTubeBaseUrlForTests,
  __resetYouTubeBaseUrlForTests,
  __youtubeInFlightForTests,
} from '../../src/providers/youtube/youtubeOffline';
import { clearSmartCache } from '../../src/cache/smartCache';
import { countCacheEntries } from '../../src/cache/cacheStorage';
import type { Song } from '../../src/core/types';

const BASE = 'http://127.0.0.1:59999';

const mp3Bytes = (n = 4096): Uint8Array => {
  const b = new Uint8Array(n).fill(0x61);
  b[0] = 0x49; b[1] = 0x44; b[2] = 0x33; // ID3 — recognized MP3 container
  return b;
};

const htmlBytes = (n = 2048): Uint8Array => {
  const b = new Uint8Array(n).fill(0x20);
  const head = '<!doctype html><html>';
  for (let i = 0; i < head.length; i += 1) b[i] = head.charCodeAt(i);
  return b;
};

function song(videoId: string, over: Partial<Song> = {}): Song {
  return {
    id: `youtube:${videoId}`,
    providerId: 'youtube',
    providerTrackId: videoId,
    title: 'Mi Gente',
    artist: 'J Balvin',
    album: '',
    durationMs: 186000,
    artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    downloadAllowed: true,
    addedAt: Date.now(),
    ...over,
  } as Song;
}

function audioResponse(bytes: Uint8Array, mime = 'audio/mpeg'): Response {
  const buf = bytes.slice().buffer as ArrayBuffer;
  return new Response(buf, { status: 200, headers: { 'content-type': mime } });
}

/** Mock sidecar: search results + download POST + audio GET, with call counts. */
function mockSidecar(opts: {
  searchResults?: unknown[];
  downloadDelayMs?: number;
  audioBytes?: Uint8Array;
  health?: unknown;
  onDownload?: () => void;
  failDownload?: { status: number; body: unknown };
} = {}) {
  const calls = { search: 0, download: 0, audio: 0, health: 0 };
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/health')) {
      calls.health += 1;
      return new Response(JSON.stringify(opts.health ?? { ok: true, service: 'youtube-audio', ytDlp: true, ffmpeg: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/youtube/audio')) {
      calls.audio += 1;
      return audioResponse(opts.audioBytes ?? mp3Bytes());
    }
    if (u.includes('/api/youtube/download')) {
      calls.download += 1;
      opts.onDownload?.();
      if (opts.downloadDelayMs) await new Promise((r) => setTimeout(r, opts.downloadDelayMs));
      if (opts.failDownload) {
        return new Response(JSON.stringify(opts.failDownload.body), {
          status: opts.failDownload.status, headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { videoId?: string };
      return new Response(JSON.stringify({
        success: true, videoId: body.videoId, filePath: `/offline/youtube/youtube_${body.videoId}.mp3`,
        sizeBytes: (opts.audioBytes ?? mp3Bytes()).byteLength, format: 'mp3', cached: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/youtube/search')) {
      calls.search += 1;
      return new Response(JSON.stringify(opts.searchResults ?? []), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(async () => {
  __setYouTubeBaseUrlForTests(BASE);
  URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random().toString(36).slice(2)}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // Fresh DB state per test (offline + songs + smartcache).
  await getDb().offline.clear().catch(() => undefined);
  await getDb().songs.clear().catch(() => undefined);
  await getDb().smartcache.clear().catch(() => undefined);
  await getDb().favorites.clear().catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetYouTubeBaseUrlForTests();
});

describe('video id validation', () => {
  it('accepts real YouTube ids, rejects traversal/URLs/empty', () => {
    expect(isValidYouTubeVideoId('wnJ6LuUFpMo')).toBe(true);
    expect(isValidYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(isValidYouTubeVideoId('../etc/passwd')).toBe(false);
    expect(isValidYouTubeVideoId('a/b')).toBe(false);
    expect(isValidYouTubeVideoId('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isValidYouTubeVideoId('')).toBe(false);
    expect(isValidYouTubeVideoId('ab')).toBe(false);
    expect(youtubeVideoIdOf(song('wnJ6LuUFpMo'))).toBe('wnJ6LuUFpMo');
    expect(youtubeVideoIdOf('youtube:wnJ6LuUFpMo')).toBe('wnJ6LuUFpMo');
    expect(youtubeVideoIdOf('../etc')).toBeNull();
    expect(youtubeSongId('wnJ6LuUFpMo')).toBe('youtube:wnJ6LuUFpMo');
  });
});

describe('search (metadata only, no download)', () => {
  it('returns valid results mapped to youtube:<videoId>', async () => {
    mockSidecar({
      searchResults: [
        { id: 'wnJ6LuUFpMo', title: 'Mi Gente', channel: 'J Balvin', duration: 186, url: 'https://www.youtube.com/watch?v=wnJ6LuUFpMo', live: false },
        { id: 'dQw4w9WgXcQ', title: 'Never', channel: 'Rick', duration: 214, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', live: false },
      ],
    });
    const songs = await new YouTubeProvider().searchSongs('Mi Gente');
    expect(songs).toHaveLength(2);
    expect(songs[0].id).toBe('youtube:wnJ6LuUFpMo');
    expect(songs[0].providerId).toBe('youtube');
    expect(songs[0].providerTrackId).toBe('wnJ6LuUFpMo');
    expect(songs[0].title).toBe('Mi Gente');
    expect(songs[0].artist).toBe('J Balvin');
    expect(songs[0].sourceUrl).toContain('wnJ6LuUFpMo');
  });

  it('rejects malformed ids and live streams before mapping', async () => {
    mockSidecar({
      searchResults: [
        { id: '../etc/passwd', title: 'evil', channel: 'x', duration: 10, url: 'https://x', live: false },
        { id: 'LIVE1234567', title: 'live', channel: 'x', duration: 9999, url: 'https://x', live: true },
        { id: 'wnJ6LuUFpMo', title: 'Mi Gente', channel: 'J Balvin', duration: 186, url: 'https://x', live: false },
      ],
    });
    const songs = await new YouTubeProvider().searchSongs('Mi Gente');
    expect(songs.map((s) => s.id)).toEqual(['youtube:wnJ6LuUFpMo']);
  });

  it('returns [] for empty queries without network', async () => {
    const { fetchMock } = mockSidecar();
    expect(await new YouTubeProvider().searchSongs('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports service unavailable honestly (no masked error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('refused'); }));
    await expect(new YouTubeProvider().searchSongs('Mi Gente')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('health (structured yt-dlp/ffmpeg, dynamic port)', () => {
  it('succeeds when dependencies exist', async () => {
    mockSidecar({ health: { ok: true, service: 'youtube-audio', ytDlp: true, ffmpeg: true } });
    expect(await new YouTubeProvider().checkHealth()).toBe(true);
  });

  it('reports missing yt-dlp as unhealthy', async () => {
    mockSidecar({ health: { ok: false, service: 'youtube-audio', ytDlp: false, ffmpeg: true, error: 'yt-dlp executable not found' } });
    expect(await new YouTubeProvider().checkHealth()).toBe(false);
  });

  it('reports missing FFmpeg as unhealthy', async () => {
    mockSidecar({ health: { ok: false, service: 'youtube-audio', ytDlp: true, ffmpeg: false, error: 'FFmpeg executable not found' } });
    expect(await new YouTubeProvider().checkHealth()).toBe(false);
  });

  it('uses the dynamic sidecar port (never hard-coded 5000)', async () => {
    const { fetchMock } = mockSidecar({ searchResults: [] });
    await new YouTubeProvider().searchSongs('x');
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain('127.0.0.1:59999');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('127.0.0.1:5000');
  });
});

describe('download-first permanent storage', () => {
  it('first play triggers exactly one download and commits a validated file', async () => {
    const { calls } = mockSidecar();
    const asset = await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(asset.fromCache).toBe(false);
    expect(asset.sizeBytes).toBeGreaterThan(0);
    expect(asset.mimeType).toBe('audio/mpeg');
    expect(calls.download).toBe(1);
    expect(calls.audio).toBe(1);
    const entry = await getPermanentYouTubeEntry('wnJ6LuUFpMo');
    expect(entry?.fileSize).toBeGreaterThan(0);
    expect(entry?.mimeType).toBe('audio/mpeg');
    expect(__youtubeInFlightForTests()).toBe(0);
  });

  it('existing permanent file prevents yt-dlp execution', async () => {
    const first = mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(first.calls.download).toBe(1);
    // Second ensure with a fetch mock that fails the test on any network use.
    const fetchMock = vi.fn(async () => { throw new Error('network must not be used on replay'); });
    vi.stubGlobal('fetch', fetchMock);
    const asset = await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(asset.fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__youtubeInFlightForTests()).toBe(0);
  });

  it('replay works with internet disabled (no yt-dlp, no search, no fetch)', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await hasPermanentYouTube('wnJ6LuUFpMo')).toBe(true);
    const asset = await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(asset.fromCache).toBe(true);
    expect(asset.sizeBytes).toBeGreaterThan(0);
  });

  it('restart recovers permanent metadata (song + offline rows)', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    // Simulate restart: read back from the persisted tables.
    const stored = await songRepo.get('youtube:wnJ6LuUFpMo');
    expect(stored?.providerId).toBe('youtube');
    expect(stored?.providerTrackId).toBe('wnJ6LuUFpMo');
    expect(stored?.title).toBe('Mi Gente');
    expect(stored?.sourceUrl).toContain('wnJ6LuUFpMo');
    expect(stored?.isOfflineAvailable).toBe(true);
    const entry = await offlineRepo.get('youtube:wnJ6LuUFpMo');
    expect(entry?.provider).toBe('youtube');
    expect(entry?.providerTrackId).toBe('wnJ6LuUFpMo');
    expect(entry?.title).toBe('Mi Gente');
    expect(entry?.fileSize).toBeGreaterThan(0);
    expect(entry?.mimeType).toBe('audio/mpeg');
    expect(entry?.quality).toContain('YouTube');
    expect(entry?.createdAt).toBeGreaterThan(0);
  });

  it('three simultaneous Play requests create only one download', async () => {
    const { calls } = mockSidecar({ downloadDelayMs: 120 });
    const s = song('wnJ6LuUFpMo');
    const [a, b, c] = await Promise.all([
      ensurePermanentYouTubeTrack(s),
      ensurePermanentYouTubeTrack(s),
      ensurePermanentYouTubeTrack(s),
    ]);
    expect(calls.download).toBe(1);
    expect(a.blob.size).toBe(b.blob.size);
    expect(b.blob.size).toBe(c.blob.size);
    expect(__youtubeInFlightForTests()).toBe(0);
  });

  it('invalid video ids never reach the network', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('must not fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(ensurePermanentYouTubeTrack(song('../etc/passwd'))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__youtubeInFlightForTests()).toBe(0);
  });

  it('failed download leaves no corrupt permanent file and releases the lock', async () => {
    mockSidecar({ failDownload: { status: 500, body: { success: false, errorCode: 'DOWNLOAD_FAILED', message: 'boom' } } });
    await expect(ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'))).rejects.toThrow();
    expect(await getPermanentYouTubeEntry('wnJ6LuUFpMo')).toBeUndefined();
    expect(__youtubeInFlightForTests()).toBe(0);
  });

  it('HTML error bytes are rejected (never stored as audio)', async () => {
    mockSidecar({ audioBytes: htmlBytes() });
    await expect(ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'))).rejects.toThrow(/validation/i);
    expect(await getPermanentYouTubeEntry('wnJ6LuUFpMo')).toBeUndefined();
  });

  it('corrupt permanent entries are invalidated and redownloaded once', async () => {
    // Seed a corrupt permanent entry (HTML masquerading as audio).
    await offlineRepo.put(
      song('wnJ6LuUFpMo'),
      new Blob([htmlBytes() as unknown as BlobPart], { type: 'text/html' }),
      'MP3 (YouTube)',
    );
    const { calls } = mockSidecar();
    const asset = await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(calls.download).toBe(1);
    expect(asset.fromCache).toBe(false);
    expect(asset.mimeType).toBe('audio/mpeg');
  });
});

describe('byte validation', () => {
  it('accepts real MP3 headers, rejects HTML/JSON/truncated', () => {
    expect(validateYouTubeAudioBytes(mp3Bytes()).ok).toBe(true);
    expect(validateYouTubeAudioBytes(htmlBytes()).ok).toBe(false);
    expect(validateYouTubeAudioBytes(new Uint8Array(10)).ok).toBe(false);
    expect(validateYouTubeAudioBytes(mp3Bytes(), 'text/html').ok).toBe(false);
  });
});

describe('Smart Cache isolation', () => {
  it('clear does not delete permanent YouTube files', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(await hasPermanentYouTube('wnJ6LuUFpMo')).toBe(true);
    await clearSmartCache();
    expect(await hasPermanentYouTube('wnJ6LuUFpMo')).toBe(true);
  });

  it('youtube commits never write to the Smart Cache table', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    expect(await countCacheEntries()).toBe(0);
  });
});

describe('queue, favorites, provider separation', () => {
  it('queue of two tracks commits both permanently', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    await ensurePermanentYouTubeTrack(song('dQw4w9WgXcQ', { title: 'Never', artist: 'Rick' }));
    expect(await hasPermanentYouTube('wnJ6LuUFpMo')).toBe(true);
    expect(await hasPermanentYouTube('dQw4w9WgXcQ')).toBe(true);
  });

  it('favorite/library saved tracks remain resolvable offline', async () => {
    mockSidecar();
    await ensurePermanentYouTubeTrack(song('wnJ6LuUFpMo'));
    await favoriteRepo.add('youtube:wnJ6LuUFpMo');
    expect(await favoriteRepo.isFavorite('youtube:wnJ6LuUFpMo')).toBe(true);
    const ids = await favoriteRepo.listSongIds();
    expect(ids).toContain('youtube:wnJ6LuUFpMo');
    // Internet off: library metadata + permanent bytes still resolve.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const stored = await songRepo.get('youtube:wnJ6LuUFpMo');
    expect(stored?.id).toBe('youtube:wnJ6LuUFpMo');
    expect(await hasPermanentYouTube('wnJ6LuUFpMo')).toBe(true);
  });

  it('youtube and youtube-music stay separate (ids + capabilities)', async () => {
    const { YouTubeMusicProvider } = await import('../../src/providers/youtubeMusic/provider');
    const yt = new YouTubeProvider();
    const ytm = new YouTubeMusicProvider();
    expect(yt.id).toBe('youtube');
    expect(ytm.id).toBe('youtube-music');
    expect(yt.capabilities.supportsStreaming).toBe(true);
    expect(ytm.capabilities.supportsStreaming).toBe(true);
    expect(yt.capabilities.supportsPlaybackCache).toBe(false);
  });

  it('provider getStream resolves the permanent local asset', async () => {
    mockSidecar();
    const stream = await new YouTubeProvider().getStream(song('wnJ6LuUFpMo'));
    expect(stream.url.startsWith('blob:')).toBe(true);
    expect(stream.mimeType).toBe('audio/mpeg');
    expect(stream.allowsOffline).toBe(true);
  });

  it('provider failure surfaces a short safe message (no stderr dumps)', async () => {
    mockSidecar({ failDownload: { status: 500, body: { success: false, errorCode: 'DOWNLOAD_FAILED', message: 'x'.repeat(5000) } } });
    const err = await new YouTubeProvider().getStream(song('wnJ6LuUFpMo')).catch((e) => e);
    expect(String(err.message).length).toBeLessThan(500);
  });
});

describe('sidecar packaging contract (static)', () => {
  const ytSidecar = readFileSync(join(__dirname, '..', '..', 'services', 'youtube', 'sidecar.js'), 'utf8');
  const audioSvc = readFileSync(join(__dirname, '..', '..', 'services', 'audioService.js'), 'utf8');

  it('sidecar is plain JS (no TypeScript) so node can start it', () => {
    expect(ytSidecar).not.toMatch(/^\s*interface\s+\w+/m);
    expect(ytSidecar).not.toMatch(/:\s*(string|number|boolean|object)\s*[,)=]/);
  });

  it('sidecar is stdlib-only (no express) for packaged builds', () => {
    expect(ytSidecar).not.toMatch(/from\s+['"]express['"]/);
    expect(ytSidecar).not.toMatch(/require\(['"]express['"]\)/);
  });

  it('health reports yt-dlp/ffmpeg truthfully (never blind ok:true)', () => {
    expect(ytSidecar).toContain('ytDlp');
    expect(ytSidecar).toContain('ffmpeg');
    expect(ytSidecar).toContain('/api/health');
  });

  it('exposes search (metadata-only) + download + audio bytes endpoints', () => {
    expect(ytSidecar).toContain('/api/youtube/search');
    expect(ytSidecar).toContain('/api/youtube/download');
    expect(ytSidecar).toContain('/api/youtube/audio');
  });

  it('binds loopback only and supports --port', () => {
    expect(ytSidecar).toContain('--port');
    expect(ytSidecar).toContain('127.0.0.1');
    expect(ytSidecar).not.toContain('0.0.0.0');
  });

  it('audioService uses the system yt-dlp binary (no missing npm wrapper)', () => {
    expect(audioSvc).not.toContain('yt-dlp-exec');
    expect(audioSvc).not.toMatch(/from\s+['"]\.\.\/utils\/errors\.js['"]/);
    expect(audioSvc).not.toMatch(/require\(['"]\.\.\/utils\/errors\.js['"]\)/);
    expect(audioSvc).toContain('execFile');
    expect(audioSvc).toContain('youtube:player_client=android');
  });

  it('audioService publishes atomically via .part then rename', () => {
    expect(audioSvc).toContain('.part');
    expect(audioSvc).toContain('renameSync');
  });
});

describe('native IPC error honesty (Android APK)', () => {
  // Tauri rejects failed commands with the Rust Err(String) as a PLAIN
  // STRING. The old `e instanceof Error ? e : generic` pattern silently
  // replaced every real cause (HTTP 403, playability reason, timeout) with
  // "YouTube download failed" — the APK showed the same content-free error
  // for every track. These pin the preservation.
  it('nativeErrorOf preserves Tauri string rejections verbatim', async () => {
    const { nativeErrorOf } = await import('../../src/providers/youtube/device');
    expect(nativeErrorOf('YouTube download failed (HTTP 403)', 'fallback').message)
      .toBe('YouTube download failed (HTTP 403)');
    expect(nativeErrorOf('YouTube download failed (Please sign in)', 'fallback').message)
      .toBe('YouTube download failed (Please sign in)');
  });

  it('nativeErrorOf passes Error instances through untouched', async () => {
    const { nativeErrorOf } = await import('../../src/providers/youtube/device');
    const e = new Error('keep me');
    expect(nativeErrorOf(e, 'fallback')).toBe(e);
  });

  it('nativeErrorOf falls back only for empty/non-string rejections', async () => {
    const { nativeErrorOf } = await import('../../src/providers/youtube/device');
    expect(nativeErrorOf('   ', 'fallback').message).toBe('fallback');
    expect(nativeErrorOf(undefined, 'fallback').message).toBe('fallback');
    expect(nativeErrorOf(null, 'fallback').message).toBe('fallback');
    expect(nativeErrorOf(0, 'fallback').message).toBe('fallback');
  });
});
