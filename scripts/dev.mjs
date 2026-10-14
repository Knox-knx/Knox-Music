// KNOX Music dev launcher: Vite + both sidecars together.
//
// `npm run dev:all` starts the loopback sidecars, waits for their health
// endpoints, then starts Vite — one command, no manual sidecar step.
// Ctrl+C stops all. `npm run dev` (Vite only) still works for UI-only runs.
//
// Env:
//   YOUTUBEMUSIC_PORT (default 5000) — must match VITE_YOUTUBEMUSIC_API_BASE_URL
//   YOUTUBE_AUDIO_PORT (default 5001) — youtube-audio sidecar (yt-dlp/FFmpeg)
//   KNOX_NO_SIDECAR=1 — skip sidecars, Vite only

import { spawn } from 'node:child_process';

const NO_SIDECAR = process.env.KNOX_NO_SIDECAR === '1';
const PORT = Number(process.env.YOUTUBEMUSIC_PORT || process.env.PORT || '5000') || 5000;
const YT_PORT = Number(process.env.YOUTUBE_AUDIO_PORT || '5001') || 5001;

let ytmSidecar = null;
let ytSidecar = null;
let vite = null;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of [vite, ytmSidecar, ytSidecar]) {
    try {
      p?.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }
  setTimeout(() => {
    for (const p of [vite, ytmSidecar, ytSidecar]) {
      try {
        p?.kill('SIGKILL');
      } catch {
        /* noop */
      }
    }
    process.exit(code);
  }, 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function waitForHealth(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      // youtube-audio reports 503 when yt-dlp/ffmpeg are missing — still
      // "up" (honest degradation), so accept any HTTP response here but
      // return the parsed body so the caller can log dependency truth.
      if (res.ok || res.status === 503) {
        try {
          return { up: true, body: await res.json() };
        } catch {
          return { up: true, body: null };
        }
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { up: false, body: null };
}

if (!NO_SIDECAR) {
  ytmSidecar = spawn('python3', ['services/youtubemusic/app.py', '--port', String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  ytmSidecar.on('error', (err) => {
    console.error(`[dev] youtubemusic sidecar failed to start: ${err.message} — continuing without it`);
    ytmSidecar = null;
  });
  ytmSidecar.on('exit', (code) => {
    if (!stopping) console.error(`[dev] youtubemusic sidecar exited (code ${code}) — Vite keeps running; restart it manually if needed`);
  });

  console.log(`[youtube-audio] starting node services/youtube/sidecar.js --port ${YT_PORT}`);
  let ytSidecarExited = null;
  ytSidecar = spawn('node', ['services/youtube/sidecar.js', '--port', String(YT_PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  ytSidecar.on('error', (err) => {
    console.error(`[dev] youtube-audio sidecar failed to start: ${err.message} — continuing without it`);
    if (ytSidecarExited === null) ytSidecarExited = err.message;
    ytSidecar = null;
  });
  ytSidecar.on('exit', (code) => {
    if (ytSidecarExited === null) ytSidecarExited = `exit code ${code}`;
    if (!stopping) console.error(`[dev] youtube-audio sidecar exited (code ${code}) — Vite keeps running; restart it manually if needed`);
  });

  const [ytmReady, ytReady] = await Promise.all([waitForHealth(PORT), waitForHealth(YT_PORT)]);
  if (ytmReady.up) {
    console.log(`[dev] youtube-music sidecar healthy on 127.0.0.1:${PORT}`);
  } else {
    console.error(`[dev] youtubemusic sidecar not healthy after 12s — continuing (search will degrade honestly)`);
  }
  if (ytReady.up) {
    const b = ytReady.body ?? {};
    const ytDlp = b.ytDlp === true ? `OK${b.ytDlpPath ? ` (${b.ytDlpPath})` : ''}` : 'MISSING';
    const ff = b.ffmpeg === true ? `OK${b.ffmpegPath ? ` (${b.ffmpegPath})` : ''}` : 'MISSING';
    if (ytSidecarExited !== null) {
      // Our own sidecar died (often EADDRINUSE from a stale process), yet
      // something still answers on the port. Never attribute a stale
      // process's health to our launch — say so explicitly.
      console.error(`[dev] youtube-audio sidecar process failed (${ytSidecarExited}) — something ELSE is answering on 127.0.0.1:${YT_PORT} (stale sidecar?). Stop it (fuser -k ${YT_PORT}/tcp) and restart, or verify it is the current services/youtube/sidecar.js before trusting these results:`);
    }
    console.log(`[dev] youtube-audio sidecar listening on 127.0.0.1:${YT_PORT}`);
    console.log(`[dev] youtube-audio health ${b.ok === true ? 'OK' : 'DEGRADED'} — yt-dlp ${ytDlp}, ffmpeg ${ff}`);
    if (b.ok !== true) {
      console.error(`[dev] youtube-audio degraded (${b.error ?? 'dependency missing'}) — the YouTube provider will report unavailable with this cause`);
    }
  } else {
    console.error(`[dev] youtube-audio sidecar not healthy after 12s — YouTube playback will report unavailable honestly`);
  }
} else {
  console.log('[dev] KNOX_NO_SIDECAR=1 — Vite only');
}

vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host'], { stdio: 'inherit' });
vite.on('error', (err) => {
  console.error(`[dev] vite failed to start: ${err.message}`);
  stop(1);
});
vite.on('exit', (code) => stop(code ?? 0));
