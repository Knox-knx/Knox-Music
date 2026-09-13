// KNOX Music dev launcher: Vite + the YouTube Music sidecar together.
//
// `npm run dev:all` starts the loopback sidecar, waits for its health
// endpoint, then starts Vite — one command, no manual sidecar step.
// Ctrl+C stops both. `npm run dev` (Vite only) still works for UI-only runs.
//
// Env:
//   YOUTUBEMUSIC_PORT (default 5000) — must match VITE_YOUTUBEMUSIC_API_BASE_URL
//   KNOX_NO_SIDECAR=1 — skip the sidecar, Vite only

import { spawn } from 'node:child_process';

const NO_SIDECAR = process.env.KNOX_NO_SIDECAR === '1';
const PORT = Number(process.env.YOUTUBEMUSIC_PORT || process.env.PORT || '5000') || 5000;

let sidecar = null;
let vite = null;
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    vite?.kill('SIGTERM');
  } catch {
    /* already exited */
  }
  try {
    sidecar?.kill('SIGTERM');
  } catch {
    /* already exited */
  }
  setTimeout(() => {
    try {
      vite?.kill('SIGKILL');
    } catch {
      /* noop */
    }
    try {
      sidecar?.kill('SIGKILL');
    } catch {
      /* noop */
    }
    process.exit(code);
  }, 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function waitForHealth(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

if (!NO_SIDECAR) {
  sidecar = spawn('python3', ['services/youtubemusic/app.py', '--port', String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  sidecar.on('error', (err) => {
    console.error(`[dev] sidecar failed to start: ${err.message} — continuing with Vite only`);
    sidecar = null;
  });
  sidecar.on('exit', (code) => {
    if (!stopping) console.error(`[dev] sidecar exited (code ${code}) — Vite keeps running; restart it manually if needed`);
  });
  const ready = await waitForHealth();
  if (ready) {
    console.log(`[dev] youtube-music sidecar healthy on 127.0.0.1:${PORT}`);
  } else {
    console.error(`[dev] sidecar not healthy after 12s — continuing with Vite only (search will degrade honestly)`);
  }
} else {
  console.log('[dev] KNOX_NO_SIDECAR=1 — Vite only');
}

vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit' });
vite.on('error', (err) => {
  console.error(`[dev] vite failed to start: ${err.message}`);
  stop(1);
});
vite.on('exit', (code) => stop(code ?? 0));
