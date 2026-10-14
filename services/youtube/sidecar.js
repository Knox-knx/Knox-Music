// YouTube Audio Sidecar — wraps services/audioService.js for KNOX Music.
// Stdlib-only (node:http, no express) so packaged desktop builds run it with
// the system node and zero npm install. Loopback only (127.0.0.1).
//
// Run: node services/youtube/sidecar.js --port <port> [--tmp-dir <dir>] [--data-dir <dir>]
//
// Endpoints:
//   GET  /api/health (+ /health alias) — {ok, service, ytDlp, ffmpeg}
//   GET  /api/youtube/search?q=<query>&limit=<n> — metadata only, no download
//   POST /api/youtube/download {videoId} — atomic permanent MP3 on disk
//   GET  /api/youtube/audio?videoId=<id> — serve the permanent MP3 bytes
//   POST /api/youtube/cleanup {videoId} — staging-only cleanup (never permanent)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAudioService, resolvedBinaries } from '../audioService.js';

// Absolute module locations (resolved from THIS file, never process.cwd() —
// §11: the sidecar must find ../audioService.js after packaging too).
const SIDECAR_PATH = fileURLToPath(import.meta.url);
const AUDIOSERVICE_PATH = fileURLToPath(new URL('../audioService.js', import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    port: 5001,
    tmpDir: path.join(os.tmpdir(), 'knox-music', 'youtube'),
    dataDir: process.env.KNOX_DATA_DIR || null,
    maxAudioDurationSeconds: 14400,
    maxAudioBytes: 250 * 1024 * 1024,
    downloadTimeoutMs: 300000,
    searchResults: 25,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--port') config.port = parseInt(args[++i], 10);
    else if (a === '--tmp-dir') config.tmpDir = args[++i];
    else if (a === '--data-dir') config.dataDir = args[++i];
    else if (a === '--max-duration') config.maxAudioDurationSeconds = parseInt(args[++i], 10);
    else if (a === '--max-bytes') config.maxAudioBytes = parseInt(args[++i], 10);
    else if (a === '--timeout') config.downloadTimeoutMs = parseInt(args[++i], 10);
    else if (a === '--search-results') config.searchResults = parseInt(args[++i], 10);
  }
  if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) config.port = 5001;
  return config;
}

const config = parseArgs();

const logger = {
  info: (meta, msg) => console.log(`[INFO] ${msg}`, meta || ''),
  warn: (meta, msg) => console.warn(`[WARN] ${msg}`, meta || ''),
  error: (meta, msg) => console.error(`[ERROR] ${msg}`, meta || ''),
  debug: (meta, msg) => console.debug(`[DEBUG] ${msg}`, meta || ''),
};

const audioService = createAudioService({ config, logger });

// Duplicate-download protection: concurrent POSTs for the same video share
// one yt-dlp run. All callers receive the same final result.
const inFlight = new Map();

