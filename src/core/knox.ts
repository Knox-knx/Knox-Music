// KNOX Core — the local-first application kernel.
//
// The user's device IS the server: there is no remote KNOX backend, no cloud
// database, no mandatory account. This module owns the startup/shutdown
// sequence and wires the layers together:
//
//   UI → KNOX Core (this module + stores) → providers → Internet
//              ↘ local storage (Dexie/IndexedDB)
//
// Startup:  storage recovery → settings → providers (+toggles) → seed →
//           audio engine → downloads.
// Shutdown: best-effort settle (downloads/downloads-state are recovered on
//           next boot by recoverTransientStates, so shutdown never blocks).

import { useDownloads } from '../downloads/DownloadManager';
import { usePlayer } from '../audio/playerStore';
import { recoverTransientStates } from '../data/db';
import { songRepo } from '../data/repositories';
import { getProviderManager } from '../providers/ProviderManager';
import type { ProviderHealth } from '../providers/health';
import { LocalLibraryProvider } from '../providers/LocalLibraryProvider';
import { SampleCatalogProvider } from '../providers/SampleCatalogProvider';
import { JamendoProvider } from '../providers/jamendo/provider';
import { InternetArchiveProvider } from '../providers/internet-archive/provider';
import { FreetouseProvider } from '../providers/freetouse/provider';
import { AirbeatsProvider } from '../providers/airbeats/provider';
import { YouTubeMusicProvider } from '../providers/youtubeMusic/provider';
import { useSettings } from '../settings/settingsStore';
import { logger } from './logger';

export interface KnoxInitSummary {
  providers: { id: string; name: string; enabled: boolean }[];
  health: ProviderHealth[];
  demoSeeded: number;
  recoveredDownloads: number;
  durationMs: number;
}

async function seedSampleCatalog(): Promise<number> {
  try {
    const count = await songRepo.count().catch(() => 0);
    if (count > 0) return 0; // never reseed over user data
    const sample = new SampleCatalogProvider();
    const tracks = await sample.getAlbumTracks('');
    for (const t of tracks) {
      try {
        const stream = await sample.getStream(t);
        await songRepo.upsert({ ...t, streamUrl: stream.url }).catch(() => undefined);
      } catch { await songRepo.upsert(t).catch(() => undefined); }
    }
    logger.info('init', `seeded ${tracks.length} demo tracks`);
    return tracks.length;
  } catch (e) {
    logger.warn('init', 'seed skipped', String(e));
    return 0;
  }
}

/** Register every bundled provider. YouTube Music stays enabled unless disabled in settings. */
export function registerProviders(): void {
  const pm = getProviderManager();
  if (!pm.get('local')) pm.register(new LocalLibraryProvider(), true);
  if (!pm.get('sample')) pm.register(new SampleCatalogProvider(), true);
  if (!pm.get('jamendo')) pm.register(new JamendoProvider(), true);
  if (!pm.get('internet-archive')) pm.register(new InternetArchiveProvider(), true);
  if (!pm.get('freetouse')) pm.register(new FreetouseProvider(), true);
  if (!pm.get('airbeats')) pm.register(new AirbeatsProvider(), true);
  if (!pm.get('youtube-music')) pm.register(new YouTubeMusicProvider(), true);
}

/** Full local startup sequence. Safe to await before first render. */
export async function initKnox(): Promise<KnoxInitSummary> {
  const started = Date.now();
  registerProviders();
  const pm = getProviderManager();

  const recoveredDownloads = await recoverTransientStates().catch(() => 0);
  await useSettings.getState().load().catch(() => undefined);

  // Apply provider toggles from settings (unknown ids ignored).
  const enabled = useSettings.getState().providersEnabled;
  for (const [id, on] of Object.entries(enabled)) {
    if (pm.get(id)) pm.setEnabled(id, on);
  }

  const demoSeeded = await seedSampleCatalog();
  usePlayer.getState().hydrateFromEngine();
  await useDownloads.getState().load().catch(() => undefined);
  // Smart Cache needs no startup sweep: every HIT is re-validated on read
  // and corrupted entries auto-invalidate. Cache rows persist across
  // restarts by design (user downloads untouched).
  // Delayed auto-clear sweep (best-effort): rows whose persistent
  // autoClearAt deadline passed while the app was closed are removed now.
  // Survives restart; never touches offline/library; never blocks boot.
  try {
    const { runSmartCacheAutoClearMaintenance } = await import('../cache/smartCacheAutoClear');
    await runSmartCacheAutoClearMaintenance().catch(() => undefined);
  } catch {
    /* maintenance never blocks boot */
  }

  const summary: KnoxInitSummary = {
    providers: pm.list(),
    health: pm.healthManager().list(),
    demoSeeded,
    recoveredDownloads,
    durationMs: Date.now() - started,
  };
  logger.info('init', `knox core ready (${summary.providers.length} providers, ${recoveredDownloads} downloads recovered)`);
  return summary;
}

/**
 * Best-effort shutdown: settings persist on write, downloads recover on next
 * boot — nothing here is allowed to throw or block app exit. The active
 * playback object URL is revoked; Smart Cache rows persist (never user
 * downloads).
 */
export async function shutdownKnox(): Promise<void> {
  try {
    const { cleanupPlaybackCacheUrls } = await import('../audio/playerStore');
    await cleanupPlaybackCacheUrls().catch(() => undefined);
  } catch {
    /* playback cleanup never fails shutdown */
  }
  try {
    getProviderManager().healthManager().list();
    logger.info('init', 'knox core shutdown');
  } catch {
    /* shutdown never fails */
  }
}
