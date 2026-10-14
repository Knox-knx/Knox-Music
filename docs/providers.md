# Provider system

Implement `MusicProvider` (`src/providers/types.ts`):

```ts
searchSongs / searchArtists / searchAlbums / searchPlaylists
getSong / getArtist / getAlbum / getPlaylist / getAlbumTracks
getStream  // must set allowsOffline honestly per license/terms
getArtwork / getLyrics
canDownload? / getDownload?  // per-track offline permission + direct URL
```

Each provider declares `ProviderCapabilities` (`supportsSearch`, `supportsStreaming`,
`supportsOffline`, `supportsLyrics`, `supportsArtwork`, `supportsArtists`, `supportsAlbums`).
The UI adapts: e.g. the offline button is disabled with "Offline download unavailable" when
`supportsOffline` is false or the track reports `downloadAllowed === false`.

Shared helpers: `src/providers/http.ts` (timeout + retry/backoff + URL validation),
`src/providers/env.ts` (public client_id + base URLs, never secrets),
`src/providers/merge.ts` (validate, dedupe, rank, sort),
`src/search/` (query parsing, relevance scoring, ranking, dedupe, engine),
`src/providers/capabilities.ts` (per-track SEARCH ≠ STREAMING ≠ DOWNLOAD ≠ OFFLINE).

Layout:

```
src/providers/
├── env.ts / http.ts / merge.ts / types.ts / capabilities.ts / ProviderManager.ts
├── jamendo/provider.ts
├── internet-archive/provider.ts
├── freetouse/provider.ts
├── airbeats/ (provider.ts / client.ts / mapper.ts / types.ts / health.ts / index.ts)
├── youtubeMusic/ (provider.ts / client.ts / search.ts / mapper.ts / types.ts / health.ts)
├── local/provider.ts (re-exports LocalLibraryProvider)
└── LocalLibraryProvider.ts / SampleCatalogProvider.ts (demo)
src/search/
├── normalizeQuery.ts / queryParser.ts / relevance.ts
├── ranking.ts / dedupe.ts / searchEngine.ts
```

## Shipped providers

| Provider | Search | Stream | Offline | Notes |
|---|---|---|---|---|
| Local Library | ✓ | ✓ | ✓ | Your imported files + saved tracks. Always available. |
| Sample Catalog (Demo) | ✓ | ✓ | ✓ | 12 SoundHelix test tracks for development. |
| Jamendo (`jamendo`) | ✓ | ✓ | per-track | Real API `https://api.jamendo.com/v3.0`, public `client_id` (`VITE_JAMENDO_CLIENT_ID`, default `ecadb32a`). Streams refresh expiring URLs; offline only when `audiodownload_allowed`. Tracks stay visible regardless of that flag — only download/offline actions are gated. |
| Internet Archive (`internet-archive`) | ✓ | ✓ | per-item | `advancedsearch.php` (`mediatype:audio` only) + `/metadata/{id}`. Picks best public audio file (MP3 > OGG > FLAC); restricted/private items never stream. No key. |
| FreeToUse (`freetouse`) | ✓ songs/artists | ✓ MP3 | non-premium only | `https://api.freetouse.com/v3/music/tracks/search` + `/music/tracks/{id}` (parses `response.data`). Premium tracks stream but `downloadAllowed=false`. No key. No CORS headers → use dev proxy `VITE_FREETOUSE_API_BASE_URL=/api/freetouse`. |
| AirBeats (`airbeats`) | ✓ songs/artists/albums/playlists | ✓ full-length 320kbps | ✓ per-track | `https://api.airbeats.xyz` (no key, CORS `*`). Dedicated search endpoints + `/api/songs/{id}`, `/api/artists/{id}`, `/api/artists/{id}/songs`, `/api/albums?id=`, `/api/playlists?id=` (query-param form — path forms are 404). Streams are full-length `audio/mp4` via the explicit `downloadUrl` tiers. Lyrics/suggestions endpoints are 404/500 live → `supportsLyrics: false`. Unofficial catalog mirror — rights belong to the per-track copyright holder. |
| YouTube Music (`youtube-music`) | ✓ songs/artists/albums | none (discovery only) | never | YouTube Music / InnerTube via the bundled loopback sidecar (`services/youtubemusic`, stdlib-only, optional `ytmusicapi` use when installed). No key, no login. Discovery/metadata only — results are labeled "Discovery", never marked playable/downloadable. |

## Commercial catalog evaluation (mainstream / Indian music)

Open/independent catalogs (Jamendo, Internet Archive, FreeToUse) do not
reliably contain mainstream commercial Indian recordings — that is a catalog
coverage fact, not a search bug. Evaluated options:

| API | Verdict | Reason |
|---|---|---|
| Spotify Web API | NOT implemented | App-access search needs the client secret (client-credentials flow). Shipping a secret in frontend code is forbidden; user-token plumbing would be dishonest UX without a backend. |
| Apple Music API / MusicKit | NOT implemented | Requires a signed developer token (private key). Cannot be embedded in a local-first frontend. |
| YouTube Data API | NOT implemented | Needs a quota-limited API key and provides metadata only — no legal audio streaming/download for a player (embeds are video-only and break offline/queue semantics). |
| YouTube Music / InnerTube sidecar | IMPLEMENTED (discovery only) | Unofficial InnerTube protocol via a loopback sidecar (stdlib-only; `ytmusicapi` used opportunistically when installed, never required). No key, no login. Honest capabilities: search/metadata YES, streaming NO, download/offline NO. Never an audio extractor, never a downloader. |

No unauthorized download APIs, no scraping, no DRM bypass, no secrets.

## Rules

- Only use sources whose API/license/terms permit the intended playback and offline behavior.
- No stream ripping, DRM circumvention, or bypassing provider restrictions.
- `ProviderManager.searchAll()` fans out with per-provider timeouts and returns partial results + failure lists.
- Validate all provider data: URLs must be http(s)/blob/image-data, filenames sanitized, sizes capped (250 MB/track).