function isValidVideoId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{5,40}$/.test(v);
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (c) => {
      received += c.length;
      if (received > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

async function handleHealth(_req, res, origin) {
  try {
    const deps = await audioService.checkDependencies();
    const ok = deps.ytDlp === true && deps.ffmpeg === true;
    const bins = resolvedBinaries();
    const body = {
      ok,
      service: 'youtube-audio',
      version: '1.0.0',
      ytDlp: deps.ytDlp,
      ffmpeg: deps.ffmpeg,
      ytDlpPath: deps.ytDlpPath || bins.ytDlp,
      ffmpegPath: deps.ffmpegPath || bins.ffmpeg,
    };
    if (deps.ytDlpVersion) body.ytDlpVersion = deps.ytDlpVersion;
    if (!ok) {
      const missing = [];
      if (!deps.ytDlp) missing.push('yt-dlp executable not found');
      if (!deps.ffmpeg) missing.push('FFmpeg executable not found');
      body.error = missing.join('; ');
      return sendJson(res, 503, body, origin);
    }
    return sendJson(res, 200, body, origin);
  } catch (err) {
    return sendJson(res, 503, {
      ok: false, service: 'youtube-audio', ytDlp: false, ffmpeg: false,
      error: err instanceof Error ? err.message.slice(0, 200) : 'health check failed',
    }, origin);
  }
}

async function handleSearch(req, res, origin, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : config.searchResults;
  if (!q) return sendJson(res, 400, { error: 'Missing or invalid query parameter "q"' }, origin);
  if (q.length > 400) return sendJson(res, 400, { error: 'Query too long (max 400 chars)' }, origin);
  try {
    const results = await audioService.search(q, limit);
    return sendJson(res, 200, results, origin);
  } catch (err) {
    logger.error({ err: String(err).slice(0, 300) }, 'Search failed');
    const msg = err instanceof Error ? err.message : 'Search failed';
    const code = /yt-dlp executable not found/i.test(msg) ? 503 : 500;
    if (code === 503) return sendJson(res, 503, { error: 'yt-dlp executable not found' }, origin);
    return sendJson(res, 500, { error: msg.slice(0, 300) }, origin);
  }
}

async function handleMix(_req, res, origin, url) {
  const videoId = (url.searchParams.get('videoId') || '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(60, limitRaw)) : 50;
  if (!isValidVideoId(videoId)) {
    return sendJson(res, 400, { error: 'Missing or invalid videoId' }, origin);
  }
  try {
    const results = await audioService.mix(videoId, limit);
    return sendJson(res, 200, results, origin);
  } catch (err) {
    logger.error({ err: String(err).slice(0, 300), videoId }, 'Mix fetch failed');
    return sendJson(res, 200, [], origin);
  }
}

function downloadOnce(videoId) {
  const existing = inFlight.get(videoId);
  if (existing) return existing;
  const p = audioService.downloadAndConvert(videoId, {
    onStage: (stage) => logger.info({ videoId, stage }, 'download stage'),
  }).finally(() => {
    if (inFlight.get(videoId) === p) inFlight.delete(videoId);
  });
  inFlight.set(videoId, p);
  return p;
}

async function handleDownload(req, res, origin) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { success: false, errorCode: 'BAD_REQUEST', message: 'Invalid JSON body' }, origin);
  }
  const videoId = body?.videoId;
  if (!videoId || typeof videoId !== 'string') {
    return sendJson(res, 400, { success: false, errorCode: 'BAD_REQUEST', message: 'Missing or invalid videoId' }, origin);
  }
  if (!isValidVideoId(videoId)) {
    return sendJson(res, 400, { success: false, errorCode: 'INVALID_ID', message: 'Invalid video identifier format' }, origin);
  }
  try {
    const result = await downloadOnce(videoId);
    return sendJson(res, 200, {
      success: true,
      videoId,
      filePath: result.filePath,
      sizeBytes: result.sizeBytes,
      format: 'mp3',
      cached: result.cached === true,
    }, origin);
  } catch (err) {
    logger.error({ err: String(err).slice(0, 500), videoId }, 'Download failed');
    const msg = err instanceof Error ? err.message : 'Download failed';
    let errorCode = 'DOWNLOAD_FAILED';
    let message = msg.slice(0, 300);
    let status = 500;
    if (err && (err.name === 'TooLargeError' || /too large/i.test(msg))) {
      errorCode = 'TOO_LARGE';
      message = 'Video exceeds maximum file size limit';
    } else if (err && (err.name === 'FfmpegUnavailableError' || /ffmpeg/i.test(msg))) {
      errorCode = 'FFMPEG_UNAVAILABLE';
      message = 'FFmpeg is required for audio extraction';
      status = 503;
    } else if (err && (err.name === 'ConvertError' && /invalid video identifier/i.test(msg))) {
      errorCode = 'INVALID_ID';
      message = 'Invalid video identifier';
      status = 400;
    } else if (/yt-dlp executable not found/i.test(msg)) {
      errorCode = 'YTDLP_UNAVAILABLE';
      message = 'yt-dlp executable not found';
      status = 503;
    } else if (/timed out/i.test(msg)) {
      errorCode = 'TIMEOUT';
      message = 'YouTube download timed out';
      status = 504;
    } else if (/validation failed|not-audio|empty-file|truncated/i.test(msg)) {
      errorCode = 'VALIDATION_FAILED';
      message = 'Audio validation failed';
    }
    return sendJson(res, status, { success: false, videoId, errorCode, message }, origin);
  }
}

