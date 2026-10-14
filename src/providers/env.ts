// Centralized, secret-safe environment configuration.
//
// Only public, non-secret values are read here (base URLs for in-app servers
// and auxiliary metadata services).

export const LRCLIB_DEFAULT_BASE_URL = 'https://lrclib.net';
export const RADIO_BROWSER_DEFAULT_BASE_URL = 'https://de1.api.radio-browser.info';
/** Loopback only — the sidecar is a local service, never a public endpoint. */
export const YOUTUBEMUSIC_DEFAULT_BASE_URL = 'http://127.0.0.1:5000';
export const JIOSAAVN_DEFAULT_BASE_URL = 'https://www.jiosaavn.com/api.php';
export const SPOTIFY_DEFAULT_BASE_URL = 'https://api.spotify.com/v1';

function readEnv(...keys: string[]): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    if (!env) return undefined;
    for (const k of keys) {
      const v = env[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const providerEnv = {
  get requestTimeoutMs(): number {
    const raw = readEnv('VITE_REQUEST_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 15000;
  },
  get lrclibBaseUrl(): string {
    return (
      readEnv('VITE_LRCLIB_API_BASE_URL', 'LRCLIB_API_BASE_URL') ?? LRCLIB_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get radioBrowserBaseUrl(): string {
    return (
      readEnv('VITE_RADIO_BROWSER_API_BASE_URL', 'RADIO_BROWSER_API_BASE_URL') ??
      RADIO_BROWSER_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get youtubemusicBaseUrl(): string {
    return (
      readEnv('VITE_YOUTUBEMUSIC_API_BASE_URL', 'YOUTUBEMUSIC_API_BASE_URL') ??
      YOUTUBEMUSIC_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get jiosaavnBaseUrl(): string {
    return (
      readEnv('VITE_JIOSAAVN_API_BASE_URL', 'JIOSAAVN_API_BASE_URL') ??
      JIOSAAVN_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get spotifyBaseUrl(): string {
    return (
      readEnv('VITE_SPOTIFY_API_BASE_URL', 'SPOTIFY_API_BASE_URL') ??
      SPOTIFY_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
};
