# Offline storage

Two separate categories — never conflated:

- **Temporary Cache** (`cache` table): artwork, metadata, search artifacts with expiry. May be auto-deleted.
- **Offline Library** (`offline` table, Blobs): only tracks the user explicitly saved **and** whose
  provider set `allowsOffline: true`. Kept until the user removes them.

## Safety

- Downloads stream to memory and commit **atomically** — a track becomes visible offline only after
  full receipt + size validation (250 MB cap) + quota check.
- Interrupted downloads resume as PAUSED after restart (never a corrupt "completed" file).
- States: QUEUED → DOWNLOADING → PAUSED/COMPLETED/FAILED/CANCELLED/REMOVED.
- Storage limits (500 MB…10 GB, Unlimited) are enforced *before* commit; hitting the limit shows
  "Offline storage limit reached" with Manage/Change-limit actions — never silent deletion.
- Auto-cleanup only touches expired cache; favorite-linked keys are explicitly protected.

## Offline mode

The header toggle restricts the whole app to local content. Search keeps working against IndexedDB.
No network requests are made for browsing the local library.