async function handleAudio(_req, res, origin, url) {
  const videoId = (url.searchParams.get('videoId') || '').trim();
  if (!isValidVideoId(videoId)) {
    res.writeHead(400, { 'access-control-allow-origin': origin || '*', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid videoId' }));
    return;
  }
  const filePath = audioService.permanentPathFor(videoId);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404, { 'access-control-allow-origin': origin || '*', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Audio not downloaded yet' }));
    return;
  }
  if (!stat.isFile() || stat.size <= 0) {
    res.writeHead(422, { 'access-control-allow-origin': origin || '*', 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Stored audio is invalid' }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'access-control-allow-origin': origin || '*',
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleCleanup(req, res, origin) {
  // Staging-only: never deletes permanent youtube_<id>.mp3 files.
  try {
    const body = await readJsonBody(req).catch(() => ({}));
    const videoId = body?.videoId;
    if (videoId && isValidVideoId(videoId)) {
      const staging = audioService.dirs.stagingDir;
      try {
        for (const f of fs.readdirSync(staging)) {
          if (f.startsWith(`${videoId}.`)) {
            try { fs.unlinkSync(path.join(staging, f)); } catch { /* best effort */ }
          }
        }
      } catch { /* nothing staged */ }
    }
    return sendJson(res, 200, { ok: true }, origin);
  } catch (err) {
    logger.error({ err: String(err).slice(0, 200) }, 'Cleanup failed');
    return sendJson(res, 500, { error: 'Cleanup failed' }, origin);
  }
}

async function handleJioSaavnSearch(_req, res, origin, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : config.searchResults;
  if (!q) return sendJson(res, 400, { error: 'Missing query parameter "q"' }, origin);
  try {
    const apiUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&p=1&q=${encodeURIComponent(q)}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}`;
    const upstream = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (upstream.ok) {
      const data = await upstream.json();
      return sendJson(res, 200, data, origin);
    }
    return sendJson(res, upstream.status, { error: `JioSaavn upstream HTTP ${upstream.status}` }, origin);
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message.slice(0, 200) : 'JioSaavn search failed' }, origin);
  }
}

async function handleJioSaavnTrack(_req, res, origin, url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return sendJson(res, 400, { error: 'Missing parameter "id"' }, origin);
  try {
    const apiUrl = `https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids=${encodeURIComponent(id)}`;
    const upstream = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (upstream.ok) {
      const data = await upstream.json();
      return sendJson(res, 200, data, origin);
    }
    return sendJson(res, upstream.status, { error: `JioSaavn track upstream HTTP ${upstream.status}` }, origin);
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message.slice(0, 200) : 'JioSaavn track lookup failed' }, origin);
  }
}

async function handleJioSaavnProxy(_req, res, origin, url) {
  const rawUrl = (url.searchParams.get('url') || '').trim();
  if (!rawUrl || !/^https?:\/\/([a-z0-9-]+\.)?saavncdn\.com\//i.test(rawUrl)) {
    return sendJson(res, 400, { error: 'Invalid or unsupported JioSaavn media URL' }, origin);
  }
  const candidates = [rawUrl];
  for (const br of ['96', '160', '320', '48']) {
    const replaced = rawUrl
      .replace('//preview.saavncdn.com/', '//aac.saavncdn.com/')
      .replace('//h.saavncdn.com/', '//aac.saavncdn.com/')
      .replace(/_96_p\.mp4(\?.*)?$/i, `_${br}.mp4`)
      .replace(/_(48|96|160|320)\.mp4(\?.*)?$/i, `_${br}.mp4`);
    if (!candidates.includes(replaced)) candidates.push(replaced);
  }
  for (const cand of candidates) {
    try {
      const upstream = await fetch(cand, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(180000),
      });
      if (!upstream.ok) continue;
      const ab = await upstream.arrayBuffer();
      if (ab.byteLength < 1024) continue;
      const buf = Buffer.from(ab);
      const ct = (upstream.headers.get('content-type') || 'audio/mp4').split(';')[0].trim() || 'audio/mp4';
      res.writeHead(200, {
        'content-type': ct,
        'content-length': buf.length,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'access-control-allow-origin': origin || '*',
      });
      res.end(buf);
      return;
    } catch {
      /* try next bitrate candidate */
    }
  }
  return sendJson(res, 502, { error: 'JioSaavn media stream unavailable' }, origin);
}

async function handleSpotifySearch(_req, res, origin, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : config.searchResults;
  if (!q) return sendJson(res, 400, { error: 'Missing query parameter "q"' }, origin);
  try {
    const results = await audioService.search(q, limit);
    const items = (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.channel || 'Unknown Artist',
      durationSec: r.duration || 0,
      durationMs: (r.duration || 0) * 1000,
      artworkUrl: (Array.isArray(r.thumbnails) && r.thumbnails[0]?.url) || r.thumbnail || undefined,
      sourceUrl: `https://open.spotify.com/search/${encodeURIComponent(`${r.title} ${r.channel || ''}`.trim())}`,
    }));
    return sendJson(res, 200, { results: items }, origin);
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message.slice(0, 200) : 'Spotify search failed' }, origin);
  }
}

