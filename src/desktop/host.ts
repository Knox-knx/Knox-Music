// Desktop host bridge — renderer side of the Tauri shell.
//
// The Tauri host owns: loopback port selection, per-launch session token,
// OS data directory, sidecar processes. The renderer learns all three
// through ONE IPC call (`knox_api_config`) — never via env files, never
// via hardcoded ports.
//
//   UI → host.getApiConfig() → { port, token, dataDir, version }
//
// The token is memory-only: never logged, never persisted, never sent to
// external providers. It expires when the app exits (host generates a fresh
// random token per launch).

import { isTauri } from './detector';

export interface KnoxApiConfig {
  port: number;
  /** Per-launch session token. Memory-only — never log, never persist. */
  token: string;
  /** OS-appropriate KNOX data dir (database/artwork/cache/offline/...). */
  dataDir: string;
  version: string;
}

export interface SidecarStatus {
  name: string;
  /** disabled | starting | health_check | ready | retry | start_failed | unavailable */
  state: string;
  port: number | null;
  lastError: string | null;
}

let cached: KnoxApiConfig | null = null;
let inFlight: Promise<KnoxApiConfig | null> | null = null;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Dynamic import keeps the browser/PWA bundle working without Tauri.
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/**
 * Renderer bootstrap: loopback port + per-launch token + data dir.
 * Returns null outside the desktop shell (browser/PWA) — callers fall back
 * to direct provider access. Never throws.
 */
export async function getApiConfig(force = false): Promise<KnoxApiConfig | null> {
  if (!isTauri()) return null;
  if (cached && !force) return cached;
  if (inFlight && !force) return inFlight;
  inFlight = (async () => {
    try {
      const cfg = await invoke<KnoxApiConfig>('knox_api_config');
      if (!cfg || typeof cfg.port !== 'number' || cfg.port <= 0 || !cfg.token) return null;
      cached = { port: cfg.port, token: cfg.token, dataDir: cfg.dataDir ?? '', version: cfg.version ?? '' };
      return cached;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Local API base URL (loopback only). Null outside the desktop shell. */
export async function getLocalApiBase(): Promise<string | null> {
  const cfg = await getApiConfig();
  return cfg ? `http://127.0.0.1:${cfg.port}` : null;
}

/** Sidecar status via IPC (desktop) — null in browser. Never throws. */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<SidecarStatus>('knox_sidecar_status');
  } catch {
    return null;
  }
}

/**
 * Reconcile the provider sidecar: enabled=true starts it (bounded
 * retries in the host), enabled=false stops it gracefully. The host owns
 * the process; the renderer only declares intent. Never throws — failure
 * surfaces as a status, never a crash.
 */
export async function ensureSidecar(enabled: boolean): Promise<SidecarStatus | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<SidecarStatus>('knox_sidecar_ensure', { enabled });
  } catch {
    return null;
  }
}

/** Reveal the OS KNOX data directory (Settings → Storage). No-op in browser. */
export async function openDataDir(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('knox_open_data_dir');
    return true;
  } catch {
    return false;
  }
}

/** For tests: clear the cached config. */
export function __resetHostCache(): void {
  cached = null;
  inFlight = null;
}

/** For tests: inject a fake config (simulates the desktop shell). */
export function __setHostCache(cfg: KnoxApiConfig | null): void {
  cached = cfg;
}
