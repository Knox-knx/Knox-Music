export function formatMs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function formatBytes(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, waitMs: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...args: never[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  }) as T;
}

export function stableId(...parts: string[]): string {
  return parts.join(':').slice(0, 220);
}

/** Prevent path traversal + make safe file names. */
export function sanitizeFilename(name: string, fallback = 'track'): string {
  const base = (name || fallback).normalize('NFKD').replace(/[^\w\-. ()[\]]+/g, '_').replace(/\.+/g, '.').replace(/^\.+/, '').trim();
  const clean = base.replace(/(\.\.(\/|\\))+/g, '_');
  return clean.slice(0, 120) || fallback;
}

/** Never trust provider URLs — only allow http(s) + blob + data:image. */
export function isSafeUrl(url: string): boolean {
  try {
    // Windowless contexts (node tooling/tests) have no location — fall back
    // to a loopback base like validateStreamCandidate does. Absolute
    // provider URLs are unaffected by the base either way.
    const base =
      typeof window !== 'undefined' && window.location?.href ? window.location.href : 'http://localhost/';
    const u = new URL(url, base);
    // Blob URLs are the temporary-playback / offline path (created locally
    // via URL.createObjectURL) — always safe to hand back to the element.
    if (u.protocol === 'blob:') return true;
    if (u.protocol === 'data:') return url.startsWith('data:image/');
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

export function safeUrlOrUndefined(url?: string): string | undefined {
  if (!url) return undefined;
  return isSafeUrl(url) ? url : undefined;
}

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const buf = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function greetingForHour(h: number): string {
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
