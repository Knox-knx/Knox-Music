// KNOX Music audioService — YouTube search + download-first permanent audio.
// Reused by services/youtube/sidecar.js. No npm yt-dlp wrapper required:
// uses the system `yt-dlp` + `ffmpeg` binaries via execFile arg arrays
// (never a shell string, never user input interpolated into a command).
//
// Layout:
//   <stagingDir>/  random-base downloads (transient, .part while writing)
//   <permanentDir>/ youtube_<videoId>.mp3 (atomic rename target, survives
//                  restart; Smart Cache never touches this directory)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// --- Inline error taxonomy (previously ../utils/errors.js, which was never
// shipped — importing it crashed the sidecar on startup). Keep the same
// class names so existing error-mapping code keeps working. ---
export class BotError extends Error {
  constructor(message, opts = {}) {
    super(message || 'Audio service error.');
    this.name = 'BotError';
    this.kind = opts.kind;
    this.userFacing = opts.userFacing ?? false;
    if (opts.cause) this.cause = opts.cause;
  }
}
export class SearchError extends BotError {
  constructor(message, cause) {
    super(message || 'YouTube search failed.', { kind: 'search_failed', userFacing: false, cause });
    this.name = 'SearchError';
  }
}
export class TooLargeError extends BotError {
  constructor(message) {
    super(message || 'Audio exceeds the maximum file size limit.', { kind: 'too_large', userFacing: true });
    this.name = 'TooLargeError';
  }
}
export class FfmpegUnavailableError extends BotError {
  constructor(message) {
    super(message || 'FFmpeg is required for audio extraction.', { kind: 'ffmpeg_unavailable', userFacing: true });
    this.name = 'FfmpegUnavailableError';
  }
}
export class ConvertError extends BotError {
  constructor(message, cause) {
    super(message || 'YouTube download failed.', { kind: 'convert_failed', userFacing: false, cause });
    this.name = 'ConvertError';
  }
}

export function normalizeSearchResult(entry) {
  const title = String(entry.title ?? 'Unknown').trim() || 'Unknown';
  const duration = Number(entry.duration) || null;
  const id = String(entry.id || entry.display_id || '');
  return {
    id,
    title,
    channel: String(entry.channel || entry.uploader || entry.artist || 'Unknown').trim() || 'Unknown',
    duration,
    url: entry.webpage_url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
    live: Boolean(entry.live_status && entry.live_status !== 'is_upcoming' && entry.live_status !== 'not_live'),
    thumbnails: Array.isArray(entry.thumbnails)
      ? entry.thumbnails
          .filter((t) => t && t.url)
          .map((t) => ({ url: String(t.url), width: Number(t.width) || 0, height: Number(t.height) || 0 }))
          // Keep only the 2 smallest thumbnails (least bandwidth) — the
          // renderer picks the smallest for song images in the YouTube column.
          .sort((a, b) => (a.width * a.height) - (b.width * b.height))
          .slice(0, 2)
      : undefined,
  };
}

export function pickBestResult(results, maxDurationSeconds) {
  const candidates = (results || []).filter((r) => {
    if (!r || !r.id) return false;
    if (!Number.isFinite(r.duration) || r.duration <= 0) return false;
    if (r.duration > maxDurationSeconds) return false;
    if (r.live) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.live !== b.live) return a.live ? 1 : -1;
    return a.duration - b.duration;
  });
  return candidates[0];
}

const searchCache = new Map();
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
// Duplicate-search protection: concurrent identical searches (debounced
// keystrokes, retries, multi-pane fan-out) share ONE yt-dlp process.
// The entry is removed on settle; results still land in searchCache.
const searchInFlight = new Map();

const mixCache = new Map();
const mixInFlight = new Map();
const WEB_REMIX_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30';

function parseDurationTextToSeconds(txt) {
  if (!txt || typeof txt !== 'string') return null;
  const parts = txt.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs > 0 ? secs : null;
}

function textOfNode(node) {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) {
    return node.runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
  }
  return '';
}

