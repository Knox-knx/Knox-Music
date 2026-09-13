// Centralized, secret-safe environment configuration.
//
// Only public, non-secret values are read here (client IDs for public APIs,
// base URLs). Never add client secrets, tokens, or passwords — they must not
// ship in frontend code.

export const JAMENDO_DEFAULT_CLIENT_ID = 'ecadb32a';
export const JAMENDO_DEFAULT_BASE_URL = 'https://api.jamendo.com/v3.0';
export const IA_DEFAULT_BASE_URL = 'https://archive.org';
export const FREETOUSE_DEFAULT_BASE_URL = 'https://api.freetouse.com/v3';
export const LRCLIB_DEFAULT_BASE_URL = 'https://lrclib.net';
export const RADIO_BROWSER_DEFAULT_BASE_URL = 'https://de1.api.radio-browser.info';
export const AIRBEATS_DEFAULT_BASE_URL = 'https://api.airbeats.xyz';
/** Loopback only — the sidecar is a local service, never a public endpoint. */
export const YOUTUBEMUSIC_DEFAULT_BASE_URL = 'http://127.0.0.1:5000';

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
  /** Public Jamendo client_id (identifier only — never a secret). */
  get jamendoClientId(): string {
    return (
      readEnv('VITE_JAMENDO_CLIENT_ID', 'JAMENDO_CLIENT_ID') ?? JAMENDO_DEFAULT_CLIENT_ID
    );
  },
  get jamendoBaseUrl(): string {
    return (
      readEnv('VITE_JAMENDO_API_BASE_URL', 'JAMENDO_API_BASE_URL') ?? JAMENDO_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get iaBaseUrl(): string {
    return (
      readEnv('VITE_INTERNET_ARCHIVE_API_BASE_URL', 'INTERNET_ARCHIVE_API_BASE_URL') ??
      IA_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
  get freetouseBaseUrl(): string {
    return (
      readEnv('VITE_FREETOUSE_API_BASE_URL', 'FREETOUSE_API_BASE_URL') ??
      FREETOUSE_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
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
  /** AirBeats catalog API (public, no key — never a secret). */
  get airbeatsBaseUrl(): string {
    return (
      readEnv('VITE_AIRBEATS_API_BASE_URL', 'AIRBEATS_API_BASE_URL') ??
      AIRBEATS_DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  },
};
