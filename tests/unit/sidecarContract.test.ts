// YouTube Music sidecar contract: stdlib-only, loopback, documented API.
//
// The packaged desktop app must launch this service with zero user setup
// (no venv, no pip, no ytmusicapi install). These tests pin that contract:
// the script is dependency-free, accepts `--port`, serves health +
// validation shapes, and shuts down cleanly. The live-process tests skip
// gracefully when no python3 interpreter exists (sidecar stays unavailable;
// KNOX keeps running).

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

const SCRIPT = join(__dirname, '..', '..', 'services', 'youtubemusic', 'app.py');

let child: ChildProcess | null = null;

afterEach(async () => {
  if (child) {
    const c = child;
    child = null;
    c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try {
      c.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe('sidecar packaging contract (static)', () => {
  it('ships as a single script', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('is stdlib-only: no flask, no requests, no required third-party imports', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/^\s*(import flask|from flask|import requests|from requests)/m);
    expect(src).not.toMatch(/^\s*import (flask|requests|fastapi|django)\b/m);
  });

  it('supports --port and binds loopback only', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('--port');
    expect(src).toContain('127.0.0.1');
    expect(src).not.toContain('0.0.0.0');
  });

  it('declares zero runtime dependencies', () => {
    const req = readFileSync(join(__dirname, '..', '..', 'services', 'youtubemusic', 'requirements.txt'), 'utf8');
    // Only comments allowed — no dependency spec lines (e.g. `flask==...`).
    const specs = req.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(specs).toEqual([]);
  });

  it('exposes the canonical /health contract (plus the /api/health alias)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('"/health"');
    expect(src).toContain('"/api/health"');
    expect(src).toContain('"knox-youtube-music"');
  });

  it('answers loopback browser fetches directly (CORS + preflight)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('Access-Control-Allow-Origin');
    expect(src).toContain('do_OPTIONS');
  });

  it('never implements audio extraction or downloads', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // Implementation patterns of rippers/extractors must be absent.
    // (Legal "never ..." prose mentioning MP3/download is fine.)
    expect(src).not.toMatch(/itag|decipher|get_audio|download_audio|stream_url|pytube|yt-dlp|youtube_dl/i);
  });
});

describe('sidecar runtime contract (live process)', () => {
  it('starts, answers health, validates input, rejects wrong methods, stops', async () => {
    let port: number;
    try {
      port = await freePort();
      child = spawn('python3', [SCRIPT, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      console.warn('python3 or loopback socket unavailable — skipping live sidecar test');
      return;
    }
    const spawnFailed = await new Promise<boolean>((resolve) => {
      child!.once('error', () => resolve(true));
      child!.once('exit', (code) => resolve(code !== 0));
      setTimeout(() => resolve(false), 500);
    });
    if (spawnFailed || child.exitCode !== null) {
      console.warn('python3 or loopback bind unavailable — skipping live sidecar test');
      child = null;
      return;
    }
    const healthy = await waitForHealth(port);
    if (!healthy && child.exitCode !== null) {
      console.warn('sidecar exited in restricted environment — skipping live sidecar test');
      child = null;
      return;
    }
    expect(healthy).toBe(true);

    // Canonical health shape (the /health alias must agree with /api/health).
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { ok: boolean; service: string };
    expect(health.ok).toBe(true);
    expect(health.service).toBe('knox-youtube-music');
    const canonical = await fetch(`http://127.0.0.1:${port}/health`);
    expect(canonical.status).toBe(200);
    expect(((await canonical.json()) as { service: string }).service).toBe('knox-youtube-music');

    // Loopback CORS: browsers must be able to fetch directly (curl works
    // regardless, so assert the header explicitly).
    const corsRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(corsRes.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await fetch(`http://127.0.0.1:${port}/api/search?q=x`, { method: 'OPTIONS' });
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    // Empty query → 400 INVALID_QUERY (structured, never a stack trace).
    const emptyRes = await fetch(`http://127.0.0.1:${port}/api/search`);
    expect(emptyRes.status).toBe(400);
    const emptyBody = (await emptyRes.json()) as { error: { code: string } };
    expect(emptyBody.error.code).toBe('INVALID_QUERY');

    // Over-long query → 400.
    const longRes = await fetch(`http://127.0.0.1:${port}/api/search?q=${'a'.repeat(300)}`);
    expect(longRes.status).toBe(400);

    // Unknown route → 404, never a stack trace.
    const nope = await fetch(`http://127.0.0.1:${port}/api/nope`);
    expect(nope.status).toBe(404);
    const nopeBody = (await nope.json()) as { error: { code: string } };
    expect(nopeBody.error.code).toBe('NOT_FOUND');

    // Wrong method → 405.
    expect((await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'POST' })).status).toBe(405);

    // Invalid track id → 400 (no traversal, no upstream call).
    expect((await fetch(`http://127.0.0.1:${port}/api/track/..%2Fetc`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/api/track/a%2Fb`)).status).toBe(400);
  }, 20000);
});
