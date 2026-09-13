// Audio diagnostics — DEVELOPMENT-ONLY flag.
//
// Precedence: process env (Vite) > localStorage override > default.
//
//   KNOX_DIRECT_PROVIDER_PLAYBACK_DEBUG=true
//     Provider → fresh URL → AudioEngine → HTMLAudioElement.
//     NO Smart Cache, NO object URL, NO download.
//     If playback works here but fails via cache, compare the provider URL
//     against the cached bytes (container/MIME). If it also fails, the
//     cause is in the AudioEngine/provider/media lifecycle.
//
// localStorage override (dev console, no rebuild needed):
//   localStorage['knox.dbg.directPlayback'] = '1' | '0'

function envFlag(name: string): boolean | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const raw = env?.[name];
    if (raw === undefined) return null;
    const v = String(raw).trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return null;
  } catch {
    return null;
  }
}

function storageFlag(key: string): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the DIRECT provider playback diagnostic path is enabled.
 * DEVELOPMENT ONLY — bypasses the entire Temporary Playback Buffer.
 */
export function isDirectPlaybackDebugEnabled(): boolean {
  const fromStorage = storageFlag('knox.dbg.directPlayback');
  if (fromStorage !== null) return fromStorage;
  return envFlag('KNOX_DIRECT_PROVIDER_PLAYBACK_DEBUG') === true;
}

/** Snapshot of active diagnostic flags (safe to log). */
export function debugFlagsSnapshot(): { directPlayback: boolean } {
  return {
    directPlayback: isDirectPlaybackDebugEnabled(),
  };
}
