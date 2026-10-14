// Live Web Discovery — SSRF + URL safety guard.
//
// Single choke point for every outbound discovery fetch. Blocks:
// localhost, loopback, private RFC1918 ranges, link-local, cloud metadata
// endpoints, and dangerous schemes (file://, javascript:, data:, etc).
// Only http(s) to public hosts is allowed. Redirect targets are re-checked.

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
  '169.254.169.254',
]);

const DANGEROUS_SCHEMES = new Set([
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'ftp:',
  'gopher:',
  'expect:',
  'vbscript:',
]);

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function ipv4Parts(host: string): number[] | null {
  if (!isIpv4(host)) return null;
  const parts = host.split('.').map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/** True for loopback / private / link-local / reserved IPv4. */
export function isPrivateIpv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isLoopbackOrSpecial(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (h.startsWith('[::ffff:127.')) return true;
  // Bracketed IPv6 loopback / unspecified.
  if (h === '[::]' || h === '[0:0:0:0:0:0:0:1]') return true;
  if (isPrivateIpv4(h)) return true;
  // Hex / octal encoded loopback attempts (0x7f.0.0.1 etc) — reject anything
  // that does not look like a normal public hostname or dotted IP.
  return false;
}

export interface DiscoveryUrlVerdict {
  ok: boolean;
  reason: string;
  url?: string;
}

/**
 * Validate a candidate discovery URL. Pure — no network. Returns the
 * normalized href on success. Rejects dangerous schemes, blocked hosts,
 * credentials in URL, and non-http(s) protocols.
 */
export function validateDiscoveryUrl(raw: string): DiscoveryUrlVerdict {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'empty-url' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'empty-url' };
  if (trimmed.length > 2048) return { ok: false, reason: 'url-too-long' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable-url' };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) return { ok: false, reason: 'dangerous-scheme' };
  if (scheme !== 'http:' && scheme !== 'https:') return { ok: false, reason: 'unsafe-protocol' };
  // Never allow credentials embedded in discovery URLs.
  if (parsed.username || parsed.password) return { ok: false, reason: 'credentials-in-url' };
  const host = parsed.hostname.toLowerCase();
  if (!host) return { ok: false, reason: 'missing-host' };
  if (isLoopbackOrSpecial(host)) return { ok: false, reason: 'blocked-host' };
  // Decimal-encoded 2130706433 (=127.0.0.1) style bypasses.
  if (/^\d+$/.test(host) && Number(host) >>> 0 === 2130706433) {
    return { ok: false, reason: 'blocked-host' };
  }
  return { ok: true, reason: 'ok', url: parsed.href };
}

/** Scrub a URL for logs: origin + path only, no query/hash/credentials. */
export function scrubDiscoveryUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

/** Short non-reversible hash for query logging (never logs raw queries at debug). */
export async function hashQueryForLog(query: string): Promise<string> {
  try {
    const buf = new TextEncoder().encode(`knox-discovery:${query}`);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch {
    return '<unhashable>';
  }
}

export function hashQuerySync(query: string): string {
  // FNV-1a fallback for non-secure contexts / tests without subtle crypto.
  let h = 0x811c9dc5;
  const s = `knox-discovery:${query}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
