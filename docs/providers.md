# Provider System

Implement `MusicProvider` (`src/providers/types.ts`):

```ts
searchSongs / searchArtists / searchAlbums / searchPlaylists
getSong / getArtist / getAlbum / getPlaylist / getAlbumTracks
getStream
getArtwork / getLyrics
canDownload? / getDownload?
```

Each provider declares `ProviderCapabilities`:
- `supportsSearch`
- `supportsStreaming`
- `supportsOffline`
- `supportsLyrics`
- `supportsArtwork`
- `supportsArtists`
- `supportsAlbums`
- `supportsMetadata`
- `supportsDownloads`
- `supportsPlaybackCache`

Layout:

```
src/providers/
├── env.ts / http.ts / merge.ts / types.ts / capabilities.ts / health.ts / ProviderManager.ts
├── spotify/ (provider.ts / mapper.ts / scraper.ts / types.ts / index.ts)
├── jiosaavn/ (provider.ts / mapper.ts / scraper.ts / types.ts / index.ts)
├── youtube/ (provider.ts / mapper.ts / scraper.ts / device.ts / upNext.ts / youtubeOffline.ts / types.ts / index.ts)
├── youtubeMusic/ (provider.ts / mapper.ts / client.ts / search.ts / health.ts / types.ts / index.ts)
├── radio/ (radioBrowser.ts / types.ts)
├── lyrics/ (lrclib.ts / types.ts)
├── local/ (provider.ts)
└── LocalLibraryProvider.ts / SampleCatalogProvider.ts (demo)
```

## Shipped Providers

| Provider | Search | Stream | Offline | Description |
|---|---|---|---|---|
| **Spotify** (`spotify`) | ✓ | ✓ | ✓ | Full catalog search, album/artist exploration, public metadata scraping, and in-app audio resolution engine. |
| **JioSaavn** (`jiosaavn`) | ✓ | ✓ | ✓ | Extensive Indian & international catalog, high-bitrate AAC streaming, albums, artists, playlists, and offline downloads. |
| **YouTube** (`youtube`) | ✓ | ✓ | ✓ | High-coverage video/audio search, mix recommendations, and download-first permanent local playback via local sidecar / native host. |
| **YouTube Music** (`youtube-music`) | ✓ | ✓ | ✓ | InnerTube protocol exploration via local loopback sidecar (`services/youtubemusic`, stdlib-only Python) with in-app audio resolution. |
| **Radio Browser** (`radio-browser`) | ✓ | ✓ | ✗ | 30,000+ live public internet radio stations worldwide. Stream-only. |
| **Local Library** (`local`) | ✓ | ✓ | ✓ | Your imported files (`flac`, `wav`, `mp3`, `m4a`, `ogg`, `aac`) + saved tracks. Always available. |
| **Sample Catalog** (`sample`) | ✓ | ✓ | ✓ | 12 built-in SoundHelix test tracks for development and offline testing. |
| **LRCLIB** (`lrclib`) | ✓ | ✗ | ✓ (cache) | Open synchronized timestamped lyrics matching tracks across all providers. |

## Rules

- No secrets or private tokens in frontend code.
- `ProviderManager.searchAll()` fans out with per-provider timeouts and returns partial results with failure lists.
- Validate all provider data: URLs must be safe media URLs, filenames sanitized, track sizes validated.
