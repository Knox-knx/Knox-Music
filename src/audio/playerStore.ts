import { create } from 'zustand';
import type { PlayerState, RepeatMode } from '../core/states';
import type { Song } from '../core/types';
import { getAudioEngine } from './AudioEngine';
import { historyRepo, offlineRepo } from '../data/repositories';
import { getProviderManager } from '../providers/ProviderManager';
import { findEquivalents } from '../providers/merge';
import { isPreviewSong, previewDurationFor } from '../providers/capabilities';
import type { RadioStation } from '../providers/radio/types';
import { getRadioProvider, stationToSong } from '../providers/radio/radioBrowser';
import { safeUrlOrUndefined } from '../core/utils';
import { logger } from '../core/logger';
import {
  fetchBytesForCache,
  lookupCacheTrack,
  storeCacheTrack,
  touchCacheTrack,
} from '../cache/cachePlayback';
import {
  isSmartCacheEnabled,
  smartCacheLimits,
  SMART_CACHE_LOG,
} from '../cache/smartCache';
import {
  cancelSmartCacheAutoClear,
  handleSmartCacheNaturalEnded,
} from '../cache/smartCacheAutoClear';
import { isDirectPlaybackDebugEnabled } from './debugFlags';
import * as autoPlayManager from '../autoplay/autoPlayManager';
import { useSettings } from '../settings/settingsStore';
import {
  classifyMediaError,
  classifyPlaybackFailure,
  classifyResolveError,
  friendlyPlaybackMessage,
  probeMediaUrl,
  validateStreamCandidate,
} from './mediaDiagnostics';
import { printPlaybackFailure, printPlaybackStage } from './playbackDebug';

/** Track vs live-radio playback. One store, one AudioEngine, one element. */
export type PlayerMode = 'track' | 'radio';

interface PlayerStore {
  queue: Song[];
  index: number;
  state: PlayerState;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  rate: number;
  sleepTimerEndsAt: number | null;
  current: Song | null;
  qualityLabel: string | null;
  offlineMode: boolean;
  error: string | null;
  /**
   * True after a preview-only track reached its natural
   * end. Distinct from full-track COMPLETED: the queue is NOT consumed and
   * the UI shows a "Preview ended" state. Cleared on the next playSong().
   */
  previewEnded: boolean;
  /**
   * 'track' = normal song playback, 'radio' = live station. Radio shares the
   * same AudioEngine/element; progress UI shows LIVE (never fake duration).
   */
  playerMode: PlayerMode;
  currentStation: RadioStation | null;
  /**
   * Id of the track currently being resolved (fresh getStream() in flight).
   * UI shows "Preparing track..." while non-null. Never triggers navigation.
   */
  preparingTrackId: string | null;
  /**
   * Subtle autoplay notice ("Autoplay • Title — Artist") shown after an
   * automatic transition. Non-blocking; auto-clears after a few seconds.
   * Null when the last transition was manual.
   */
  autoplayNotice: string | null;

