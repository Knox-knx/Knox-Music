// settingsApi — UI entry point for settings + provider toggles.
//
// Settings persist locally (IndexedDB now; OS data dir mapping is owned by
// the desktop host). Toggling YouTube Music also reconciles its sidecar when
// running in the desktop shell — disabling stops the process gracefully.

import { useSettings, type KnoxSettings } from '../settings/settingsStore';
import { getProviderManager } from '../providers/ProviderManager';

export const settingsApi = {
  get state() {
    return useSettings.getState();
  },
  subscribe(fn: (s: ReturnType<typeof useSettings.getState>) => void): () => void {
    return useSettings.subscribe(fn);
  },
  async get(): Promise<KnoxSettings> {
    const s = useSettings.getState();
    if (!s.loaded) await s.load().catch(() => undefined);
    const cur = useSettings.getState();
    // Return the settings slice without store methods.
    const { loaded: _l, load: _lo, patch: _p, ...rest } = cur as KnoxSettings & {
      loaded: boolean;
      load: () => Promise<void>;
      patch: (p: Partial<KnoxSettings>) => Promise<void>;
    };
    return rest;
  },
  async patch(p: Partial<KnoxSettings>): Promise<void> {
    await useSettings.getState().patch(p);
    // Keep the live ProviderManager in sync (unknown ids ignored).
    if (p.providersEnabled) {
      const pm = getProviderManager();
      for (const [id, on] of Object.entries(p.providersEnabled)) {
        if (pm.get(id)) pm.setEnabled(id, on);
      }
      // YouTube Music toggle reconciles the desktop sidecar when hosted.
      if ('youtube-music' in p.providersEnabled) {
        try {
          const { isTauri } = await import('../desktop/detector');
          if (isTauri()) {
            const { ensureSidecar } = await import('../desktop/host');
            await ensureSidecar(p.providersEnabled['youtube-music'] === true);
          }
        } catch {
          /* sidecar reconcile is best-effort; provider stays isolated */
        }
      }
    }
  },
};
