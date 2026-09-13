// ProviderHealthManager — per-provider availability tracking.
//
// Tracks: available/unavailable, consecutive failures, timeouts,
// rate-limited-until, last success/failure timestamps, last latency.
// Recovery is automatic: a down provider becomes eligible again after the
// cooldown (half-open), and any success resets it immediately. Health never
// changes what the user sees beyond availability — failures still surface
// as partial-result notices, and playback is never touched.

export interface ProviderHealth {
  id: string;
  /** Currently eligible for requests (false while down or rate-limited). */
  available: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  rateLimitedUntil: number | null;
}

interface HealthOptions {
  /** Failures before a provider is marked down. Default 3. */
  maxConsecutiveFailures?: number;
  /** Ms before a down provider is retried (half-open). Default 60s. */
  cooldownMs?: number;
  now?: () => number;
}

type HealthRecord = Omit<ProviderHealth, 'id' | 'available'>;

export class ProviderHealthManager {
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly map = new Map<string, HealthRecord>();

  constructor(opts: HealthOptions = {}) {
    this.maxFailures = Math.max(1, opts.maxConsecutiveFailures ?? 3);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 60000);
    this.now = opts.now ?? Date.now;
  }

  recordSuccess(id: string, latencyMs: number): void {
    const h = this.entry(id);
    h.consecutiveFailures = 0;
    h.lastSuccessAt = this.now();
    h.lastLatencyMs = Math.max(0, Math.round(latencyMs));
    h.lastError = null;
    h.rateLimitedUntil = null;
  }

  recordFailure(id: string, message: string, opts: { rateLimited?: boolean; retryAfterMs?: number } = {}): void {
    const h = this.entry(id);
    const t = this.now();
    h.consecutiveFailures += 1;
    h.lastFailureAt = t;
    h.lastError = message.slice(0, 300);
    if (opts.rateLimited) {
      h.rateLimitedUntil = t + Math.max(1000, opts.retryAfterMs ?? 60000);
    }
  }

  /** Eligibility check (pure — never mutates). */
  isAvailable(id: string): boolean {
    const h = this.map.get(id);
    if (!h) return true; // unknown providers start eligible
    const t = this.now();
    if (h.rateLimitedUntil !== null && t < h.rateLimitedUntil) return false;
    if (h.consecutiveFailures >= this.maxFailures) {
      // Half-open: allow a retry once the cooldown has elapsed.
      if (h.lastFailureAt === null || t - h.lastFailureAt < this.cooldownMs) return false;
    }
    return true;
  }

  get(id: string): ProviderHealth {
    const h = this.entry(id);
    return { ...h, id, available: this.isAvailable(id) };
  }

  list(): ProviderHealth[] {
    return [...this.map.keys()].map((id) => this.get(id));
  }

  reset(id: string): void {
    this.map.delete(id);
  }

  private entry(id: string): HealthRecord {
    let h = this.map.get(id);
    if (!h) {
      h = {
        consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
        lastLatencyMs: null, lastError: null, rateLimitedUntil: null,
      };
      this.map.set(id, h);
    }
    return h;
  }
}

let singleton: ProviderHealthManager | null = null;
/** App-wide health view (the music ProviderManager singleton owns request recording). */
export function getProviderHealth(): ProviderHealthManager {
  if (!singleton) singleton = new ProviderHealthManager();
  return singleton;
}