  playSongs: (songs: Song[], startIndex?: number) => Promise<boolean>;
  playSong: (song: Song, queue?: Song[]) => Promise<boolean>;
  /** Switch to live radio. Resolves the stream first — failure keeps the previous track state untouched. */
  playStation: (station: RadioStation) => Promise<void>;
  /** Leave radio mode and pause (queue and library state are preserved). */
  stopRadio: () => void;
  toggle: () => Promise<void>;
  next: (auto?: boolean) => Promise<void>;
  prev: () => Promise<void>;
  seek: (ms: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setShuffle: (s: boolean) => void;
  setRepeat: (r: RepeatMode) => void;
  /** Persisted AutoPlay ON/OFF (Settings → Playback). Reads/writes settingsStore. */
  setAutoplay: (on: boolean) => void;
  /** Pull persisted autoplay/repeat into the player (boot + engine hydrate). */
  syncPlaybackSettings: () => void;
  /** Dismiss the subtle autoplay notice. */
  dismissAutoplayNotice: () => void;
  setRate: (r: number) => void;
  setSleepTimer: (minutes: number | null | 'song') => void;
  addToQueue: (song: Song, playNext?: boolean) => void;
  removeFromQueue: (songId: string) => void;
  clearQueue: () => void;
  reorderQueue: (from: number, to: number) => void;
  setOfflineMode: (off: boolean) => void;
  hydrateFromEngine: () => void;
}

/**
 * Fresh provider stream for one playback (CACHE MISS path).
 * Smart Cache lookup happens separately in prepareCacheSource: a HIT never
 * reaches the network, a MISS downloads exactly this URL once, validates
 * it, and commits it.
 */
interface ResolvedPlayback {
  url: string;
  quality: string;
  fallbackUsed?: boolean;
  previewOnly: boolean;
  previewDurationMs: number;
  /** True when the source is already local (offline copy / local file). */
  alreadyLocal: boolean;
  mimeType?: string;
}

async function resolvePlayableUrl(
  song: Song,
  onFallback?: (message: string) => void,
): Promise<ResolvedPlayback> {
  const previewFallback = { previewOnly: isPreviewSong(song), previewDurationMs: previewDurationFor(song) };
  // 1. Explicit offline copy wins (user-owned / explicitly saved)
  const off = await offlineRepo.get(song.id).catch(() => undefined);
  if (off) return { url: offlineRepo.objectUrl(song.id, off.blob), quality: `${off.quality} · Offline`, alreadyLocal: true, mimeType: off.mimeType, ...previewFallback };
  // 2. Local file reference
  if (song.streamUrl && (song.isLocalFile || song.streamUrl.startsWith('blob:'))) {
    return { url: song.streamUrl, quality: 'Original file', alreadyLocal: true, ...previewFallback };
  }
  // 3. Provider stream — ALWAYS a fresh getStream() per cache MISS.
  // Smart Cache sits between the provider and the element (see
  // prepareCacheSource); this function only resolves the fresh URL.
  const pm = getProviderManager();
  const provider = pm.get(song.providerId);
  if (!provider || !provider.capabilities.supportsStreaming) throw new Error('Streaming not supported for this source');
  try {
    const stream = await provider.getStream(song);
    const safe = safeUrlOrUndefined(stream.url);
    if (!safe) throw new Error('Provider returned an unsafe audio URL');
    const streamSaysPreview = stream.previewOnly === true || stream.streamType === 'preview';
    const previewOnly = streamSaysPreview || isPreviewSong(song);
    return {
      url: safe,
      quality: stream.quality,
      previewOnly,
      previewDurationMs: stream.previewDurationMs ?? previewDurationFor(song),
      alreadyLocal: false,
      mimeType: stream.mimeType,
    };
  } catch (firstError) {
    // 4. Stream fallback: look for the same song on another provider.
    onFallback?.('Playback source unavailable — trying another source...');
    logger.warn('player', `stream failed for ${song.providerId}, seeking fallback`, String(firstError));
    try {
      const { items } = await pm.searchAll(`${song.title} ${song.artist}`.trim(), 'songs');
      const candidates = findEquivalents(song, items as Song[]).filter(
        (c) => c.providerId !== song.providerId,
      );
      candidates.sort((a, b) => Number(Boolean(b.artworkUrl)) - Number(Boolean(a.artworkUrl)));
      for (const cand of candidates.slice(0, 5)) {
        const p = pm.get(cand.providerId);
        if (!p?.capabilities.supportsStreaming) continue;
        try {
          const stream = await p.getStream(cand);
          const safe = safeUrlOrUndefined(stream.url);
          if (safe) {
            logger.info('player', `fallback to ${cand.providerId} for ${song.title}`);
            const streamSaysPreview = stream.previewOnly === true || stream.streamType === 'preview';
            return {
              url: safe,
              quality: `${stream.quality} · via ${cand.providerId}`,
              fallbackUsed: true,
              previewOnly: streamSaysPreview || isPreviewSong(cand) || isPreviewSong(song),
              previewDurationMs: stream.previewDurationMs ?? previewDurationFor(cand),
              alreadyLocal: false,
              mimeType: stream.mimeType,
            };
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Fallback search itself failed — fall through to the original error.
    }
    throw firstError instanceof Error ? firstError : new Error('Playback failed');
  }
}

/**
 * Stall watchdog (§10, §1F): how long the clock may sit still while the store
 * claims PLAYING before the state is honestly relabeled BUFFERING. The next
 * real engine event (playing/error/pause/ended) always corrects it again —
 * this never fights the element, it only refuses to display a frozen
 * "Playing" as if audio were flowing.
 */
export const PLAYBACK_STALL_MS = 6000;

let lastAdvanceAt = 0;
let lastAdvancePos = -1;
let stallReportedFor: string | null = null;
/** Timer-based watchdog handle (independent of timeupdate ticks). */
let stallTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Pure stall predicate (exported for tests): true when the position has not
 * advanced for longer than PLAYBACK_STALL_MS.
 */
export function isPlaybackStalled(lastAdvance: number, now: number): boolean {
  return now - lastAdvance > PLAYBACK_STALL_MS;
}

/**
 * Record clock progress (shared by the timeupdate path and the timer path).
 * Uses audio.currentTime as the authoritative media clock (§10) — never
 * React state increments or timers as proof that audio is playing.
 */
function noteClockAdvance(pos: number, trackId: string | null): void {
  if (Math.abs(pos - lastAdvancePos) >= 250) {
    lastAdvancePos = pos;
    lastAdvanceAt = Date.now();
    if (trackId && stallReportedFor === trackId) stallReportedFor = null;
  }
}

/**
 * Timer tick (§10): PLAYING with a frozen media clock is not playing.
 * Relabels to BUFFERING once per track when currentTime stops advancing.
 * Radio (live, no clock) excluded. Runs independently of timeupdate so a
 * fully-frozen clock (no events at all) is still caught. The tick only
 * relabels honestly — it never retries, heals, or touches cache rows (the
 * playSong failure path owns the single fresh retry).
 */
function stallTimerTick(): void {
  try {
    const st = usePlayer.getState();
    if (st.playerMode !== 'track' || st.state !== 'PLAYING' || !st.current) return;
    const engine = getAudioEngine();
    const pos = engine.positionMs;
    const dur = engine.durationMs || st.durationMs;
    if (!(dur > 0)) return;
    if (Math.abs(pos - lastAdvancePos) >= 250) {
      noteClockAdvance(pos, st.current.id);
      return;
    }
    if (
      lastAdvanceAt > 0 &&
      isPlaybackStalled(lastAdvanceAt, Date.now()) &&
      stallReportedFor !== st.current.id
    ) {
      stallReportedFor = st.current.id;
      logger.warn('player', 'playback stalled (PLAYING without clock advance)', engine.getDiagnostics());
      usePlayer.setState({ state: 'BUFFERING' });
    }
  } catch { /* watchdog never breaks playback */ }
}

function ensureStallTimer(): void {
  if (stallTimer !== null) return;
  try {
    stallTimer = setInterval(stallTimerTick, 1000);
    (stallTimer as unknown as { unref?: () => void }).unref?.();
  } catch { /* timer is best-effort */ }
}

/** Reset stall tracking for a new track (exported for tests). */
export function resetStallTracking(): void {
  lastAdvanceAt = Date.now();
  lastAdvancePos = 0;
  stallReportedFor = null;
}

/** Test seam: run one watchdog tick synchronously (exported for tests). */
export function __stallTickForTests(): void {
  stallTimerTick();
}

/** Test seam: seed stall internals deterministically (exported for tests). */
export function __setStallStateForTests(pos: number, at: number, reportedFor: string | null): void {
  lastAdvancePos = pos;
  lastAdvanceAt = at;
  stallReportedFor = reportedFor;
}

/** Best-effort provider display name for classified errors (never throws). */
function providerLabelFor(providerId: string): string {
  try {
    return getProviderManager().get(providerId)?.name ?? providerId;
  } catch {
    return providerId;
  }
}

/**
 * Classified resolve-failure message: honest category plus the raw cause
 * for diagnostics. Always contains the category wording — never a fake
 * "Playing", never a stack trace.
 */
function resolveFailureMessage(e: unknown, providerId: string): string {
  const label = providerLabelFor(providerId);
  const raw = e instanceof Error ? e.message : String(e ?? 'Playback failed');
  // Stage-classified UI sentence + preserved raw cause for diagnostics.
  // Never a bare generic message: the code prefix names the failing stage.
  const classified = classifyPlaybackFailure(e, providerId === 'airbeats');
  return `[${classified.code}] ${classified.ui} (${label}: ${raw})`.slice(0, 500);
}

/**
 * Re-assert the store's output routing on the element and verify it stuck.
 * Returns true when the element can produce audible output (or the user
 * explicitly muted). Never throws; a stuck-muted element sets a useful
 * store error instead of a silent fake "Playing".
 */
function verifyAudibleOutput(volume: number, muted: boolean, onError: (msg: string) => void): boolean {
  try {
    const engine = getAudioEngine();
    engine.setVolume(volume);
    engine.setMuted(muted);
    const diag = engine.getDiagnostics();
    if (!diag.audible && !muted) {
      logger.error('player', 'Audio output not audible after play (muted or zero volume)', diag);
      onError('Audio playback failed — output is muted. Check the volume and system mixer.');
      return false;
    }
    return true;
  } catch (e) {
    logger.error('player', 'Audio output verification failed', String(e));
    return true;
  }
}

/** Set once hydrateFromEngine attaches engine listeners (see guard inside). */
let engineHydrated = false;

/**
 * Playback generation: every playSong entry takes a new id; async steps that
 * arrive after a track change (next/prev/new play) are discarded. Ensures at
 * most ONE fresh retry per track (attempt → fresh retry → final).
 */
let playGeneration = 0;
/** Offline blob URLs created by resolvePlayableUrl (owned here, revoked after detach). */
let activeOfflineUrl: string | null = null;
function trackOfflineUrl(url: string | null): void {
  activeOfflineUrl = url;
}
function releaseOfflineUrl(): void {
  if (!activeOfflineUrl) return;
  const url = activeOfflineUrl;
  activeOfflineUrl = null;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* best-effort */
  }
}

/**
 * Detach the old source and revoke the old Smart Cache object URL BEFORE a
 * new playback. Order is load-bearing: pause → detach (engine) → confirm →
 * revoke via the OWNING generation's revoker. Stale callers (older
 * generation than the assigned source) are refused by the engine.
 *
 * Smart Cache ROWS are persistent and are never deleted here — only the
 * in-memory object URL for the previous playback is revoked. All steps
 * are idempotent.
 */
let activeCacheUrl: string | null = null;

function trackCacheUrl(url: string | null): void {
  activeCacheUrl = url;
}

function releaseCacheUrl(): void {
  if (!activeCacheUrl) return;
  const url = activeCacheUrl;
  activeCacheUrl = null;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* best-effort */
  }
}

async function teardownCurrentCacheSource(generation: number): Promise<void> {
  try {
    await getAudioEngine().releaseCurrentSource(generation);
  } catch {
    /* detach is best-effort */
  }
  // The engine runs the owning generation's revoker on release (which
  // revokes the previous cache object URL). Belt-and-braces for URLs the
  // engine never owned (e.g. mocked assigns in tests).
  releaseCacheUrl();
  releaseOfflineUrl();
}

/** Test seams: inspect/reset cache-playback state. */
export function __getCachePlaybackStateForTests(): {
  activeCacheTrackId: string | null;
  activeCacheUrl: string | null;
  generation: number;
} {
  return {
    activeCacheTrackId: getAudioEngine().getOwnedSource()?.trackId ?? null,
    activeCacheUrl,
    generation: playGeneration,
  };
}

export function __resetCachePlaybackForTests(): void {
  releaseCacheUrl();
  releaseOfflineUrl();
}

function nextPlayGeneration(): number {
  playGeneration += 1;
  return playGeneration;
}

function currentPlayGeneration(): number {
  return playGeneration;
}

/**
 * Source selected for one playback attempt:
 *  - 'direct' — provider URL straight to the element (dev bypass, no cache)
 *  - 'cache'  — Smart Cache bytes (hit) or freshly downloaded + committed
 *    bytes (miss) exposed through a per-playback object URL.
 */
type PreparedSourceKind = 'direct' | 'cache';

export type CacheProvenance = 'HIT' | 'MISS' | 'INVALID' | 'DISABLED' | 'DIRECT';

interface PreparedSource {
  kind: PreparedSourceKind;
  /** URL to assign to the element (object URL for cache, provider URL for direct). */
  url: string;
  /** Cache tag (`cache:<trackId>`), or `direct-<generation>` for the bypass. */
  sessionId: string;
  mimeType?: string;
  container?: string;
  extension?: string;
  bytes?: number;
  /** Smart Cache provenance for this attempt (diagnostics). */
  cache: CacheProvenance;
  /** Owner revoker for the engine assignment (runs only after detach). */
  revoker: ((url: string) => void) | null;
  /** Release a superseded/failed source (revoke its object URL). */
  dispose: () => Promise<void>;
}

/**
 * Advisory diagnostic probe of the exact provider URL (PHASE 10): status,
 * content-type, length, range support, final URL, first bytes. Scrubbed —
 * never logs the URL, keys, or signatures. Non-blocking; unknown on CORS.
 */
export async function debugProbeProviderUrl(url: string): Promise<void> {
  try {
    const probe = await probeMediaUrl(url, { timeoutMs: 8000 });
    if (probe.status === 'unknown') {
      logger.info('player', 'PROVIDER_URL_PROBE unknown (cors-or-timeout)');
      return;
    }
    const h = probe.headers;
    logger.info('player', `PROVIDER_URL_PROBE ${probe.status}`, {
      probeStatus: probe.status,
      reason: probe.status === 'invalid' ? probe.reason : undefined,
      httpStatus: h.status,
      contentType: h.contentType ?? null,
      contentLength: h.contentLength,
      acceptRanges: h.acceptRanges ?? null,
      contentRange: h.contentRange ?? null,
      redirected: h.redirected === true,
    });
  } catch {
    /* diagnostics never break playback */
  }
}

/**
 * Build the playable source for one attempt through Smart Cache.
 * Direct-debug bypasses the cache entirely; otherwise:
 *   HIT  — validated cached bytes → fresh object URL → play.
 *   MISS — download fresh provider bytes → validate → commit → play.
 * A failed cache COMMIT never fails playback (memory bytes still play).
 * Never throws without disposing what it created (except via dispose()).
 */
async function prepareCacheSource(
  marked: Song,
  attemptUrl: string,
  attemptMime: string | undefined,
  attemptQuality: string | undefined,
  generation: number,
  signal?: AbortSignal,
): Promise<PreparedSource> {
  // PATH A (diagnostic): direct provider URL, no cache involved.
  if (isDirectPlaybackDebugEnabled()) {
    logger.info('player', `DIRECT_PLAYBACK_DEBUG gen=${generation} track=${marked.id} (cache bypassed)`);
    void debugProbeProviderUrl(attemptUrl);
    return {
      kind: 'direct',
      url: attemptUrl,
      sessionId: `direct-${generation}`,
      mimeType: attemptMime,
      cache: 'DIRECT',
      revoker: null,
      dispose: async () => undefined,
    };
  }
  const makeSource = (
    bytes: Uint8Array,
    mimeType: string,
    container: string,
    provenance: CacheProvenance,
  ): PreparedSource => {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const tag = `cache:${marked.id.slice(0, 24)}`;
    const revoker = (assigned: string) => {
      // Owner-only revoker: runs after the element detached.
      try {
        if (assigned === objectUrl) URL.revokeObjectURL(objectUrl);
      } catch {
        /* best-effort */
      }
      if (activeCacheUrl === objectUrl) trackCacheUrl(null);
    };
    return {
      kind: 'cache',
      url: objectUrl,
      sessionId: tag,
      mimeType,
      container,
      bytes: bytes.byteLength,
      cache: provenance,
      revoker,
      dispose: async () => revoker(objectUrl),
    };
  };

  // PATH B: Smart Cache lookup (validated on every hit).
  if (isSmartCacheEnabled()) {
    const lookup = await lookupCacheTrack(marked.id);
    if (lookup.status === 'hit') {
      const e = lookup.entry;
      logger.info('player', `${SMART_CACHE_LOG.HIT} gen=${generation} track=${marked.id} bytes=${e.fileSize}`);
      void touchCacheTrack(marked.id);
      // Replay cancels any pending delayed auto-clear deadline: the track is
      // playing again, so it must not be swept while audible. Best-effort.
      try {
        await cancelSmartCacheAutoClear(marked.id);
      } catch {
        /* cancel is best-effort */
      }
      return makeSource(e.data, e.mimeType, e.format, 'HIT');
    }
    if (lookup.status === 'invalid') {
      logger.warn('player', `${SMART_CACHE_LOG.INVALID} gen=${generation} track=${marked.id} (${lookup.reason}) — refetching`);
    }
  } else {
    logger.debug('player', `${SMART_CACHE_LOG.DISABLED} gen=${generation} track=${marked.id}`);
  }

  // PATH C: cache MISS (or disabled) — fresh provider bytes, then commit.
  const fetched = await fetchBytesForCache(attemptUrl, {
    signal,
    sourceMimeType: attemptMime,
  });
  const provenance: CacheProvenance = isSmartCacheEnabled() ? 'MISS' : 'DISABLED';
  if (isSmartCacheEnabled()) {
    const limits = smartCacheLimits();
    const outcome = await storeCacheTrack(marked, fetched, {
      quality: attemptQuality,
      maxBytes: limits.maxBytes,
      ttlDays: limits.ttlDays,
    });
    logger.info(
      'player',
      outcome.committed
        ? `${SMART_CACHE_LOG.COMPLETE} gen=${generation} track=${marked.id} bytes=${fetched.bytes.byteLength}`
        : `${SMART_CACHE_LOG.WRITE_FAILED} gen=${generation} track=${marked.id} (playing from memory)`,
    );
    void touchCacheTrack(marked.id);
  }
  return makeSource(fetched.bytes, fetched.mimeType, fetched.container, provenance);
}
/**
 * Scrubbed per-session playback log (never URLs, keys, cookies, tokens).
 * Emits the development diagnostics trail: generation, source kind,
 * session, provider, MIME, container, ext, bytes, duration, clock,
 * readyState/networkState/MediaError.
 */
function logPlaybackEvent(
  event: 'PLAY_STARTED' | 'CLOCK_ADVANCING' | 'PAUSED' | 'ENDED' | 'TEMP_FILE_DELETED' | 'LOAD_STARTED' | 'CAN_PLAY' | 'LOADED_METADATA',
  song: Song,
  extra?: {
    sessionId?: string;
    mimeType?: string;
    container?: string;
    extension?: string;
    bytes?: number;
    sourceKind?: PreparedSourceKind;
    generation?: number;
  },
): void {
  try {
    const engine = getAudioEngine();
    const d = engine.getDiagnostics();
    const err = engine.getMediaError();
    logger.info('player', event, {
      trackId: song.id,
      provider: song.providerId,
      generation: extra?.generation ?? null,
      sourceKind: extra?.sourceKind ?? null,
      sessionId: extra?.sessionId?.slice(0, 8) ?? null,
      mime: extra?.mimeType ?? null,
      container: extra?.container ?? null,
      ext: extra?.extension ?? null,
      bytes: extra?.bytes ?? null,
      durationMs: Math.round(d.durationMs),
      currentTimeMs: Math.round(d.positionMs),
      readyState: d.readyState,
      networkState: d.networkState,
      mediaError: err ? `${err.name}(${err.code})` : null,
    });
  } catch {
    /* diagnostics never break playback */
  }
}

/**
 * Full element source snapshot after every assignment (PHASE 7): the
 * engine's per-generation diagnostics (state, clock, routing, error, event
 * sequence) under one log tag. Safe: scrubbed host only.
 */
function logSourceDiagnostics(tag: string, song: Song): void {
  try {
    const d = getAudioEngine().getSourceDiagnostics();
    logger.info('player', tag, {
      trackId: song.id,
      provider: song.providerId,
      generation: d.generation,
      sourceKind: d.sourceKind,
      hasSrc: d.hasSrc,
      srcHost: d.srcHost,
      readyState: d.readyState,
      networkState: d.networkState,
      paused: d.paused,
      ended: d.ended,
      currentTimeMs: d.currentTimeMs,
      durationMs: d.durationMs,
      muted: d.muted,
      volume: d.volume,
      errorCode: d.errorCode,
      errorMessage: d.errorMessage,
      detachedConfirmed: d.detachedConfirmed,
      trail: d.eventTrail.join('>'),
    });
  } catch {
    /* diagnostics never break playback */
  }
}

export const usePlayer = create<PlayerStore>((set, get) => ({
  queue: [],
  index: -1,
  state: 'IDLE',
  positionMs: 0,
  durationMs: 0,
  volume: 0.9,
  muted: false,
  shuffle: false,
  repeat: 'OFF',
  rate: 1,
  sleepTimerEndsAt: null,
  current: null,
  qualityLabel: null,
  offlineMode: false,
  error: null,
  previewEnded: false,
  playerMode: 'track',
  currentStation: null,
  preparingTrackId: null,
  autoplayNotice: null,

  hydrateFromEngine: () => {
    const engine = getAudioEngine();
    try { get().syncPlaybackSettings(); } catch { /* best-effort */ }
    if (engineHydrated) {
      try {
        engine.setVolume(get().volume);
        engine.setMuted(get().muted);
      } catch { /* best-effort */ }
      return;
    }
    engineHydrated = true;
    ensureStallTimer();
    engine.onState((s) => {
      set({ state: s });
      if (s === 'COMPLETED') {
        if (get().playerMode === 'radio') return;
        // Smart Cache auto-clear: ONLY genuine natural "ended" removes or
        // schedules the entry (verified inside against the existing
        // AudioEngine generation/ownership + element ended flag). Pause,
        // manual skip, and playback errors never reach here, and stale
        // A→B→A ended events are ignored. Radio already returned above.
        // Runs BEFORE the element detach below so verification still sees
        // the owned source + ended flag; row deletion itself never revokes
        // the in-memory playback URL (revocation stays in the detach), so
        // playback cannot go silent. Preview ends are also cleared.
        try {
          const finishedForClear = get().current;
          if (finishedForClear) {
            const genForClear = currentPlayGeneration();
            const modeForClear = get().playerMode;
            void handleSmartCacheNaturalEnded({
              trackId: finishedForClear.id,
              generation: genForClear,
              playerMode: modeForClear,
            }).catch(() => undefined);
          }
        } catch {
          /* auto-clear never breaks transitions */
        }
        if (get().current && isPreviewSong(get().current!)) {
          set({ previewEnded: true });
          return;
        }
        // Track finished → detach the element source and revoke its
        // object URL (cleanup guarantee). Smart Cache ROWS persist —
        // only the in-memory playback URL is released. The next track
        // (if any) resolves through Smart Cache again (HIT).
        // Ownership guard: a stale 'ended' from a previous source (fired
        // before a track change detached it) must not release the NEW
        // track's source — compare owned track with current first.
        try {
          const finished = get().current;
          const ownedTrack = getAudioEngine().getOwnedSource()?.trackId ?? null;
          if (finished && ownedTrack !== null && ownedTrack !== finished.id) {
            logger.warn('player', 'stale ended event ignored (element already on a newer track)');
          } else {
            void getAudioEngine().releaseCurrentSource(currentPlayGeneration()).catch(() => undefined);
            releaseCacheUrl();
            releaseOfflineUrl();
            if (finished) logPlaybackEvent('ENDED', finished);
          }
        } catch { /* cleanup never breaks transitions */ }
        if (!autoPlayManager.tryAcquireTransition()) return;
        void get().next(true).finally(() => autoPlayManager.releaseTransition());
      }
      if (s === 'ERROR') {
        try {
          const cur = get().current;
          const code = getAudioEngine().getMediaError()?.code ?? null;
          const kind = code !== null ? classifyMediaError(code) : classifyResolveError(get().error);
          const label = cur ? providerLabelFor(cur.providerId) : undefined;
          const friendly = friendlyPlaybackMessage(kind, label);
          if (!get().error) set({ error: friendly });
          else if (kind === 'unsupported-format' || kind === 'decode-failure') {
            set({ error: friendly });
          }
          logger.error('player', `playback element error (${kind})`, getAudioEngine().getDiagnostics());
        } catch { /* error classification never breaks state */ }
        try {
          const st = get();
          if (
            st.playerMode === 'track' &&
            st.current?.queueSource === 'autoplay' &&
            autoPlayManager.isAutoplayEnabled() &&
            autoPlayManager.shouldAutoplayForMode(st.playerMode)
          ) {
            if (!autoPlayManager.tryAcquireTransition()) return;
            void get().next(true).finally(() => autoPlayManager.releaseTransition());
          }
        } catch { /* autoplay advance never breaks error state */ }
      }
    });
    engine.onPosition((pos, dur) => {
      const cur = get().current;
      const preview = isPreviewSong(cur);
      const fallback = cur ? (preview ? previewDurationFor(cur) : cur.durationMs || 0) : 0;
      const resolvedDur = dur || fallback;
      const prevPos = get().positionMs;
      const prevDur = get().durationMs;
      if (Math.abs(pos - prevPos) >= 250 || resolvedDur !== prevDur) {
        set({ positionMs: pos, durationMs: resolvedDur });
      }
      const { sleepTimerEndsAt } = get();
      if (sleepTimerEndsAt && Date.now() >= sleepTimerEndsAt) {
        void engine.fadeOutAndPause();
        set({ sleepTimerEndsAt: null });
      }
      try {
        const st = get();
        if (st.playerMode === 'track' && st.state === 'PLAYING' && st.current && resolvedDur > 0) {
          if (Math.abs(pos - lastAdvancePos) >= 250) {
            noteClockAdvance(pos, st.current.id);
          } else if (
            lastAdvanceAt > 0 &&
            isPlaybackStalled(lastAdvanceAt, Date.now()) &&
            stallReportedFor !== st.current.id
          ) {
            stallReportedFor = st.current.id;
            logger.warn('player', 'playback stalled (PLAYING without clock advance)', engine.getDiagnostics());
            set({ state: 'BUFFERING' });
          }
        }
      } catch { /* watchdog never breaks position updates */ }
      try {
        const st = get();
        if (
          cur &&
          st.playerMode === 'track' &&
          !preview &&
          resolvedDur > 0 &&
          autoPlayManager.isAutoplayEnabled()
        ) {
          const remaining = resolvedDur - pos;
          if (remaining > 0 && (remaining < 30_000 || (pos / resolvedDur > 0.8 && remaining < 60_000))) {
            autoPlayManager.prefetchFor(cur, st.queue);
          }
        }
      } catch { /* prefetch never breaks position updates */ }
    });
    engine.setVolume(get().volume);
  },

  playSongs: async (songs, startIndex = 0) => {
    if (songs.length === 0) return false;
    const manual = songs.map((s) => (s.queueSource ? s : { ...s, queueSource: 'manual' as const }));
    autoPlayManager.resetPrefetchFor(manual[startIndex]?.id ?? null);
    set({ queue: manual, index: startIndex, error: null, autoplayNotice: null });
    return get().playSong(manual[startIndex], manual);
  },

  playSong: async (song, queue) => {
    const engine = getAudioEngine();
    try {
      const pm0 = getProviderManager();
      const p0 = pm0.get(song.providerId);
      // Strict playability gate (Phase 4/5/19): web references stop BEFORE
      // provider.getStream(), with a clear error. Never pass a web page into
      // HTMLAudioElement. Checks BOTH provider-level and per-track signals:
      // - unregistered web-* ids are always references
      // - discovery-only providers (streaming=false) are references
      // - per-track streamable=false with no streamUrl/blob/local is a reference
      //   (even when the provider generally supports streaming, e.g. an
      //   AirBeats record without an authorized audio tier).
      const isWebId = song.providerId.startsWith('web-');
      const providerDiscoveryOnly = p0 ? p0.capabilities.supportsStreaming === false : song.capabilities?.streamable === false;
      const trackNotStreamable =
        song.capabilities?.streamable === false && !song.streamUrl && !song.isLocalFile && !song.isOfflineAvailable;
      const discoveryOnly = isWebId || providerDiscoveryOnly || trackNotStreamable;
      const hasLocalCopy = Boolean(
        song.isLocalFile || (song.streamUrl && song.streamUrl.startsWith('blob:')),
      );
      if (discoveryOnly && !hasLocalCopy) {
        const offlineHit = await offlineRepo.get(song.id).catch(() => undefined);
        if (!offlineHit) {
          const label = p0?.name ?? song.providerId;
          const msg =
            song.providerId === 'airbeats' && trackNotStreamable
              ? `AirBeats provided a web page rather than a playable audio source. (${label})`
              : isWebId || trackNotStreamable
                ? `This result is a web reference and does not provide authorized playback in KNOX Music. (${label})`
                : `Playback isn\u2019t available for this source (${label}). This result is for discovery only.`;
          set({ error: msg });
          logger.warn('player', `rejected discovery-only play (${song.providerId}:${song.providerTrackId})`);
          return false;
        }
      }
    } catch {
      /* guard is best-effort; resolvePlayableUrl still fails honestly below */
    }
    // New playback generation: async steps from a previous track can never
    // mutate this track's state. The engine records the claim so stale
    // downloads/callbacks/timers/cleanups cannot touch the element.
    // Every playback gets a FRESH object URL (never reused, even on HIT —
    // this defeats the stale-URL class outright).
    const generation = nextPlayGeneration();
    engine.claimGeneration(generation);
    set({ preparingTrackId: song.id, error: null });

    // Detach the old source + revoke its object URL BEFORE resolving the
    // new track (pause → detach → confirm → owner-revoke → reset).
    // Smart Cache rows persist; only playback URLs are released.
    await teardownCurrentCacheSource(generation);
    if (generation !== currentPlayGeneration()) return false;

    let resolved: ResolvedPlayback;
    try {
      resolved = await resolvePlayableUrl(song, (msg) => {
        if (generation === currentPlayGeneration()) set({ error: msg });
      });
    } catch (e) {
      if (generation !== currentPlayGeneration()) return false;
      set({ preparingTrackId: null, error: resolveFailureMessage(e, song.providerId) });
      logger.error('player', `Unable to play ${song.title} (${song.providerId})`, String(e));
      try {
        const eng = getAudioEngine();
        const diag = eng.getSourceDiagnostics();
        printPlaybackFailure(song, e, {
          stage: 'resolve',
          generation,
          validationReason: null,
          mediaError: diag.errorCode !== null ? `${diag.errorMessage}(${diag.errorCode})` : null,
          eventTrail: diag.eventTrail.join('>'),
          hint: 'getStream() failed — check provider reachability, search-time snapshot vs fresh detail, and logs/knox.log upstream status.',
        });
      } catch { /* diagnostics only */ }
      return false;
    }
    if (generation !== currentPlayGeneration()) return false;
    printPlaybackStage('RESOLVED', song, {
      gen: generation,
      mime: resolved.mimeType ?? 'none',
      quality: resolved.quality,
      alreadyLocal: resolved.alreadyLocal,
    });
    const preflight = validateStreamCandidate({ url: resolved.url, mimeType: resolved.mimeType });
    if (!preflight.ok) {
      const err = new Error(
        preflight.reason === 'invalid-mime' || preflight.reason === 'unsupported-mime'
          ? `Unsupported audio format (${preflight.reason})`
          : `Invalid audio source (${preflight.reason})`,
      );
      set({ preparingTrackId: null, error: resolveFailureMessage(err, song.providerId) });
      logger.error('player', `rejected invalid stream for ${song.title} (${preflight.reason})`);
      printPlaybackFailure(song, err, {
        stage: 'preflight',
        generation,
        mimeType: resolved.mimeType,
        validationReason: preflight.reason,
        hint: 'Pre-flight URL+MIME gate rejected the resolved URL before any download. If reason=unsafe-protocol the URL is not http(s)/blob/asset/tauri — check whether a web page leaked into streamUrl.',
      });
      return false;
    }
    const preview = resolved.previewOnly;
    const q = queue ?? get().queue;
    const marked = song.queueSource ? song : { ...song, queueSource: 'manual' as const };
    let idx = q.findIndex((s) => s.id === marked.id);
    let nextQueue = q;
    if (idx === -1) { nextQueue = [...q, marked]; idx = nextQueue.length - 1; }
    engine.prepareForTrack();
    engine.setPreviewMode(preview);
    autoPlayManager.resetPrefetchFor(marked.id);
    set({
      queue: nextQueue, index: idx, current: marked, error: null,
      positionMs: 0, previewEnded: false,
      playerMode: 'track', currentStation: null,
      durationMs: preview ? (resolved.previewDurationMs || previewDurationFor(marked)) : marked.durationMs,
      preparingTrackId: null,
      autoplayNotice: marked.queueSource === 'autoplay' ? get().autoplayNotice : null,
    });

    // Local sources (explicit offline copy / local file) play directly —
    // they are already local, so no temp download is created.
    if (resolved.alreadyLocal) {
      const isOfflineBlob = resolved.url.startsWith('blob:') && !marked.isLocalFile && !(marked.streamUrl && marked.streamUrl === resolved.url);
      if (isOfflineBlob) trackOfflineUrl(resolved.url);
      try {
        engine.setRate(get().rate);
        engine.setMediaSession({ title: marked.title, artist: marked.artist, album: marked.album, artwork: marked.artworkUrl });
        logPlaybackEvent('LOAD_STARTED', marked);
        await engine.playUrl(resolved.url);
        resetStallTracking();
        const audible = verifyAudibleOutput(get().volume, get().muted, (msg) => set({ error: msg }));
        set({
          durationMs: preview ? (resolved.previewDurationMs || previewDurationFor(marked)) : marked.durationMs,
          qualityLabel: resolved.quality, error: audible ? null : get().error,
        });
        logger.info('player', `playing ${marked.title}`, { quality: resolved.quality, preview });
        logPlaybackEvent('PLAY_STARTED', marked);
        void historyRepo.record(marked, 0).catch(() => undefined);
        if (marked.queueSource === 'autoplay') autoPlayManager.recordRecommendation(marked);
        return true;
      } catch (e) {
        set({ error: resolveFailureMessage(e, marked.providerId) });
        logger.error('player', `Unable to play ${marked.title}`, String(e));
        try {
          const eng = getAudioEngine();
          const diag = eng.getSourceDiagnostics();
          printPlaybackFailure(marked, e, {
            stage: 'local-play',
            generation,
            mediaError: diag.errorCode !== null ? `${diag.errorMessage}(${diag.errorCode})` : null,
            eventTrail: diag.eventTrail.join('>'),
            hint: 'Local/offline element play() rejected — check output device, mute, and MediaError code (4=SRC_NOT_SUPPORTED usually means missing GStreamer codec).',
          });
        } catch { /* diagnostics only */ }
        return false;
      }
    }

    // Provider stream → Smart Cache → AudioEngine.
    // One attempt + at most ONE fresh retry (invalidates the cache entry,
    // resolves a COMPLETELY fresh provider URL, rebuilds the cache).
    // No repair loops — a failed retry surfaces the actual failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (generation !== currentPlayGeneration() || get().current?.id !== marked.id) return false;
        // Per-attempt signal: a superseded/failed attempt aborts only its
        // own download without poisoning the retry.
        const aborter = new AbortController();
        let attemptUrl = resolved.url;
        let attemptMime = resolved.mimeType;
        let attemptQuality = resolved.quality;
        if (attempt === 1) {
          // Fresh retry: drop any poisoned cache entry, then resolve a
          // COMPLETELY fresh provider URL (never reuse bytes or element state).
          try {
            await teardownCurrentCacheSource(generation);
            if (generation !== currentPlayGeneration() || get().current?.id !== marked.id) return false;
            const { removeCacheEntry } = await import('../cache/cacheStorage');
            await removeCacheEntry(marked.id);
            const fresh = await resolvePlayableUrl(song);
            if (generation !== currentPlayGeneration() || get().current?.id !== marked.id) return false;
            const gate = validateStreamCandidate({ url: fresh.url, mimeType: fresh.mimeType });
            if (!gate.ok) throw new Error(`Invalid audio source (${gate.reason})`);
            attemptUrl = fresh.url;
            attemptMime = fresh.mimeType;
            attemptQuality = fresh.quality;
            logger.info('player', `${SMART_CACHE_LOG.FRESH_RETRY} fresh stream for ${marked.title}`);
          } catch (e) {
            if (generation !== currentPlayGeneration()) return false;
            set({ error: resolveFailureMessage(e, marked.providerId) });
            logger.error('player', `Unable to play ${marked.title} (fresh retry resolve failed)`, String(e));
            printPlaybackFailure(marked, e, {
              stage: 'resolve',
              attempt: 1,
              generation,
              hint: 'Fresh-retry getStream() failed — provider likely down or track has no authorized tier.',
            });
            return false;
          }
        }
        let source: PreparedSource | null = null;
        try {
          logPlaybackEvent('LOAD_STARTED', marked, { generation });
          printPlaybackStage('CACHE_PREPARE_START', marked, { gen: generation, attempt, mime: attemptMime ?? 'none' });
          source = await prepareCacheSource(marked, attemptUrl, attemptMime, attemptQuality, generation, aborter.signal);
          printPlaybackStage('CACHE_PREPARE_OK', marked, {
            gen: generation,
            attempt,
            kind: source.kind,
            cache: source.cache,
            mime: source.mimeType ?? 'none',
            bytes: source.bytes ?? 0,
          });
        if (generation !== currentPlayGeneration() || get().current?.id !== marked.id) {
          // Superseded while preparing — dispose ONLY this source.
          await source.dispose().catch(() => undefined);
          return false;
        }
        engine.setRate(get().rate);
        engine.setMediaSession({ title: marked.title, artist: marked.artist, album: marked.album, artwork: marked.artworkUrl });
        if (source.kind === 'cache') {
          // Smart Cache bytes through a per-playback object URL — the
          // owning revoker runs only after the element detaches.
          trackCacheUrl(source.url);
          await engine.loadTempSource(source.url, {
            sessionId: source.sessionId,
            trackId: marked.id,
            generation,
            revoker: source.revoker,
          });
        } else {
          // Direct-debug provider URL assigns through the same
          // generation-owned lifecycle — no bare src sets.
          await engine.assignSourceForGeneration(generation, source.url, {
            trackId: marked.id,
            kind: 'direct',
            revoker: source.revoker,
            sourceTag: `direct:${marked.providerId}`,
          });
        }
        if (generation !== currentPlayGeneration() || get().current?.id !== marked.id) {
          await source.dispose().catch(() => undefined);
          return false;
        }
        logPlaybackEvent('CAN_PLAY', marked, {
          generation,
          sourceKind: source.kind,
          sessionId: source.sessionId,
          mimeType: source.mimeType,
          container: source.container,
          bytes: source.bytes,
        });
        logSourceDiagnostics('SOURCE_ASSIGNED', marked);
        await engine.play();
        resetStallTracking();
        const audible = verifyAudibleOutput(get().volume, get().muted, (msg) => set({ error: msg }));
        set({
          durationMs: preview ? (resolved.previewDurationMs || previewDurationFor(marked)) : marked.durationMs,
          qualityLabel: source.kind === 'direct' ? `${attemptQuality} · Direct debug` : attemptQuality,
          error: audible ? null : get().error,
        });
        logger.info('player', `playing ${marked.title}`, {
          quality: attemptQuality,
          preview,
          sourceKind: source.kind,
          session: source.sessionId.slice(0, 8),
          mime: source.mimeType ?? null,
          container: source.container ?? null,
          bytes: source.bytes ?? null,
        });
        logPlaybackEvent('PLAY_STARTED', marked, {
          generation,
          sourceKind: source.kind,
          sessionId: source.sessionId,
          mimeType: source.mimeType,
          container: source.container,
          bytes: source.bytes,
        });
        logSourceDiagnostics('PLAY_STARTED_DIAG', marked);
        // PHASE 8: play() resolving is NOT success — the clock must advance.
        // A frozen clock after play() is classified as a playback failure
        // (honest ERROR, never a fake "Playing"). No auto-retry here
        // (PHASE 6): the failure is reported, the user retries explicitly.
        const clockGen = generation;
        const clockSession = source.sessionId;
        const clockKind = source.kind;
        void engine.awaitClockAdvance(6000).then((advancing) => {
          try {
            if (clockGen !== currentPlayGeneration() || get().current?.id !== marked.id) return;
            if (advancing) {
              logger.info('player', 'CLOCK_ADVANCING', {
                trackId: marked.id,
                generation: clockGen,
                sourceKind: clockKind,
                sessionId: clockSession.slice(0, 8),
              } as unknown as string);
              return;
            }
            const src = getAudioEngine().getSourceDiagnostics();
            logger.error('player', 'clock did not advance after play() — playback failure', {
              trackId: marked.id,
              generation: clockGen,
              sourceKind: clockKind,
              sessionId: clockSession.slice(0, 8),
              readyState: src.readyState,
              networkState: src.networkState,
              mediaError: src.errorCode !== null ? `${src.errorMessage}(${src.errorCode})` : null,
              trail: src.eventTrail.join('>'),
            } as unknown as string);
            printPlaybackFailure(marked, new Error('clock did not advance after play()'), {
              stage: 'clock',
              generation: clockGen,
              sourceKind: clockKind,
              sessionId: clockSession,
              mediaError: src.errorCode !== null ? `${src.errorMessage}(${src.errorCode})` : null,
              eventTrail: src.eventTrail.join('>'),
              hint: 'play() resolved but currentTime froze — classic missing-codec (MediaError 4) or NULL audio sink. Try a Jamendo MP3: if MP3 plays and AAC/MP4 does not, install GStreamer libav/ugly.',
            });
            // Escalate only while the element still claims PLAYING with a
            // frozen clock (BUFFERING stays recoverable via element events).
            if (get().state === 'PLAYING' && get().current?.id === marked.id) {
              set({ state: 'ERROR', error: 'Playback stalled — audio started but no sound clock advanced. Check the output device and try again.' });
            }
          } catch { /* diagnostics only */ }
        });
        void historyRepo.record(marked, 0).catch(() => undefined);
        if (marked.queueSource === 'autoplay') autoPlayManager.recordRecommendation(marked);
        return true;
      } catch (e) {
        // Release ONLY the failed source; never touch cache rows.
        // Engine release runs first (detach → owner-revoke), then dispose
        // sweeps anything the engine never owned. Both idempotent.
        if (source) {
          try {
            await getAudioEngine().releaseCurrentSource(generation).catch(() => undefined);
          } catch { /* best-effort */ }
          try {
            await source.dispose();
          } catch { /* best-effort */ }
        } else {
          try {
            await teardownCurrentCacheSource(generation);
          } catch { /* best-effort */ }
        }
        if (generation !== currentPlayGeneration()) return false;
        aborter.abort();
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('player', `playback attempt ${attempt + 1} failed for ${marked.title}`, msg.slice(0, 200));
        try {
          const eng = getAudioEngine();
          const diag = eng.getSourceDiagnostics();
          const isAssign = msg.includes('Previous source not released') || msg.includes('Stale playback generation') || msg.includes('Invalid audio source') || msg.includes('Temporary audio');
          printPlaybackFailure(marked, e, {
            stage: isAssign ? 'engine-assign' : 'engine-play',
            attempt,
            generation,
            sourceKind: source?.kind ?? null,
            sessionId: source?.sessionId ?? null,
            mimeType: source?.mimeType ?? attemptMime,
            bytes: source?.bytes ?? null,
            validationReason: null,
            mediaError: diag.errorCode !== null ? `${diag.errorMessage}(${diag.errorCode})` : null,
            eventTrail: diag.eventTrail.join('>'),
            hint: 'Engine assign/play failed — see validation/mediaError/trail above. trail=loadstart>error with code 4 means decoder rejected the container.',
          });
        } catch { /* diagnostics only */ }
        if (attempt === 1 || generation !== currentPlayGeneration()) {
          if (generation !== currentPlayGeneration()) return false;
          const label = providerLabelFor(marked.providerId);
          set({ error: resolveFailureMessage(e, marked.providerId) });
          logger.error('player', `Unable to play ${marked.title} (${label})`, String(e));
          return false;
        }
        // Otherwise loop once more for the single fresh retry.
        }
      }
    return false;
  },

  toggle: async () => {
    const engine = getAudioEngine();
    const { state, playerMode, currentStation } = get();
    if (state === 'PLAYING' || state === 'BUFFERING') {
      engine.pause();
      try {
        const cur = get().current;
        if (cur) logPlaybackEvent('PAUSED', cur);
      } catch { /* diagnostics only */ }
    } else if (state === 'PAUSED') {
      // Resume from the SAME element source — pause never releases it.
      try {
        await engine.play();
        verifyAudibleOutput(get().volume, get().muted, (msg) => set({ error: msg }));
        try {
          const cur = get().current;
          if (cur) logPlaybackEvent('PLAY_STARTED', cur);
        } catch { /* diagnostics only */ }
      } catch {
        set({ error: 'Audio playback failed to resume. Check the volume and system mixer.' });
      }
    }
    else if (playerMode === 'radio' && currentStation) {
      await get().playStation(currentStation);
    }
    else {
      const { current } = get();
      if (current) await get().playSong(current);
    }
  },

  playStation: async (station) => {
    const engine = getAudioEngine();
    let url: string;
    try {
      url = await getRadioProvider().getPlayableUrl(station);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Station unavailable';
      set({ error: msg });
      logger.warn('player', `station failed (${station.name})`, msg);
      return;
    }
    const safe = safeUrlOrUndefined(url);
    if (!safe) {
      set({ error: 'Station returned an unsafe stream URL' });
      return;
    }
    // Radio is LIVE: direct URL → AudioEngine. No download, no cache.
    // Generation 0 = legacy evict-anything teardown (user-initiated switch).
    await teardownCurrentCacheSource(0);
    engine.prepareForTrack();
    engine.setPreviewMode(false);
    autoPlayManager.resetPrefetchFor(null);
    const view = stationToSong(station);
    set({
      playerMode: 'radio', currentStation: station, current: view,
      index: -1, error: null, positionMs: 0, durationMs: 0, previewEnded: false,
      autoplayNotice: null,
      qualityLabel: `Live · ${station.codec ?? 'stream'}${station.bitrate ? ` ${station.bitrate}k` : ''}`,
    });
    try {
      engine.setRate(1);
      engine.setMediaSession({ title: station.name, artist: 'Live radio', album: station.country ?? '', artwork: station.favicon });
      await engine.playUrl(safe);
      logger.info('player', `playing station ${station.name} (live, uncached)`);
      const { songRepo } = await import('../data/repositories');
      await songRepo.upsert(view).catch(() => undefined);
      void historyRepo.record(view, 0).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Station playback failed';
      set({ error: msg });
      logger.error('player', msg);
    }
  },

  stopRadio: () => {
    getAudioEngine().pause();
    set({ playerMode: 'track', currentStation: null });
  },

  next: async (auto = false) => {
    const { queue, index, shuffle, repeat, current, playerMode } = get();
    if (playerMode === 'radio') {
      if (!auto) {
        if (queue.length === 0 || index < 0) return;
      } else {
        return;
      }
    }
    if (queue.length === 0) return;
    if (repeat === 'ONE' && auto && current && playerMode === 'track') {
      await get().playSong(current);
      return;
    }
    if (shuffle && queue.length > 1) {
      let nextIdx = index;
      do { nextIdx = Math.floor(Math.random() * queue.length); } while (nextIdx === index);
      set({ index: nextIdx, autoplayNotice: null });
      await get().playSong(queue[nextIdx]);
      return;
    }
    const nextIdx = index + 1;
    if (nextIdx < queue.length) {
      const nxt = queue[nextIdx];
      set({ index: nextIdx, autoplayNotice: nxt.queueSource === 'autoplay' ? get().autoplayNotice : null });
      await get().playSong(nxt);
      return;
    }
    if (repeat === 'ALL' && queue.length > 0) {
      set({ index: 0, autoplayNotice: null });
      await get().playSong(queue[0]);
      return;
    }
    if (!autoPlayManager.shouldAutoplayForMode(get().playerMode)) return;
    if (!autoPlayManager.isAutoplayEnabled()) return;
    if (!current) return;
    if (isPreviewSong(current) && auto) return;
    let candidates: import('../core/types').Song[] = [];
    try {
      candidates = autoPlayManager.consumePrefetch(current.id) ?? [];
      if (candidates.length === 0) {
        candidates = await autoPlayManager.getNextCandidates(current, queue);
      }
    } catch {
      candidates = [];
    }
    const tried = new Set<string>();
    for (const cand of candidates.slice(0, autoPlayManager.MAX_AUTOPLAY_ATTEMPTS)) {
      if (!cand || tried.has(cand.id)) continue;
      tried.add(cand.id);
      const marked = { ...cand, queueSource: 'autoplay' as const };
      const ok = await get().playSong(marked).catch(() => false);
      if (ok) {
        set({ autoplayNotice: `Autoplay • ${marked.title} — ${marked.artist}` });
        const noticeId = `${marked.id}`;
        setTimeout(() => {
          try {
            const cur = get().current;
            if (cur?.id === noticeId) set({ autoplayNotice: null });
            else if (get().autoplayNotice?.includes(marked.title)) set({ autoplayNotice: null });
          } catch { /* best-effort */ }
        }, 8000);
        logger.info('player', `autoplay → ${marked.title} (${marked.providerId})`);
        return;
      }
      logger.warn('player', `autoplay candidate failed (${cand.providerId}), trying next`);
    }
    if (candidates.length > 0) {
      try {
        const { toast } = await import('../ui/toast');
        toast('Autoplay couldn’t find a playable track', 'warn');
      } catch { /* toast is best-effort */ }
    }
  },

  prev: async () => {
    const engine = getAudioEngine();
    if (engine.positionMs > 3000) { engine.seekTo(0); return; }
    const { queue, index } = get();
    if (index > 0) {
      set({ index: index - 1 });
      await get().playSong(queue[index - 1]);
    } else engine.seekTo(0);
  },

  seek: (ms) => {
    if (get().playerMode === 'radio') return;
    getAudioEngine().seekTo(ms); set({ positionMs: ms });
  },
  setVolume: (v) => { getAudioEngine().setVolume(v); set({ volume: v }); },
  setMuted: (m) => { getAudioEngine().setMuted(m); set({ muted: m }); },
  setShuffle: (s) => set({ shuffle: s }),
  setRepeat: (r) => {
    set({ repeat: r });
    try { void useSettings.getState().patch({ repeatMode: r }); } catch { /* best-effort */ }
  },
  setAutoplay: (on) => {
    try { void useSettings.getState().patch({ autoplay: on }); } catch { /* best-effort */ }
  },
  syncPlaybackSettings: () => {
    try {
      const s = useSettings.getState();
      const patch: Partial<{ repeat: RepeatMode }> = {};
      if (s.repeatMode && (s.repeatMode === 'OFF' || s.repeatMode === 'ALL' || s.repeatMode === 'ONE')) {
        if (get().repeat !== s.repeatMode) patch.repeat = s.repeatMode;
      }
      if (Object.keys(patch).length > 0) set(patch);
    } catch { /* settings not ready — keep player defaults */ }
  },
  dismissAutoplayNotice: () => set({ autoplayNotice: null }),
  setRate: (r) => { getAudioEngine().setRate(r); set({ rate: r }); },
  setSleepTimer: (minutes) => {
    if (minutes === null) { set({ sleepTimerEndsAt: null }); return; }
    if (minutes === 'song') {
      const cur = get().current;
      const total = cur
        ? (isPreviewSong(cur) ? previewDurationFor(cur) : cur.durationMs || 180000)
        : 180000;
      const remaining = Math.max(1000, total - get().positionMs);
      set({ sleepTimerEndsAt: Date.now() + remaining });
      return;
    }
    set({ sleepTimerEndsAt: Date.now() + minutes * 60000 });
  },
  addToQueue: (song, playNext = false) => {
    const { queue, index } = get();
    const marked = song.queueSource === 'autoplay' ? { ...song, queueSource: 'manual' as const } : (song.queueSource ? song : { ...song, queueSource: 'manual' as const });
    if (playNext) {
      const nq = [...queue];
      nq.splice(index + 1, 0, marked);
      set({ queue: nq });
    } else {
      const firstAuto = queue.findIndex((s, i) => i > index && s.queueSource === 'autoplay');
      if (firstAuto === -1) set({ queue: [...queue, marked] });
      else {
        const nq = [...queue];
        nq.splice(firstAuto, 0, marked);
        set({ queue: nq, index: index >= firstAuto ? index + 1 : index });
      }
    }
  },
  removeFromQueue: (songId) => {
    const { queue, index } = get();
    const idx = queue.findIndex((s) => s.id === songId);
    if (idx === -1) return;
    const nq = queue.filter((s) => s.id !== songId);
    set({ queue: nq, index: idx < index ? index - 1 : index });
  },
  clearQueue: () => {
    autoPlayManager.resetPrefetchFor(null);
    set({ queue: [], index: -1, autoplayNotice: null });
  },
  reorderQueue: (from, to) => {
    const { queue } = get();
    const nq = [...queue];
    const [moved] = nq.splice(from, 1);
    nq.splice(to, 0, moved);
    set({ queue: nq, index: nq.findIndex((s) => s.id === get().current?.id) });
  },
  setOfflineMode: (off) => set({ offlineMode: off }),
}));

/**
 * App shutdown hook: detach the element and revoke the active playback
 * object URL. Smart Cache ROWS persist (that is the point); offline
 * downloads, library, playlists, favorites untouched.
 */
export async function cleanupPlaybackCacheUrls(): Promise<void> {
  try {
    getAudioEngine().releaseSource();
  } catch {
    /* best-effort */
  }
  try {
    releaseCacheUrl();
  } catch {
    /* best-effort */
  }
  try {
    releaseOfflineUrl();
  } catch {
    /* best-effort */
  }
}

/** Deprecated alias (kept for older callers during migration). */
export async function cleanupPlaybackTempFiles(): Promise<number> {
  await cleanupPlaybackCacheUrls();
  return 0;
}
