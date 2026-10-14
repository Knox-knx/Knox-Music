// Web Discovery — public page fetcher.
//
// Fetches only publicly accessible HTML. No JS execution, no browser
// automation, no login/paywall bypass, no DRM/protected-endpoint extraction.
// Every hop is SSRF re-validated, redirects capped, size capped, time bounded.
// Never sends cookies/authorization/credentials; never logs tokens/URLs.

import { validateDiscoveryUrl } from '../ssrfGuard';

export interface FetchPageOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxRedirects?: number;
}

export const PAGE_FETCH_TIMEOUT_MS = 8000;
export const PAGE_MAX_BYTES = 1_000_000;
export const PAGE_MAX_REDIRECTS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Fetch public HTML with manual redirect handling (each hop re-validated). */
export async function fetchPublicPageHtml(
  rawUrl: string,
  opts: FetchPageOptions = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? PAGE_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? PAGE_MAX_REDIRECTS;
  let current = rawUrl;
  let redirects = 0;
  const startUrl = rawUrl;
  for (;;) {
    const verdict = validateDiscoveryUrl(current);
    if (!verdict.ok) return null;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS);
    try {
      // Prefer the local KNOX API proxy on desktop (no renderer CORS; the
      // server re-validates SSRF + redirects + size). Fall back to direct.
      if (redirects === 0) {
        try {
          const { fetchDiscoveryPageHtml } = await import('../localDiscoveryService');
          const via = await fetchDiscoveryPageHtml(verdict.url!, {
            signal: controller.signal,
            timeoutMs: opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS,
            fetchImpl: opts.fetchImpl,
            maxBytes,
          });
          if (via?.html) return via.html;
        } catch {
          /* fall through to direct */
        }
      }
      const res = await doFetch(verdict.url!, {
        signal: controller.signal,
        redirect: 'manual' as RequestRedirect,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (isRedirect(res.status)) {
        if (redirects >= maxRedirects) return null;
        const loc = res.headers.get('location');
        if (!loc) return null;
        try {
          current = new URL(loc, current).href;
        } catch {
          return null;
        }
        if (!validateDiscoveryUrl(current).ok) return null;
        try {
          const from = new URL(startUrl);
          const to = new URL(current);
          if (from.protocol === 'https:' && to.protocol !== 'https:') return null;
        } catch {
          return null;
        }
        redirects += 1;
        continue;
      }
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct && !ct.includes('html') && !ct.includes('xhtml') && !ct.includes('text')) return null;
      if (!res.body) {
        const text = await res.text().catch(() => null);
        if (!text || text.length > maxBytes) return null;
        return text;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return null;
        }
        chunks.push(value);
      }
      const total = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        total.set(c, off);
        off += c.byteLength;
      }
      return new TextDecoder().decode(total);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}