function artistOfByline(node) {
  if (!node) return 'Unknown';
  if (Array.isArray(node.runs) && node.runs.length > 0) {
    const parts = [];
    for (const r of node.runs) {
      const t = r && typeof r.text === 'string' ? r.text.trim() : '';
      if (!t) continue;
      if (t === '•' || t === '·' || t === '-') break;
      parts.push(t);
    }
    const joined = parts.join(' ').trim();
    if (joined) return joined;
  }
  const simple = textOfNode(node).split('•')[0]?.trim();
  return simple || 'Unknown';
}

function collectMixRenderers(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectMixRenderers(item, out);
    return;
  }
  if (node.playlistPanelVideoRenderer && typeof node.playlistPanelVideoRenderer === 'object') {
    out.push(node.playlistPanelVideoRenderer);
  } else if (node.compactVideoRenderer && typeof node.compactVideoRenderer === 'object') {
    out.push(node.compactVideoRenderer);
  }
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') collectMixRenderers(val, out);
  }
}

async function fetchInnerTubeMix(videoId, limit = 50) {
  const seen = new Set([videoId]);
  const results = [];

  const endpoints = [
    {
      url: `https://music.youtube.com/youtubei/v1/next?key=${WEB_REMIX_KEY}&prettyPrint=false`,
      origin: 'https://music.youtube.com',
      body: {
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: '1.20240918.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
        videoId,
        playlistId: `RDAMVM${videoId}`,
        isAudioOnly: true,
      },
    },
    {
      url: 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
      origin: 'https://www.youtube.com',
      body: {
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240919.01.00',
            hl: 'en',
            gl: 'US',
          },
        },
        videoId,
        playlistId: `RD${videoId}`,
      },
    },
  ];

  for (const ep of endpoints) {
    if (results.length >= limit) break;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res;
      try {
        res = await fetch(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Origin: ep.origin,
            Referer: `${ep.origin}/`,
          },
          body: JSON.stringify(ep.body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const doc = await res.json();
      const renderers = [];
      collectMixRenderers(doc, renderers);
      for (const r of renderers) {
        if (results.length >= limit) break;
        const vid = typeof r.videoId === 'string' ? r.videoId.trim() : '';
        if (!isValidVideoId(vid) || seen.has(vid)) continue;
        const title = textOfNode(r.title).trim();
        if (!title) continue;
        const channel = artistOfByline(r.shortBylineText || r.longBylineText);
        const duration = parseDurationTextToSeconds(textOfNode(r.lengthText));
        const thumbnails = Array.isArray(r.thumbnail?.thumbnails) ? r.thumbnail.thumbnails : undefined;
        seen.add(vid);
        results.push(
          normalizeSearchResult({
            id: vid,
            title,
            channel,
            duration,
            webpage_url: `https://www.youtube.com/watch?v=${vid}`,
            thumbnails,
          }),
        );
      }
    } catch {
      /* try next endpoint */
    }
  }
  return results;
}

function toParsedJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function extractEntriesFromRaw(raw) {
  const parsed = toParsedJson(raw);
  if (!parsed) return [];
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.entries)
      ? parsed.entries
      : [];
  return entries.map(normalizeSearchResult).filter((r) => r.id);
}

function cacheSearch(cacheKey, results, now) {
  searchCache.set(cacheKey, { results, ts: now });
  if (searchCache.size > 200) {
    const firstKey = searchCache.keys().next().value;
    searchCache.delete(firstKey);
  }
}

function cacheMix(cacheKey, results, now) {
  mixCache.set(cacheKey, { results, ts: now });
  if (mixCache.size > 200) {
    const firstKey = mixCache.keys().next().value;
    mixCache.delete(firstKey);
  }
}

export function isValidVideoId(videoId) {
  return typeof videoId === 'string' && /^[A-Za-z0-9_-]{5,40}$/.test(videoId);
}

export function permanentFilename(videoId) {
  return `youtube_${videoId}.mp3`;
}

