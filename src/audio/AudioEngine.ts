import type { PlayerState } from '../core/states';
import { logger } from '../core/logger';
import { safeUrlOrUndefined } from '../core/utils';
import {
  mediaErrorName,
  validateStreamCandidate,
} from './mediaDiagnostics';

/**
 * Honest snapshot of the underlying media element for diagnostics.
 * Never contains URLs, tokens, or content — only pipeline state.
 */
export interface AudioDiagnostics {
  hasSrc: boolean;
  /** Origin + path of the loaded source (query stripped — signed URLs stay secret). */
  srcHost: string | null;
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  durationMs: number;
  positionMs: number;
  bufferedMs: number;
  errorCode: number | null;
  audible: boolean;
}

/** Extract origin+path only (drops query/hash that may carry signatures). */
function scrubSrc(src: string): string | null {
  if (!src) return null;
  try {
    const u = new URL(src, 'http://localhost');
    if (u.protocol === 'blob:' || u.protocol === 'data:') return `${u.protocol}//<local>`;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

function mediaErrorCode(el: HTMLAudioElement): number | null {
  try {
    const err = el.error as { code?: number } | null;
    return typeof err?.code === 'number' ? err.code : null;
  } catch {
    return null;
  }
}

/** Guarded numeric reads (some platforms throw before metadata loads). */
function safeNum(read: () => number, fallback = 0): number {
  try {
    const v = read();
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function safeBool(read: () => boolean, fallback: boolean): boolean {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function safeVolume(el: HTMLAudioElement): number {
  try {
    const v = el.volume;
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  } catch {
    return 0;
  }
}

/**
 * AudioEngine — thin, honest wrapper over ONE HTMLAudioElement (singleton).
 * Only exposes features the engine truly supports (no fake equalizer etc.).
 * Emits state transitions the UI subscribes to.
 *
 * Source lifecycle (explicit, generation-owned — PHASE 3/4/5):
 *   1. Store claims a playback generation: claimGeneration(g).
 *   2. Store releases the previous source: releaseCurrentSource(g)
 *      (pause → remove src → load() → confirm detached → revoke ONLY via
 *      the owning generation's revoker).
 *   3. Store assigns the new source: assignSourceForGeneration(g, url, …)
 *      (refuses stale generations and refuses to overwrite a source that
 *      was not released first — never bare `audio.src = x; audio.play()`).
 *   4. waitForCanPlay → play() → clock-advance verification (PHASE 8).
 *
 * A stale generation can never mutate the element: release/assign/play
 * helpers all take the generation and no-op (or throw, for assign) when it
 * is no longer current. Async callbacks (canplay, timers, watchdogs) must
 * re-check isCurrentGeneration() before touching anything.
 *
 * Radio and explicit offline/local files use the same machinery with their
 * own kinds ('radio' / 'offline'); revocation ownership stays with whoever
 * registered the revoker (temp manager for temp URLs, store for offline
 * URLs). The engine never revokes a URL it does not own via a revoker.
 *
 * MIME/URL policy (§5): the engine receives the actual provider-authorized
 * media resource as-is. It never appends extensions (.mp3/.mp4/.m4a) and
 * never forces a MIME type — container/codec honesty is enforced upstream
 * (provider getStream MIME inference + pre-flight validation in the store,
 * plus temp-file validation in the buffer).
 */

/** What kind of bytes back the currently assigned element source. */
export type EngineSourceKind = 'temp-blob' | 'temp-file' | 'direct' | 'offline' | 'radio';

/**
 * Generation-owned element assignment (PHASE 4/5). Only the owning
 * generation's revoker may release the URL — and only AFTER the element no
 * longer references it (pause → detach → load → confirm → revoke).
 */
export interface SourceOwnership {
  generation: number;
  /** Full URL kept privately; diagnostics expose only the scrubbed host. */
  url: string;
  trackId: string;
  kind: EngineSourceKind;
  /** Owner's cleanup (revoke URL / delete file). Null when nothing to release. */
  revoker: ((url: string) => void) | null;
}

/** Per-generation source snapshot for root-cause diagnostics (PHASE 7). */
export interface SourceDiagnostics {
  generation: number | null;
  trackId: string | null;
  sourceKind: EngineSourceKind | null;
  hasSrc: boolean;
  srcHost: string | null;
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  currentTimeMs: number;
  durationMs: number;
  muted: boolean;
  volume: number;
  errorCode: number | null;
  errorMessage: string | null;
  detachedConfirmed: boolean | null;
  eventTrail: string[];
}
export class AudioEngine {
  private audio: HTMLAudioElement;
  private listeners = new Set<(s: PlayerState) => void>();
  private posListeners = new Set<(posMs: number, durMs: number) => void>();
  private endedListeners = new Set<(kind: 'full' | 'preview') => void>();
  /**
   * Compact media event trail (§8): ordered event names since the last load()
   * (e.g. loadstart → loadedmetadata → canplay → playing → waiting → error).
   * Names only — never URLs, never content — safe for production logs.
   */
  private eventTrail: string[] = [];
  private static readonly MAX_TRAIL = 40;
  state: PlayerState = 'IDLE';
  /**
   * True while the loaded source is a short provider preview, not the full
   * recording. Set by the player store before playback from the track's
   * explicit capability flags — never inferred here.
   */
  private previewMode = false;
  private crossfadeMs = 0;
  private fadeTimer?: ReturnType<typeof setInterval>;
  /**
   * Session tag of the source currently assigned to the element
   * (temp session id, 'radio', 'offline/local', or 'direct'). Diagnostics
   * only — revocation ownership stays with the Temporary Playback Buffer
   * (temp URLs) or the caller (offline URLs). The engine never revokes a
   * URL it does not own; it only detaches.
   */
  private assignedSourceTag: string | null = null;
  /**
   * Highest playback generation claimed so far (PHASE 4). Any async work
   * carrying an older generation must not touch element or state.
   */
  private latestGeneration = 0;
  /** Current element assignment with its owning generation (PHASE 5). */
  private owned: SourceOwnership | null = null;
  /** Result of the last detach confirmation (null = no release yet). */
  private lastDetachConfirmed: boolean | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    // Media-pipeline event trail (§8): lifecycle at debug, stalls as warn,
    // hard errors as error with the MediaError code. Payloads are event
    // names only — never URLs, never content — so production logs stay
    // useful without spamming or leaking.
    const trail = (name: string) => {
      this.eventTrail.push(name);
      if (this.eventTrail.length > AudioEngine.MAX_TRAIL) {
        this.eventTrail.splice(0, this.eventTrail.length - AudioEngine.MAX_TRAIL);
      }
    };
    this.audio.addEventListener('loadstart', () => {
      trail('loadstart');
      logger.debug('audio', 'event loadstart');
      this.setState('LOADING');
    });
    this.audio.addEventListener('loadedmetadata', () => { trail('loadedmetadata'); logger.debug('audio', 'event loadedmetadata'); });
    this.audio.addEventListener('loadeddata', () => { trail('loadeddata'); logger.debug('audio', 'event loadeddata'); });
    this.audio.addEventListener('durationchange', () => { trail('durationchange'); logger.debug('audio', 'event durationchange'); });
    this.audio.addEventListener('progress', () => { trail('progress'); logger.debug('audio', 'event progress'); });
    this.audio.addEventListener('canplay', () => { trail('canplay'); logger.debug('audio', 'event canplay'); });
    this.audio.addEventListener('canplaythrough', () => { trail('canplaythrough'); logger.debug('audio', 'event canplaythrough'); });
    this.audio.addEventListener('waiting', () => {
      trail('waiting');
      logger.warn('audio', 'event waiting (buffer underrun)');
      this.setState('BUFFERING');
    });
    this.audio.addEventListener('stalled', () => { trail('stalled'); logger.warn('audio', 'event stalled (network stall)'); });
    this.audio.addEventListener('suspend', () => { trail('suspend'); logger.debug('audio', 'event suspend'); });
    this.audio.addEventListener('abort', () => { trail('abort'); logger.debug('audio', 'event abort'); });
    this.audio.addEventListener('emptied', () => { trail('emptied'); logger.debug('audio', 'event emptied'); });
    this.audio.addEventListener('seeking', () => { trail('seeking'); logger.debug('audio', 'event seeking'); });
    this.audio.addEventListener('seeked', () => { trail('seeked'); logger.debug('audio', 'event seeked'); });
    this.audio.addEventListener('playing', () => {
      trail('playing');
      logger.debug('audio', 'event playing');
      this.setState('PLAYING');
    });
    this.audio.addEventListener('play', () => { trail('play'); logger.debug('audio', 'event play'); });
    this.audio.addEventListener('pause', () => {
      trail('pause');
      logger.debug('audio', 'event pause');
      if (!this.audio.ended) this.setState('PAUSED');
    });
    this.audio.addEventListener('ended', () => {
      trail('ended');
      logger.debug('audio', 'event ended');
      this.setState('COMPLETED');
      // FULL TRACK ENDED vs PREVIEW ENDED are fundamentally different:
      // a preview ending must never loop, restart, or consume the queue.
      const kind = this.previewMode ? 'preview' : 'full';
      this.endedListeners.forEach((fn) => fn(kind));
    });
    this.audio.addEventListener('error', () => {
      trail('error');
      const code = mediaErrorCode(this.audio);
      logger.error('audio', `event error (${mediaErrorName(code)} code ${code ?? 'unknown'}) trail=${this.eventTrail.join('>')}`);
      this.setState('ERROR');
    });
    this.audio.addEventListener('timeupdate', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
      this.emitPos(this.audio.currentTime * 1000, dur);
    });
  }

  onState(fn: (s: PlayerState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  onPosition(fn: (posMs: number, durMs: number) => void): () => void {
    this.posListeners.add(fn);
    return () => { this.posListeners.delete(fn); };
  }
  /**
   * Fired on natural playback end with the kind of source that ended.
   * 'preview' subscribers must NOT auto-advance the queue; 'full'
   * subscribers follow the existing queue/repeat behavior.
   */
  onEnded(fn: (kind: 'full' | 'preview') => void): () => void {
    this.endedListeners.add(fn);
    return () => { this.endedListeners.delete(fn); };
  }

  /** Declare what kind of source is (about to be) loaded. */
  setPreviewMode(preview: boolean) { this.previewMode = preview; }
  isPreviewMode(): boolean { return this.previewMode; }

  private setState(s: PlayerState) {
    this.state = s;
    this.listeners.forEach((fn) => fn(s));
  }
  private emitPos(pos: number, dur: number) {
    this.posListeners.forEach((fn) => fn(pos, dur));
  }

  async load(url: string): Promise<void> {
    // Pre-assignment gate (§2): reject invalid responses BEFORE they reach
    // the element. Never assigns an empty/unsafe URL and never rewrites the
    // provider URL (no extension appending, no MIME forcing — §5).
    const verdict = validateStreamCandidate({ url });
    if (!verdict.ok) {
      logger.error('audio', `rejected invalid media URL before load (${verdict.reason})`);
      this.setState('ERROR');
      throw new Error(`Invalid audio source (${verdict.reason})`);
    }
    const safe = safeUrlOrUndefined(url);
    if (!safe) {
      logger.error('audio', 'rejected unsafe media URL before load (unsafe-url)');
      this.setState('ERROR');
      throw new Error('Provider returned an unsafe audio URL');
    }
    this.eventTrail = [];
    this.setState('LOADING');
    logger.debug('audio', `loading source (${scrubSrc(safe) ?? '<local>'})`);
    // Actual track transition: never inherit the previous track's position.
    this.prepareForTrack();
    // The browser receives the actual media resource as-is (§5).
    this.audio.src = safe;
    this.assignedSourceTag = safe.startsWith('blob:') ? 'offline/local' : 'direct';
    // Legacy path: unowned (generation 0) assignment without a revoker.
    this.owned = { generation: 0, url: safe, trackId: 'legacy', kind: safe.startsWith('blob:') ? 'offline' : 'direct', revoker: null };
    this.audio.load();
    // load() resets the element — re-assert 0:00 for the new source.
    this.resetPosition();
  }

  async play(): Promise<void> {
    try { await this.audio.play(); }
    catch (e) {
      logger.error('audio', `play() rejected (${e instanceof Error ? e.name : 'unknown'})`);
      this.setState('ERROR');
      throw e;
    }
  }

  pause() { this.audio.pause(); }

  async playUrl(url: string): Promise<void> {
    await this.load(url);
    await this.play();
  }

  // ------------------------------------------------------------------
  // Generation-owned source lifecycle (PHASE 3/4/5).
  // ------------------------------------------------------------------

  /**
   * Claim a playback generation. Monotonic: the engine remembers the
   * highest generation seen; anything older is stale and must not mutate
   * the element, the temp source, or player state.
   */
  claimGeneration(gen: number): void {
    if (Number.isFinite(gen) && gen > this.latestGeneration) {
      this.latestGeneration = gen;
    }
  }

  /** True when `gen` is still the latest claimed generation (0 = legacy, always allowed). */
  isCurrentGeneration(gen: number): boolean {
    if (gen === 0) return true;
    return gen === this.latestGeneration;
  }

  /** Highest generation claimed so far (diagnostics/tests). */
  getLatestGeneration(): number {
    return this.latestGeneration;
  }

  /** Current element assignment, if any (never exposes the raw URL). */
  getOwnedSource(): { generation: number; trackId: string; kind: EngineSourceKind } | null {
    if (!this.owned) return null;
    return { generation: this.owned.generation, trackId: this.owned.trackId, kind: this.owned.kind };
  }

  /**
   * Poll until the element reports no current source (or timeout).
   * Best-effort: jsdom/test doubles may never report detached — the caller
   * records the outcome in diagnostics but never blocks playback on it.
   */
  private async confirmDetached(timeoutMs = 1500): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      let detached = false;
      try {
        const srcAttr = this.audio.getAttribute('src');
        const cur = this.audio.currentSrc || '';
        detached = (srcAttr === null || srcAttr === '') && cur === '';
      } catch {
        detached = false;
      }
      if (detached) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Explicit source release (PHASE 3/5):
   *   pause → remove src → load() → confirm detached → revoke ONLY via the
   *   owning generation's revoker.
   *
   * A caller whose generation is OLDER than the assigned source's refuses
   * to touch anything (returns released:false) — a superseded track can
   * never cut off or revoke the current track's audio. A same-or-newer
   * generation may evict; revocation still goes through the OLD owner's
   * revoker (only the owner releases its own URL).
   */
  async releaseCurrentSource(
    gen: number,
    opts: { confirmTimeoutMs?: number } = {},
  ): Promise<{ released: boolean; reason: string; detachedConfirmed: boolean | null }> {
    const prev = this.owned;
    if (prev && gen !== 0 && gen < prev.generation) {
      return { released: false, reason: 'superseded-older-generation', detachedConfirmed: this.lastDetachConfirmed };
    }
    try {
      this.audio.pause();
    } catch {
      /* already paused */
    }
    try {
      this.audio.removeAttribute('src');
    } catch {
      /* detach is best-effort */
    }
    try {
      this.audio.load();
    } catch {
      /* reset is best-effort */
    }
    this.resetPosition();
    const confirmed = await this.confirmDetached(opts.confirmTimeoutMs ?? 1500);
    this.lastDetachConfirmed = confirmed;
    if (!confirmed) {
      logger.warn('audio', 'source detach unconfirmed after release (proceeding with owner revoker)');
    }
    this.owned = null;
    this.assignedSourceTag = null;
    // Fresh per-generation trail: the next assignment starts a new sequence.
    this.eventTrail = ['source-released'];
    if (prev) {
      // Ownership rule: only the owning generation's revoker runs, and only
      // now that the element no longer references the URL.
      try {
        prev.revoker?.(prev.url);
      } catch {
        /* owner cleanup is best-effort */
      }
      logger.debug('audio', 'source released (paused, detached, reset, owner-revoked)');
      return { released: true, reason: 'released', detachedConfirmed: confirmed };
    }
    logger.debug('audio', 'source released (nothing assigned)');
    return { released: true, reason: 'nothing-assigned', detachedConfirmed: confirmed };
  }

  /**
   * Assign a new source for exactly one generation (PHASE 3/4). Refuses:
   *  - stale generations (caller is no longer current), and
   *  - overwriting an unreleased assignment (caller must release first —
   *    bare `audio.src = x` track transitions are forbidden).
   * Validates the candidate BEFORE assignment, assigns as-is (no extension
   * appending, no MIME forcing), loads, and waits for canplay.
   */
  async assignSourceForGeneration(
    gen: number,
    url: string,
    meta: {
      trackId: string;
      kind: EngineSourceKind;
      revoker?: ((url: string) => void) | null;
      timeoutMs?: number;
      sourceTag?: string;
    },
  ): Promise<void> {
    if (gen !== 0 && gen !== this.latestGeneration) {
      throw new Error(`Stale playback generation (got ${gen}, current ${this.latestGeneration})`);
    }
    if (this.owned) {
      throw new Error('Previous source not released — call releaseCurrentSource first');
    }
    const verdict = validateStreamCandidate({ url });
    if (!verdict.ok) {
      logger.error('audio', `rejected invalid media URL before assign (${verdict.reason})`);
      this.setState('ERROR');
      throw new Error(`Invalid audio source (${verdict.reason})`);
    }
    const safe = safeUrlOrUndefined(url);
    if (!safe) {
      logger.error('audio', 'rejected unsafe media URL before assign (unsafe-url)');
      this.setState('ERROR');
      throw new Error('Provider returned an unsafe audio URL');
    }
    this.eventTrail = [];
    this.setState('LOADING');
    logger.debug('audio', `LOAD_STARTED gen=${gen} kind=${meta.kind} (${scrubSrc(safe) ?? '<local>'})`);
    this.prepareForTrack();
    this.audio.src = safe;
    this.owned = {
      generation: gen,
      url: safe,
      trackId: meta.trackId,
      kind: meta.kind,
      revoker: meta.revoker ?? null,
    };
    this.assignedSourceTag = meta.sourceTag ?? `${meta.kind}:${meta.trackId.slice(0, 12)}`;
    this.audio.load();
    this.resetPosition();
    logger.debug('audio', `MEDIA_SOURCE_ASSIGNED gen=${gen} kind=${meta.kind}`);
    await this.waitForCanPlay(meta.timeoutMs ?? 15000);
  }

  /**
   * Detach the current source WITHOUT revoking any URL (revocation is owned
   * by the Temporary Playback Buffer / offline caller, which runs AFTER this
   * detach per the lifecycle: pause → remove source → detach → revoke →
   * reset → new session → assign → load() → wait → play()).
   *
   * Legacy synchronous path — new code should prefer releaseCurrentSource()
   * (async, generation-owned, confirm-detached, owner-revoked).
   */
  releaseSource(): void {
    try {
      this.audio.pause();
    } catch {
      /* already paused */
    }
    try {
      this.audio.removeAttribute('src');
    } catch {
      /* detach is best-effort */
    }
    try {
      this.audio.load();
    } catch {
      /* reset is best-effort */
    }
    this.resetPosition();
    this.owned = null;
    this.assignedSourceTag = null;
    logger.debug('audio', 'source released (paused, detached, reset)');
  }

  /**
   * Assign a FRESH temporary object URL from the Temporary Playback Buffer
   * and wait until the element can play it (loadedmetadata/canplay) or fail
   * fast with an honest error. Never reuses a previous URL — the caller
   * always passes a new session's URL.
   *
   * Generation-aware: pass the playback generation (and, for temp-blob
   * sources, the owning session revoker) so stale/superseded assignments
   * are refused and revocation stays owner-bound. Delegates to
   * assignSourceForGeneration — which requires any previous source to have
   * been released first.
   */
  async loadTempSource(
    objectUrl: string,
    opts: {
      sessionId: string;
      trackId: string;
      timeoutMs?: number;
      generation?: number;
      revoker?: ((url: string) => void) | null;
    } = {
      sessionId: 'unknown',
      trackId: 'unknown',
    },
  ): Promise<void> {
    if (!objectUrl || typeof objectUrl !== 'string' || !objectUrl.startsWith('blob:')) {
      logger.error('audio', 'rejected temp source (not a blob URL)');
      this.setState('ERROR');
      throw new Error('Invalid temporary audio source');
    }
    const gen = opts.generation ?? 0;
    if (gen !== 0) this.claimGeneration(gen);
    await this.assignSourceForGeneration(gen, objectUrl, {
      trackId: opts.trackId,
      kind: 'temp-blob',
      revoker: opts.revoker ?? null,
      timeoutMs: opts.timeoutMs ?? 15000,
      sourceTag: `temp:${opts.sessionId.slice(0, 8)}`,
    });
  }

  /** Tag of the currently assigned source (diagnostics only, never a URL). */
  getAssignedSourceTag(): string | null {
    return this.assignedSourceTag;
  }

  /**
   * Wait for loadedmetadata/canplay (or fail on error/empty/timeout).
   * Resolves once the element can produce audio; rejects honestly otherwise.
   */
  waitForCanPlay(timeoutMs = 15000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finishOk = () => {
        if (done) return;
        done = true;
        cleanup();
        logger.debug('audio', 'CAN_PLAY (temp source ready)');
        resolve();
      };
      const finishErr = (msg: string) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(msg));
      };
      // Already ready (cached metadata race) — resolve immediately.
      try {
        if (this.audio.readyState >= 1) {
          finishOk();
          return;
        }
      } catch {
        /* fall through to event wait */
      }
      const onMeta = () => {
        logger.debug('audio', 'LOADED_METADATA');
      };
      const onCanPlay = () => finishOk();
      const onError = () => {
        const code = mediaErrorCode(this.audio);
        finishErr(`Temporary audio failed to load (${mediaErrorName(code)} code ${code ?? 'unknown'})`);
      };
      const timer = setTimeout(() => finishErr('Temporary audio timed out while loading'), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        try {
          this.audio.removeEventListener('loadedmetadata', onMeta);
          this.audio.removeEventListener('canplay', onCanPlay);
          this.audio.removeEventListener('error', onError);
        } catch {
          /* ignore */
        }
      };
      this.audio.addEventListener('loadedmetadata', onMeta);
      this.audio.addEventListener('canplay', onCanPlay);
      this.audio.addEventListener('error', onError);
    });
  }

  /**
   * Verify the media clock advances within `timeoutMs` after play().
   * Returns true when currentTime moves (real audio), false otherwise so
   * the caller can classify download/invalid/decode/provider/lifecycle vs
   * OS-output failures. Never throws.
   */
  async awaitClockAdvance(timeoutMs = 6000): Promise<boolean> {
    const start = (() => {
      try {
        return this.audio.currentTime;
      } catch {
        return 0;
      }
    })();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        if (this.audio.error) return false;
        if (Math.abs(this.audio.currentTime - start) > 0.05) return true;
        if (!this.audio.paused && !this.audio.ended && this.audio.readyState >= 2) {
          // Element claims playing with data — keep waiting for movement.
          continue;
        }
      } catch {
        return false;
      }
    }
    try {
      return Math.abs(this.audio.currentTime - start) > 0.05;
    } catch {
      return false;
    }
  }

  /**
   * Reset for an actual track transition: pause, then back to 0:00 BEFORE
   * the new source is assigned. Call only when the track really changes —
   * never during search, sorting, filtering, renders, or UI changes.
   */
  prepareForTrack(): void {
    try { this.audio.pause(); } catch { /* already paused */ }
    this.resetPosition();
  }

  /** Back to 0:00 (guarded — some platforms reject seeks before metadata). */
  resetPosition(): void {
    try { this.audio.currentTime = 0; } catch { /* seek not ready yet */ }
  }

  seekTo(ms: number) {
    this.audio.currentTime = Math.max(0, ms / 1000);
  }

  setVolume(v: number) { this.audio.volume = Math.min(1, Math.max(0, v)); }
  setMuted(m: boolean) { this.audio.muted = m; }
  setRate(r: number) { this.audio.playbackRate = r; }
  setCrossfade(ms: number) { this.crossfadeMs = ms; }

  /** Simple fade-out used for crossfade/sleep timer — no fake gapless claims. */
  fadeOutAndPause(durationMs = 800): Promise<void> {
    return new Promise((resolve) => {
      const start = this.audio.volume;
      const steps = 16;
      let i = 0;
      if (this.fadeTimer) clearInterval(this.fadeTimer);
      this.fadeTimer = setInterval(() => {
        i++;
        this.audio.volume = Math.max(0, start * (1 - i / steps));
        if (i >= steps) {
          if (this.fadeTimer) clearInterval(this.fadeTimer);
          this.pause();
          this.audio.volume = start;
          resolve();
        }
      }, Math.max(16, durationMs / steps));
    });
  }

  get positionMs(): number { return this.audio.currentTime * 1000; }
  get durationMs(): number { return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0; }
  get volume(): number { return this.audio.volume; }

  /**
   * True when the element can produce audible output right now: unmuted and
   * volume above zero. UI state must never claim "Playing" while this is
   * false without telling the user why.
   */
  isAudible(): boolean {
    try {
      return this.audio.muted === false && this.audio.volume > 0;
    } catch {
      return false;
    }
  }

  /**
   * Full pipeline snapshot for §1A/§1C diagnostics (element state, buffering,
   * output routing). Safe to log: contains no URLs, tokens, or content.
   */
  getDiagnostics(): AudioDiagnostics {
    let src = '';
    let currentSrc = '';
    try {
      src = this.audio.src || '';
      currentSrc = this.audio.currentSrc || '';
    } catch { /* element unavailable */ }
    let bufferedMs = 0;
    try {
      const b = this.audio.buffered;
      for (let i = 0; i < b.length; i++) {
        bufferedMs += Math.max(0, (b.end(i) - b.start(i)) * 1000);
      }
    } catch { /* buffered unavailable pre-metadata */ }
    return {
      hasSrc: src.length > 0 || currentSrc.length > 0,
      srcHost: scrubSrc(currentSrc || src),
      readyState: safeNum(() => this.audio.readyState),
      networkState: safeNum(() => this.audio.networkState),
      paused: safeBool(() => this.audio.paused, true),
      ended: safeBool(() => this.audio.ended, false),
      muted: safeBool(() => this.audio.muted, false),
      volume: safeVolume(this.audio),
      playbackRate: safeNum(() => this.audio.playbackRate, 1),
      durationMs: this.durationMs,
      positionMs: this.positionMs,
      bufferedMs: Math.round(bufferedMs),
      errorCode: mediaErrorCode(this.audio),
      audible: this.isAudible(),
    };
  }

  /**
   * Per-generation source snapshot for root-cause diagnostics (PHASE 7).
   * After every source assignment the store logs this: generation, track,
   * kind, element state, clock, routing, MediaError, detach confirmation,
   * and the full event sequence for this generation. Safe to log: scrubbed
   * host only, never URLs, tokens, or content.
   */
  getSourceDiagnostics(): SourceDiagnostics {
    const d = this.getDiagnostics();
    const err = this.getMediaError();
    return {
      generation: this.owned ? this.owned.generation : null,
      trackId: this.owned ? this.owned.trackId : null,
      sourceKind: this.owned ? this.owned.kind : null,
      hasSrc: d.hasSrc,
      srcHost: d.srcHost,
      readyState: d.readyState,
      networkState: d.networkState,
      paused: d.paused,
      ended: d.ended,
      currentTimeMs: Math.round(d.positionMs),
      durationMs: Math.round(d.durationMs),
      muted: d.muted,
      volume: d.volume,
      errorCode: d.errorCode,
      errorMessage: err ? err.name : null,
      detachedConfirmed: this.lastDetachConfirmed,
      eventTrail: this.getEventTrail(),
    };
  }

  /**
   * Compact media event trail (§8): ordered event names since the last
   * load() — e.g. ['loadstart','loadedmetadata','canplay','play','playing'].
   * A failing track typically stops early (e.g. loadstart>error) or stalls
   * at waiting/stalled with no progress. Names only, safe to log.
   */
  getEventTrail(): string[] {
    return [...this.eventTrail];
  }

  /** Clear the trail without touching playback (tests/diagnostics). */
  clearEventTrail(): void {
    this.eventTrail = [];
  }

  /** Buffered ranges in ms (§1, §8) — empty before any bytes arrive. */
  getBufferedRanges(): { startMs: number; endMs: number }[] {
    try {
      const b = this.audio.buffered;
      const out: { startMs: number; endMs: number }[] = [];
      for (let i = 0; i < b.length; i++) {
        out.push({ startMs: Math.round(b.start(i) * 1000), endMs: Math.round(b.end(i) * 1000) });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Honest MediaError view (§9): null when no error, otherwise the spec code
   * plus its name (MEDIA_ERR_NETWORK / DECODE / SRC_NOT_SUPPORTED / ABORTED).
   */
  getMediaError(): { code: number; name: string } | null {
    const code = mediaErrorCode(this.audio);
    if (code === null) return null;
    return { code, name: mediaErrorName(code) };
  }

  /** True only when the platform exposes per-device routing (e.g. Chromium setSinkId). */
  supportsOutputSelection(): boolean {
    return typeof (this.audio as HTMLAudioElement & { setSinkId?: unknown }).setSinkId === 'function';
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const el = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== 'function') throw new Error('Output selection not supported on this platform');
    await el.setSinkId(deviceId);
  }

  async listOutputDevices(): Promise<{ deviceId: string; label: string }[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Audio output' }));
    } catch { return []; }
  }

  setMediaSession(meta: { title: string; artist: string; album: string; artwork?: string }) {
    try {
      if (!('mediaSession' in navigator)) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title, artist: meta.artist, album: meta.album,
        artwork: meta.artwork ? [{ src: meta.artwork, sizes: '512x512', type: 'image/png' }] : [],
      });
    } catch { /* unsupported */ }
  }

  destroy() {
    this.pause();
    this.listeners.clear();
    this.posListeners.clear();
  }
}

let engine: AudioEngine | null = null;
export function getAudioEngine(): AudioEngine {
  if (!engine) engine = new AudioEngine();
  return engine;
}
