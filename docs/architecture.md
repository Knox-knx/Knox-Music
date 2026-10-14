# Architecture

## Layers

```
src/
├── core/         # domain types, explicit state machines, utils, logger, errors
├── providers/    # MusicProvider interface, ProviderManager, adapters
├── data/         # Dexie DB + repositories (songs, playlists, favorites, history, downloads, settings…)
├── audio/        # AudioEngine (HTMLAudio wrapper) + playerStore (queue/shuffle/repeat/sleep)
├── downloads/    # DownloadManager (atomic, resumable, validated, retryable)
├── storage/      # StorageManager (quota, usage, auto-cleanup), artwork cache
├── library/      # scanner, metadata, duplicates, lyrics (.lrc)
├── settings/     # persisted settings store + defaults
├── i18n/         # string table (English default; ready for more locales)
└── ui/ + screens/ # components and screens; depend only on core + stores, never on a concrete provider
```

## Key principles

- **UI never imports a concrete provider.** All playback/search flows go through `ProviderManager` or the local DB.
- **Explicit states:** `PlayerState` (IDLE/LOADING/PLAYING/PAUSED/BUFFERING/COMPLETED/ERROR) and
  `DownloadState` (QUEUED/DOWNLOADING/PAUSED/COMPLETED/FAILED/CANCELLED/REMOVED). No boolean soup.
- **Local-first:** the app is fully useful with zero providers enabled (local files + saved offline tracks).
- **Crash safety:** Dexie transactions for writes; interrupted downloads restart as PAUSED; startup runs `recoverTransientStates()`.
- **Performance:** paginated queries, indexed columns, debounced search, lazy artwork, background batched scanning with incremental skip (size + mtime), history capped at 2000 entries.