// Magic-byte container detection (mirrors the Rust host + mediaDiagnostics).
// Returns container label or null for HTML/JSON/unrecognized.
export function detectAudioContainerFromHead(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  if (buf.length < 4) return null;
  const ascii = (at, len) => buf.subarray(at, Math.min(buf.length, at + len)).toString('ascii');
  // Skip BOM/whitespace, then reject error pages masquerading as audio.
  let i = 0;
  while (i < Math.min(buf.length, 64) && (buf[i] <= 0x20 || buf[i] === 0xef || buf[i] === 0xbb || buf[i] === 0xbf)) i += 1;
  const rest = buf.subarray(i, Math.min(buf.length, i + 15)).toString('ascii').toLowerCase();
  if (rest.startsWith('<!doctype html') || rest.startsWith('<html') || rest.startsWith('<head')) return null;
  if (rest.startsWith('{"ok"') || rest.startsWith('{"success"') || rest.startsWith('{"error"')) return null;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3'; // ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // frame sync
  if (buf.length >= 8 && ascii(4, 4) === 'ftyp') return 'mp4-m4a';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'mp4-m4a'; // ADTS AAC
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  return 'unknown-audio';
}

export function validateAudioFileSync(filePath, { maxBytes } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: 'missing-file' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size <= 0) return { ok: false, reason: 'empty-file' };
  if (stat.size < 1024) return { ok: false, reason: 'truncated' };
  if (typeof maxBytes === 'number' && stat.size > maxBytes) return { ok: false, reason: 'too-large' };
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    head = Buffer.alloc(512);
    const n = fs.readSync(fd, head, 0, 512, 0);
    fs.closeSync(fd);
    head = head.subarray(0, n);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const container = detectAudioContainerFromHead(head);
  if (!container) return { ok: false, reason: 'not-audio' };
  return { ok: true, reason: 'ok', container, size: stat.size };
}

function resolvePermanentDir(config) {
  // Explicit override wins (tests / Tauri --data-dir / KNOX_DATA_DIR).
  if (config.dataDir && typeof config.dataDir === 'string' && config.dataDir.trim()) {
    return path.join(config.dataDir, 'offline', 'youtube');
  }
  const envDir = process.env.KNOX_DATA_DIR;
  if (envDir && typeof envDir === 'string' && envDir.trim()) {
    return path.join(envDir, 'offline', 'youtube');
  }
  // OS-appropriate app-data dir (survives reboot + Smart Cache clears).
  // Never the repo, never /tmp as the final home.
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'KNOX Music', 'offline', 'youtube');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'KNOX Music', 'offline', 'youtube');
  }
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdg, 'KNOX Music', 'offline', 'youtube');
}

// Well-known install locations (fallbacks only — PATH wins). Never the only
// source of truth: the terminal PATH and the Tauri/GNOME PATH often differ,
// so every layer below scans PATH first and logs the absolute path it chose.
const WELL_KNOWN_BIN_DIRS =
  process.platform === 'win32'
    ? []
    : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/opt/local/bin'];

function isExecutableFileSync(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPathSync(name) {
  const pathVar = process.env.PATH || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    if (isExecutableFileSync(cand)) return cand;
  }
  return null;
}

// Resolve one binary to an ABSOLUTE path: explicit env override → PATH
// scan → well-known dirs → bare name (spawn then fails honestly and health
// reports unavailable). The SAME resolved path is used by health checks and
// by every download, so health can never bless a binary downloads don't use.
export function resolveExecutable(name, envVar) {
  const override = process.env[envVar];
  if (override && typeof override === 'string' && override.trim()) {
    const abs = path.isAbsolute(override) ? override : path.resolve(override);
    if (isExecutableFileSync(abs)) return abs;
    // A stale override is worse than none: fall through to discovery but
    // keep the override visible in diagnostics (resolvedBinaries reports it).
  }
  const onPath = findOnPathSync(process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name);
  if (onPath) return onPath;
  for (const dir of WELL_KNOWN_BIN_DIRS) {
    const cand = path.join(dir, name);
    if (isExecutableFileSync(cand)) return cand;
  }
  return name;
}

export function resolvedBinaries() {
  return {
    ytDlp: resolveExecutable('yt-dlp', 'KNOX_YTDLP'),
    ffmpeg: resolveExecutable('ffmpeg', 'KNOX_FFMPEG'),
    node: process.execPath,
  };
}