async function handleYouTubeMusicSearch(_req, res, origin, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const limitRaw = parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(25, limitRaw)) : config.searchResults;
  if (!q) return sendJson(res, 400, { error: 'Missing query parameter "q"' }, origin);
  try {
    const results = await audioService.search(q, limit);
    return sendJson(res, 200, results, origin);
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message.slice(0, 200) : 'YouTube Music search failed' }, origin);
  }
}

const server = http.createServer(async (req, res) => {  const origin = req.headers.origin || '*';
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
        'content-length': '0',
      });
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
      await handleHealth(req, res, origin);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/youtube/search') {
      await handleSearch(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/youtube/mix') {
      await handleMix(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/youtube/download') {
      await handleDownload(req, res, origin);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/youtube/audio') {
      await handleAudio(req, res, origin, url);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/youtube/cleanup') {
      await handleCleanup(req, res, origin);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/jiosaavn/search') {
      await handleJioSaavnSearch(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/jiosaavn/track') {
      await handleJioSaavnTrack(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/jiosaavn/proxy') {
      await handleJioSaavnProxy(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/spotify/search') {
      await handleSpotifySearch(req, res, origin, url);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/youtube-music/search') {
      await handleYouTubeMusicSearch(req, res, origin, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' }, origin);
      return;
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } }, origin);
  } catch (err) {
    logger.error({ err: String(err).slice(0, 300) }, 'request failed');
    try {
      sendJson(res, 500, { error: 'Internal error' }, origin);
    } catch { /* socket gone */ }
  }
});

// Bound slow clients: downloads/probes can never hold a socket forever.
server.requestTimeout = 320_000;
server.headersTimeout = 30_000;

server.listen(config.port, '127.0.0.1', () => {
  logger.info({ port: config.port, tmpDir: config.tmpDir, permanentDir: audioService.dirs.permanentDir }, 'YouTube Audio Sidecar started');
  // Live-runtime diagnostics (§5): every path absolute, so `npm run dev:all`
  // output proves WHICH node/yt-dlp/ffmpeg/sidecar/audioService/data-dir/port
  // the running process actually uses (never assumed from a terminal PATH).
  void (async () => {
    try {
      const deps = await audioService.checkDependencies();
      const bins = resolvedBinaries();
      console.log(`[youtube-audio] sidecar: ${SIDECAR_PATH}`);
      console.log(`[youtube-audio] audioService: ${AUDIOSERVICE_PATH}`);
      console.log(`[youtube-audio] node: ${process.execPath} (${process.version})`);
      console.log(`[youtube-audio] yt-dlp: ${deps.ytDlpPath || bins.ytDlp}${deps.ytDlpVersion ? ` (${deps.ytDlpVersion})` : ''}`);
      console.log(`[youtube-audio] ffmpeg: ${deps.ffmpegPath || bins.ffmpeg}`);
      console.log(`[youtube-audio] data directory: ${audioService.dirs.permanentDir}`);
      console.log(`[youtube-audio] listening on 127.0.0.1:${config.port}`);
      console.log(`[youtube-audio] health ${deps.ytDlp && deps.ffmpeg ? 'OK' : 'DEGRADED'} (ytDlp=${deps.ytDlp} ffmpeg=${deps.ffmpeg})`);
      if (!deps.ytDlp || !deps.ffmpeg) {
        console.error('[youtube-audio] WARNING: a dependency is missing — the YouTube provider will report unavailable with this cause');
      }
    } catch (err) {
      console.error(`[youtube-audio] dependency probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
});

function shutdown() {
  logger.info({}, 'Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
