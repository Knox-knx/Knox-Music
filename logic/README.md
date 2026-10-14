# Music Provider & Metadata Scraping Logic (`logic/`)

This directory consolidates the existing YouTube provider/scraping files from the KNOX Music codebase alongside matching metadata & discovery provider implementations for **JioSaavn** and **Spotify**.

## Directory Structure

```text
logic/
├── index.ts
├── README.md
├── youtube/
│   ├── index.ts
│   ├── scraper.ts          # Standalone TypeScript InnerTube search + public HTML metadata scraper
│   ├── provider/           # Copied from src/providers/youtube/
│   ├── youtubeMusic/       # Copied from src/providers/youtubeMusic/
│   ├── services/           # Copied from services/youtube/sidecar.js, services/audioService.js, services/youtubemusic/app.py
│   └── tauri/              # Copied from src-tauri/src/yt_device.rs
├── jiosaavn/
│   ├── index.ts
│   ├── types.ts            # JioSaavn track, artist, album, and playlist metadata shapes
│   ├── scraper.ts          # Public URL detector, JSON-LD/OpenGraph HTML scraper, and catalog metadata lookup
│   ├── mapper.ts           # Maps JioSaavn metadata to KNOX Song, Artist, Album, Playlist models
│   └── provider.ts         # JioSaavnProvider implementing KNOX MusicProvider (discovery/metadata)
└── spotify/
    ├── index.ts
    ├── types.ts            # Spotify track, artist, album, playlist, and oEmbed metadata shapes
    ├── scraper.ts          # Public URL/URI detector, oEmbed + OpenGraph/JSON-LD scraper, and Web API v1 client
    ├── mapper.ts           # Maps Spotify metadata to KNOX Song, Artist, Album, Playlist models
    └── provider.ts         # SpotifyProvider implementing KNOX MusicProvider (discovery/metadata)
```

## How the Logic Works

1. **YouTube (`logic/youtube/`)**:
   - **Original Codebase Files**: Copied from `src/providers/youtube/`, `src/providers/youtubeMusic/`, `services/youtubemusic/app.py`, `services/youtube/sidecar.js`, `services/audioService.js`, and `src-tauri/src/yt_device.rs`.
   - **Metadata & Search (`logic/youtube/scraper.ts`)**: Uses the unauthenticated `WEB_REMIX` InnerTube search endpoint (`https://music.youtube.com/youtubei/v1/search`) to parse `musicResponsiveListItemRenderer` items (video ID, title, artist/channel, duration, thumbnails) and layered static HTML metadata parsing (JSON-LD → OpenGraph → `<title>`/`<meta>`).

2. **JioSaavn (`logic/jiosaavn/`)**:
   - Detects and canonicalizes public `jiosaavn.com` and `saavn.com` links (`song`, `album`, `artist`, `playlist`).
   - Scrapes public page HTML via JSON-LD (`MusicRecording`, `MusicAlbum`, `MusicPlaylist`), OpenGraph (`og:*`, `music:*`), and `<title>`/`<meta>` tags, upscaling thumbnail URLs to `500x500`.
   - Queries public catalog metadata (`search.getResults`, `song.getDetails`) and maps results into KNOX `Song`, `Artist`, `Album`, and `Playlist` models (`supportsStreaming: false`, `supportsDownloads: false` — metadata/discovery only, without decrypting protected `encrypted_media_url` streams).

3. **Spotify (`logic/spotify/`)**:
   - Detects and canonicalizes `open.spotify.com` links (including `/intl-*` and `/embed/` paths) and `spotify:<kind>:<id>` URIs.
   - Scrapes public metadata from Spotify track/album/artist/playlist pages using static HTML metadata (JSON-LD, `og:title`, `og:description`, `og:image`, `music:duration`) with automatic fallback to Spotify's unauthenticated public oEmbed endpoint (`https://open.spotify.com/oembed`).
   - Supports full catalog search (`tracks`, `artists`, `albums`, `playlists`) via the official Spotify Web API v1 (`https://api.spotify.com/v1/search`) when `VITE_SPOTIFY_ACCESS_TOKEN` / `SPOTIFY_ACCESS_TOKEN` is provided (`supportsStreaming: false`, `supportsDownloads: false` — metadata/discovery only, without DRM circumvention).