async function runYtDlp(args, timeoutMs) {
  const bin = resolveExecutable('yt-dlp', 'KNOX_YTDLP');
  return execFileAsync(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
}

export function createAudioService({ config, logger }) {
  const stagingDir = path.join(config.tmpDir, 'staging');
  const downloadsDir = path.join(config.tmpDir, 'downloads');
  const convertedDir = path.join(config.tmpDir, 'converted');
  const permanentDir = resolvePermanentDir(config);

  let ffmpegChecked = false;
  let ffmpegAvailable = false;
  let ytDlpChecked = false;
  let ytDlpAvailable = false;
  let ytDlpVersion = null;

  async function checkYtDlp() {
    if (ytDlpChecked) return ytDlpAvailable;
    try {
      const { stdout } = await runYtDlp(['--version'], 10_000);
      ytDlpAvailable = true;
      ytDlpVersion = String(stdout || '').trim().slice(0, 64) || null;
    } catch {
      ytDlpAvailable = false;
    }
    ytDlpChecked = true;
    return ytDlpAvailable;
  }

  async function assertFfmpeg() {
    if (ffmpegChecked) {
      if (!ffmpegAvailable) throw new FfmpegUnavailableError();
      return true;
    }
    try {
      const bin = resolveExecutable('ffmpeg', 'KNOX_FFMPEG');
      await execFileAsync(bin, ['-version'], { timeout: 5_000 });
      ffmpegChecked = true;
      ffmpegAvailable = true;
      return true;
    } catch {
      ffmpegChecked = true;
      ffmpegAvailable = false;
      throw new FfmpegUnavailableError();
    }
  }

  async function checkDependencies() {
    const ytDlp = await checkYtDlp();
    let ffmpeg = ffmpegAvailable;
    if (!ffmpegChecked) {
      try {
        await assertFfmpeg();
        ffmpeg = true;
      } catch {
        ffmpeg = false;
      }
    }
    const bins = resolvedBinaries();
    return { ytDlp, ffmpeg, ytDlpVersion, ytDlpPath: bins.ytDlp, ffmpegPath: bins.ffmpeg };
  }

  function uniqueBase(prefix) {
    return `${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  }

  async function search(query, limit = config.searchResults) {
    const q = String(query ?? '').trim().slice(0, 400);
    if (!q) throw new SearchError('Missing search query.');
    const n = Math.max(1, Math.min(10, Number(limit) || config.searchResults));
    const cacheKey = `${q}:${n}`;
    const now = Date.now();
    const cached = searchCache.get(cacheKey);
    if (cached && now - cached.ts < SEARCH_CACHE_TTL) {
      return cached.results;
    }
    const shared = searchInFlight.get(cacheKey);
    if (shared) return shared;
    const job = runSearch(q, n, cacheKey, now).finally(() => {
      if (searchInFlight.get(cacheKey) === job) searchInFlight.delete(cacheKey);
    });
    searchInFlight.set(cacheKey, job);
    return job;
  }

  async function runSearch(q, n, cacheKey, now) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) throw new SearchError('yt-dlp executable not found.');
    const args = [
      `ytsearch${n}:${q}`,
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      // Flat metadata only (id/title/channel/duration/thumbnails) — a full
      // per-video extraction (webpage + formats) takes 10-20s EACH and always
      // exceeds the 60s search budget, surfacing as "No results found".
      '--flat-playlist',
      '--quiet',
      '--no-warnings',
      '--ignore-errors',
      '--socket-timeout', '30',
      '--sleep-interval', '1',
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Referer: https://www.youtube.com/',
    ];
    let raw;
    try {
      const { stdout } = await runYtDlp(args, Math.min(config.downloadTimeoutMs, 60_000));
      raw = stdout;
    } catch (err) {
      // yt-dlp may still print usable JSON on stdout even when exiting
      // non-zero (one entry errored). Salvage entries when possible.
      const salvaged = extractEntriesFromRaw(err?.stdout) ?? [];
      if (salvaged.length > 0) {
        logger?.warn({ query: q }, 'yt-dlp search exited non-zero; using partial results');
        cacheSearch(cacheKey, salvaged, now);
        return salvaged;
      }
      const msg = err?.killed ? 'YouTube search timed out.' : 'YouTube search failed.';
      throw new SearchError(msg, err);
    }
    const results = extractEntriesFromRaw(raw);
    cacheSearch(cacheKey, results, now);
    return results;
  }

  function permanentPathFor(videoId) {
    return path.join(permanentDir, permanentFilename(videoId));
  }

  function cleanupStaging(base) {
    for (const dir of [stagingDir, downloadsDir]) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${base}.`)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
          }
        }
      } catch { /* dir may not exist yet */ }
    }
  }

  async function downloadAndConvert(videoId, { onStage } = {}) {
    const id = String(videoId || '');
    if (!isValidVideoId(id)) {
      throw new ConvertError('Invalid video identifier.');
    }
    await assertFfmpeg();
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
      throw new ConvertError('yt-dlp executable not found.');
    }
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.mkdirSync(convertedDir, { recursive: true });
    fs.mkdirSync(permanentDir, { recursive: true });

    // Permanent-hit fast path: never re-run yt-dlp for a valid file.
    const finalPath = permanentPathFor(id);
    try {
      const verdict = validateAudioFileSync(finalPath, { maxBytes: config.maxAudioBytes });
      if (verdict.ok) {
        const size = fs.statSync(finalPath).size;
        logger?.info({ bytes: size, videoId: id }, 'youtube permanent hit (yt-dlp skipped)');
        return { filePath: finalPath, sizeBytes: size, videoId: id, cached: true };
      }
      if (fs.existsSync(finalPath)) {
        // Corrupt permanent file: delete + fall through to redownload once.
        try { fs.unlinkSync(finalPath); } catch { /* best effort */ }
        logger?.warn({ videoId: id }, 'removed corrupt permanent youtube file; redownloading once');
      }
    } catch { /* miss — download below */ }

    onStage?.('downloading');
    const base = uniqueBase(id);
    const outPattern = path.join(stagingDir, `${base}.%(ext)s`);
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
    // Bandwidth-saving extraction: smallest audio stream + 2nd-lowest MP3
    // quality (yt-dlp --audio-quality 0=best … 10=worst, so 9 = 2nd lowest).
    // Keeps files tiny for the download-first offline pipeline.
    const baseOptions = [
      videoUrl,
      '-f', 'worstaudio/worst',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '9',
      '--http-chunk-size', '10M',
      '--postprocessor-args', 'ffmpeg:-threads 0',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '-o', outPattern,
      '--retries', '3',
      '--sleep-interval', '1',
      '--concurrent-fragments', '4',
      '--no-continue',
      '--concat-playlist', 'never',
      '--socket-timeout', '30',
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Referer: https://www.youtube.com/',
    ];
    // YouTube frequently 403s the default (web) media hosts for server IPs.
    // Retry with the android player client, which serves from hosts that
    // accept plain downloads (verified: default 403 -> android OK).
    const attempts = [
      baseOptions,
      [...baseOptions, '--extractor-args', 'youtube:player_client=android'],
    ];

    let downloaded = false;
    let lastErr = null;
    for (const args of attempts) {
      try {
        await runYtDlp(args, Math.max(config.downloadTimeoutMs || 180_000, 300_000));
        downloaded = true;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        cleanupStaging(base);
        logger?.warn(
          { videoId: id, android: args.includes('youtube:player_client=android') },
          'audio download attempt failed; trying next player client',
        );
      }
    }
    if (!downloaded) {
      cleanupStaging(base);
      const msg = lastErr?.killed ? 'YouTube download timed out.' : undefined;
      throw new ConvertError(msg, lastErr);
    }

    try {
      onStage?.('converting');
      const produced = fs
        .readdirSync(stagingDir)
        .filter((f) => f.startsWith(`${base}.`))
        .map((f) => path.join(stagingDir, f));
      if (produced.length === 0) {
        throw new BotError('Download produced no output file.', {
          kind: 'download_produced_nothing',
          userFacing: false,
        });
      }
      const source = produced.find((p) => p.endsWith('.mp3')) ?? produced[0];
      onStage?.('validating');
      const verdict = validateAudioFileSync(source, { maxBytes: config.maxAudioBytes });
      if (!verdict.ok) {
        try { fs.unlinkSync(source); } catch { /* best effort */ }
        if (verdict.reason === 'too-large') throw new TooLargeError();
        throw new ConvertError(`Audio validation failed (${verdict.reason}).`);
      }
      const size = fs.statSync(source).size;
      // Atomic publish: .part in the FINAL directory, then rename.
      // Readers only ever see the complete file; crashes leave .part behind.
      const partPath = `${finalPath}.part`;
      try { fs.unlinkSync(partPath); } catch { /* no stale part */ }
      fs.copyFileSync(source, partPath);
      const partVerdict = validateAudioFileSync(partPath, { maxBytes: config.maxAudioBytes });
      if (!partVerdict.ok) {
        try { fs.unlinkSync(partPath); } catch { /* best effort */ }
        throw new ConvertError(`Audio validation failed (${partVerdict.reason}).`);
      }
      fs.renameSync(partPath, finalPath);
      // Best-effort staging cleanup (never touches the permanent file).
      cleanupStaging(base);
      try {
        for (const f of fs.readdirSync(downloadsDir)) {
          if (f.startsWith(`${base}.`)) fs.unlinkSync(path.join(downloadsDir, f));
        }
      } catch { /* best effort */ }
      onStage?.('ready');
      logger?.info({ bytes: size, videoId: id }, 'audio converted');
      return { filePath: finalPath, sizeBytes: size, videoId: id, cached: false };
    } catch (err) {
      cleanupStaging(base);
      try { fs.unlinkSync(`${finalPath}.part`); } catch { /* best effort */ }
      if (err instanceof TooLargeError) throw err;
      if (err instanceof BotError) throw err;
      throw new ConvertError(undefined, err);
    }
  }

  async function mix(videoId, limit = 50) {
    const id = String(videoId ?? '').trim();
    if (!isValidVideoId(id)) throw new SearchError('Invalid video identifier.');
    const n = Math.max(1, Math.min(60, Number(limit) || 50));
    const cacheKey = `mix:${id}:${n}`;
    const now = Date.now();
    const cached = mixCache.get(cacheKey);
    if (cached && now - cached.ts < SEARCH_CACHE_TTL) {
      return cached.results;
    }
    const shared = mixInFlight.get(cacheKey);
    if (shared) return shared;
    const job = runMix(id, n, cacheKey, now).finally(() => {
      if (mixInFlight.get(cacheKey) === job) mixInFlight.delete(cacheKey);
    });
    mixInFlight.set(cacheKey, job);
    return job;
  }

  async function runMix(id, n, cacheKey, now) {
    // 1. Fast path: InnerTube real-time Mix / Radio endpoint (<1s)
    try {
      const fastResults = await fetchInnerTubeMix(id, n);
      if (fastResults.length > 0) {
        cacheMix(cacheKey, fastResults, now);
        return fastResults;
      }
    } catch {
      /* fall through to yt-dlp mix */
    }

    // 2. Fallback: yt-dlp RD<id> mix playlist
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) return [];
    const args = [
      `https://www.youtube.com/watch?v=${id}&list=RD${id}`,
      '--dump-single-json',
      '--skip-download',
      '--flat-playlist',
      '--playlist-end', String(n),
      '--quiet',
      '--no-warnings',
      '--ignore-errors',
      '--socket-timeout', '20',
      '--add-header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--add-header', 'Referer: https://www.youtube.com/',
    ];
    try {
      const { stdout } = await runYtDlp(args, 30_000);
      const results = extractEntriesFromRaw(stdout).filter((r) => r.id && r.id !== id);
      if (results.length > 0) cacheMix(cacheKey, results, now);
      return results;
    } catch (err) {
      const salvaged = (extractEntriesFromRaw(err?.stdout) ?? []).filter((r) => r.id && r.id !== id);
      if (salvaged.length > 0) {
        cacheMix(cacheKey, salvaged, now);
        return salvaged;
      }
      return [];
    }
  }

  function removeFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      logger?.warn({ err }, 'Failed to remove temporary audio file');
    }
  }

  return {
    search,
    mix,
    pickBest: (results) => pickBestResult(results, config.maxAudioDurationSeconds),
    downloadAndConvert,
    removeFile,
    checkDependencies,
    permanentPathFor,
    validateAudioFileSync,
    dirs: { stagingDir, downloadsDir, convertedDir, permanentDir },
  };
}
