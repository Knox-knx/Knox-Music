// KNOX API client — the single transport abstraction for the UI.
//
// Components must call these facades (`searchApi`, `playerApi`, …) instead
// of reaching into providers/stores directly:
//
//   UI → knox API abstraction → KNOX Core (local) → ProviderManager → provider
//                            ↘ local HTTP/IPC (desktop infra: proxy, sidecar)
//
// The UI never knows whether an operation went through Tauri IPC,
// localhost HTTP, or stayed in-process — that decision lives here and in
// `src/desktop/`. Domain logic (ranking, lyrics parsing, radio mapping)
// stays in the shared TypeScript KNOX Core; the Rust host owns only
// infrastructure (loopback bind, proxy, sidecar processes).
//
// Validation: provider/track/playlist ids and URLs are validated at this
// boundary so malformed input fails fast instead of reaching providers or
// the filesystem.

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRACK_ID_RE = /^[A-Za-z0-9:_\-.]{1,256}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9:_\-.]{1,128}$/;

export function assertProviderId(id: unknown): string {
  if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id)) {
    throw new Error(`invalid provider id: ${String(id).slice(0, 64)}`);
  }
  return id;
}

export function assertTrackId(id: unknown): string {
  if (typeof id !== 'string' || !TRACK_ID_RE.test(id)) {
    throw new Error('invalid track id');
  }
  return id;
}

export function assertPlaylistId(id: unknown): string {
  if (typeof id !== 'string' || !PLAYLIST_ID_RE.test(id)) {
    throw new Error('invalid playlist id');
  }
  return id;
}

export function assertQuery(q: unknown, maxLen = 300): string {
  if (typeof q !== 'string') throw new Error('query must be a string');
  const trimmed = q.trim().slice(0, maxLen);
  if (!trimmed) throw new Error('query must not be empty');
  return trimmed;
}

/** Transport in use for diagnostics (no secrets). */
export async function transportInfo(): Promise<{ mode: 'desktop' | 'browser'; apiOk: boolean }> {
  const { runtimeMode } = await import('../desktop/detector');
  const mode = runtimeMode();
  if (mode === 'browser') return { mode, apiOk: false };
  try {
    const { fetchHealth } = await import('../desktop/localApi');
    const h = await fetchHealth();
    return { mode, apiOk: h?.ok === true };
  } catch {
    return { mode, apiOk: false };
  }
}
