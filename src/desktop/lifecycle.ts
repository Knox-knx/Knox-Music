// Desktop lifecycle — deterministic startup/shutdown (§18/§19).
//
// Startup:
//   1. launch shell → 2. data dir/config (host) → 3. connect local API →
//   4. init KNOX Core (storage recovery, settings, providers, seed) →
//   5. ensure sidecars per settings → 6. provider health → 7. UI ready.
//
// The HOST owns steps 1–3 (Rust, before the renderer loads). This module
// owns the renderer half: wait for the host, run Core init, reconcile
// sidecars, and report boot phases for the splash screen.
//
// Shutdown is idempotent: stop downloads → save state (automatic via
// stores) → stop sidecars → exit. Calling shutdown twice never crashes.

import { isTauri } from './detector';
import { getApiConfig, ensureSidecar, getSidecarStatus, type SidecarStatus } from './host';
import { fetchHealth } from './localApi';
import { logger } from '../core/logger';

export type BootPhase =
  | 'host'
  | 'api'
  | 'core'
  | 'sidecars'
  | 'ready'
  | 'degraded';

export interface BootResult {
  phase: BootPhase;
  /** Local API reachable. */
  apiOk: boolean;
  /** YouTube Music sidecar status (null in browser or when disabled). */
  sidecar: SidecarStatus | null;
  /** Non-fatal notes for the splash screen / logs. */
  notes: string[];
  durationMs: number;
}

export type BootListener = (phase: BootPhase) => void;

const listeners = new Set<BootListener>();
let currentPhase: BootPhase = 'host';
let shutDown = false;

export function onBootPhase(fn: BootListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(phase: BootPhase): void {
  currentPhase = phase;
  for (const fn of listeners) {
    try {
      fn(phase);
    } catch {
      /* listener errors never break boot */
    }
  }
}

/**
 * Structured lifecycle log line. Renders as `[knox:KNOX] <message>` — the
 * canonical boot/shutdown trail (boot → storage → core → local API →
 * sidecars → providers → ready, plus crash/restart/shutdown events).
 */
function knoxLog(message: string): void {
  logger.info('KNOX', message);
}

export function bootPhase(): BootPhase {
  return currentPhase;
}

export interface BootOptions {
  /** Skip the network health probe (tests / offline-first boot). */
  skipHealthProbe?: boolean;
  /** Override: treat YouTube Music as enabled regardless of settings. */
  youtubemusicEnabled?: boolean;
  /** Deprecated alias for youtubemusicEnabled (removed JioSaavn compat). */
  jiosaavnEnabled?: boolean;
}

/**
 * Renderer boot: connect host → init Core → reconcile sidecars.
 * Never throws — worst case resolves `degraded` with notes, and the UI
 * still renders over the local library. Sidecar/provider failures are
 * isolated; KNOX keeps running.
 */
export async function bootDesktop(opts: BootOptions = {}): Promise<BootResult> {
  const started = Date.now();
  const notes: string[] = [];
  knoxLog('boot');
  emit('host');

  // 1–2. Host config (port/token/data dir). Null in browser — fine.
  const cfg = await getApiConfig().catch(() => null);
  if (!cfg && isTauri()) notes.push('desktop host unreachable; continuing local-only');

  // 3. Local API probe (open /api/health; bounded, never blocks boot long).
  emit('api');
  let apiOk = false;
  if (cfg && !opts.skipHealthProbe) {
    knoxLog('local API starting');
    const health = await fetchHealth().catch(() => null);
    apiOk = health?.ok === true;
    if (apiOk) {
      knoxLog('local API ready');
    } else {
      notes.push('local API not yet reachable; UI will retry');
      knoxLog('local API unreachable; UI will retry');
    }
  } else if (cfg && opts.skipHealthProbe) {
    apiOk = true;
  }

  // 4. KNOX Core owns storage/settings/providers/seed (single owner).
  emit('core');
  try {
    const { initKnox } = await import('../core/knox');
    const summary = await initKnox();
    knoxLog('storage ready');
    knoxLog('core ready');
    knoxLog(`providers ready (${summary.providers.length} providers)`);
  } catch (e) {
    notes.push(`core init recovered: ${e instanceof Error ? e.message : String(e)}`);
    logger.warn('init', 'core init issue during desktop boot', String(e));
  }

  // 5. Sidecars per settings (host owns the process; renderer declares intent).
  emit('sidecars');
  let sidecar: SidecarStatus | null = null;
  try {
    const settingsEnabled =
      (await import('../settings/settingsStore')).useSettings.getState().providersEnabled['youtube-music'] === true;
    const enabled = opts.youtubemusicEnabled ?? opts.jiosaavnEnabled ?? settingsEnabled;
    if (isTauri()) {
      if (enabled) knoxLog('YouTube Music sidecar starting');
      sidecar = enabled ? await ensureSidecar(true) : await getSidecarStatus();
      if (enabled && sidecar && sidecar.state !== 'ready') {
        notes.push(`youtube-music sidecar: ${sidecar.state}`);
        knoxLog(`provider unavailable: youtube-music (${sidecar.state})`);
      } else if (enabled && sidecar?.state === 'ready') {
        knoxLog('YouTube Music healthy');
      }
    }
  } catch (e) {
    // Sidecar failure is isolated — KNOX continues without it.
    notes.push('youtube-music sidecar unavailable; continuing without it');
    knoxLog('sidecar crashed: youtube-music (continuing without it)');
    logger.warn('init', 'sidecar ensure failed (isolated)', String(e));
  }

  const degraded = notes.length > 0;
  emit(degraded ? 'degraded' : 'ready');
  // 'degraded' still means usable — resolve ready-equivalent once painted.
  // Listeners see 'degraded'; the result phase stays honest.
  const result: BootResult = {
    phase: degraded ? 'degraded' : 'ready',
    apiOk,
    sidecar,
    notes,
    durationMs: Date.now() - started,
  };
  if (!degraded) emit('ready');
  knoxLog(degraded ? 'application ready (degraded)' : 'application ready');
  logger.info('init', `desktop boot ${result.phase} in ${result.durationMs}ms${apiOk ? ' (api ok)' : ''}`);
  return result;
}

/**
 * Idempotent shutdown (§19): stop downloads → flush stores → stop sidecars.
 * Safe to call twice; never throws; never blocks exit long.
 */
export async function shutdownDesktop(): Promise<void> {
  if (shutDown) return;
  shutDown = true;
  knoxLog('shutdown started');
  try {
    // 1. Stop in-flight downloads (controllers abort; state persists).
    try {
      const { useDownloads } = await import('../downloads/DownloadManager');
      const items = useDownloads.getState().items;
      await Promise.allSettled(
        items
          .filter((d) => d.state === 'DOWNLOADING' || d.state === 'QUEUED')
          .map((d) => useDownloads.getState().pause(d.id).catch(() => undefined)),
      );
    } catch {
      /* best effort */
    }
    // 2–4. Stores persist on write; nothing to flush explicitly.
    try {
      const { shutdownKnox } = await import('../core/knox');
      await shutdownKnox();
    } catch {
      /* shutdown never fails */
    }
    // 5. Stop sidecars (host terminates processes; time-boxed there).
    if (isTauri()) {
      await ensureSidecar(false).catch(() => null);
    }
  } finally {
    knoxLog('shutdown complete');
    logger.info('init', 'desktop shutdown complete');
  }
}

/** For tests: reset lifecycle state. */
export function __resetLifecycle(): void {
  shutDown = false;
  currentPhase = 'host';
  listeners.clear();
}
