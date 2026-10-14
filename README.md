<div align="center">

<br />

<img src="public/icons/app-logo.png" alt="KNOX Music Logo" width="130" style="border-radius: 28px; box-shadow: 0 10px 30px rgba(0,0,0,0.4);" />

# 🎵 KNOX MUSIC

### *Your Music. Your Device. Your Control.*

An ultra-sleek, privacy-first, local-first music powerhouse built for listeners who demand complete ownership of their library.<br />
Zero telemetry. No cloud accounts. Spotify, JioSaavn, YouTube, YouTube Music, Radio & Local Library unified into one experience.

<br />

[![Release](https://img.shields.io/badge/Release-v1.1.7-6366f1?style=for-the-badge&logo=tag&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981?style=for-the-badge&logo=open-source-initiative&logoColor=white)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Android%20%7C%20Windows%20%7C%20Web-0ea5e9?style=for-the-badge&logo=linux&logoColor=white)](#-platform-support--downloads)
[![Tauri](https://img.shields.io/badge/Tauri-v2.11-f97316?style=for-the-badge&logo=tauri&logoColor=white)](src-tauri)
[![React](https://img.shields.io/badge/React-18.3-61dafb?style=for-the-badge&logo=react&logoColor=black)](src/App.tsx)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](tsconfig.json)

<br />

[✨ Features](#-key-features) •
[⚖️ Why KNOX?](#-why-knox-music) •
[🌐 Provider Matrix](#-federated-providers--capabilities) •
[🏗️ Architecture](#-system-architecture) •
[🚀 Quick Start](#-quick-start) •
[📦 Packaging](#-building--packaging) •
[🐧 Linux Setup](#-linux-desktop-runtime--codecs) •
[📖 Documentation](#-directory-structure)

<br />

</div>

---

## 💡 Why KNOX Music?

Traditional streaming services rent you access to music wrapped inside DRM silos, track your listening habits, and hold your playlists hostage behind monthly subscriptions. **KNOX Music flips the model:** your device is the server.

| Dimension | 🎵 KNOX Music | ☁️ Traditional Streaming (Spotify, Apple, YT) |
|:---|:---|:---|
| **Data Ownership** | **100% Local**: Files & playlists reside on your hardware | Rented access; tracks disappear when licenses expire |
| **User Privacy** | **Zero Telemetry**: No logging, tracking, or fingerprinting | Continuous behavioural tracking, profiling & targeted ads |
| **Account Requirement** | **None**: Launch and immediately listen | Mandatory registration, email, payment card, and login |
| **Offline Capability** | **Atomic Offline Vault**: Real audio saved to your disk/DB | Proprietary encrypted blobs that delete if you go offline |
| **Catalog Freedom** | **Federated**: Spotify + JioSaavn + YouTube + YT Music + Radio + Local | Walled garden restricted to one catalog contract |
| **Audio Pipeline** | **Lossless local playback** + High-bitrate streams (320k) | Lossy transcoding with bitrate caps on non-premium tiers |
| **Price** | **Free & Open Source** forever (MIT) | \$11–\$17 / month subscription fees |

---

## 🌐 Federated Providers & Capabilities

KNOX unites your favorite services through an intelligent, modular provider engine. Search simultaneously, stream seamlessly, and download permanently for offline playback.

| Provider | Search | Streaming | Offline Download | Synced Lyrics | Bitrate | Description |
|:---|:---:|:---:|:---:|:---:|:---:|:---|
| 🟢 **Spotify** | 🟢 Yes | 🟢 In-App | 🟢 Permanent | 🟢 Synced | Up to 320 kbps | Full catalog search, album/artist exploration, scraping fallback, and in-app audio resolution engine. |
| 🟢 **JioSaavn** | 🟢 Yes | 🟢 Direct | 🟢 Permanent | 🟢 Synced | Up to 320 kbps AAC | Extensive Indian & international music catalog, high-bitrate AAC streams, albums, artists, and playlists. |
| 🟢 **YouTube** | 🟢 Yes | 🟢 Native | 🟢 Permanent | 🟢 Synced | Direct / High | Full audio/video catalog search, YouTube Mix auto-continuation, and download-first local caching. |
| 🟢 **YouTube Music** | 🟢 Yes | 🟢 In-App | 🟢 Permanent | 🟢 Synced | Direct / High | Native InnerTube protocol via local loopback sidecar (`services/youtubemusic`, stdlib-only Python service). |
| 📻 **Radio Browser** | 🟢 Yes | 🟢 Live | 🔴 Stream Only | ⚪ None | 128k–320k Live | 30,000+ live public internet radio stations worldwide categorized by country, tag, and genre. |
| 📂 **Local Library** | 🟢 Yes | 🟢 Native | 🟢 Permanent | 🟢 Local `.lrc` | Lossless / Direct | Your personal local audio collection (`flac`, `wav`, `mp3`, `m4a`, `ogg`, `aac`) with ID3 tag parsing. |
| 🧪 **Sample Catalog** | 🟢 Yes | 🟢 Direct | 🟢 Permitted | ⚪ None | 192 kbps | Built-in SoundHelix test tracks for development, testing, and offline validation. |
| 📜 **LRCLIB** | ⚪ Query | ⚪ None | 🟢 Cached (30d) | 🟢 Millisecond | Text / LRC | Open community synchronized lyrics database with real-time scrolling timestamps. |

---

## ✨ Key Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🎛️ Studio-Grade Audio Engine</h3>
      <ul>
        <li><b>Single Engine Architecture</b>: Deterministic HTML5 Audio singleton with zero state leaks.</li>
        <li><b>Playback Customization</b>: Variable speed pitch control, precision seek scrubber, shuffle, and repeat (track / queue).</li>
        <li><b>Queue Maestro</b>: Real-time reordering, batch deletions, and instant <i>"Save Queue as Playlist"</i>.</li>
        <li><b>Hardware Integration</b>: MediaSession API with lock-screen controls, notification artwork, and global media keys.</li>
      </ul>
    </td>
    <td width="50%" valign="top">
      <h3>🔒 Dual-Layer Offline Storage</h3>
      <ul>
        <li><b>Strict Partitioning</b>: Permanent <i>Offline Library</i> is isolated from the temporary <i>Smart Playback Cache</i>.</li>
        <li><b>Atomic Transactions</b>: Downloads stream into memory and commit to IndexedDB only after size validation (250 MB ceiling) and quota verification.</li>
        <li><b>Storage Quota Controls</b>: Set limits from 500 MB to 10 GB or Unlimited. Friendly alerts prevent silent eviction of favorite tracks.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📁 Intelligent Local Library</h3>
      <ul>
        <li><b>Folder & File Scanning</b>: Direct directory grants via File System Access API or native paths.</li>
        <li><b>Incremental Scanner</b>: Background batch scanner compares file size and modification timestamps (<code>mtime</code>) to skip unchanged tracks instantly.</li>
        <li><b>Metadata Extraction</b>: Extracts title, artist, album, genre, year, and embedded artwork via <code>jsmediatags</code>.</li>
        <li><b>Duplicate Guard</b>: Content-aware fingerprinting flags duplicates without destructive deletions.</li>
      </ul>
    </td>
    <td width="50%" valign="top">
      <h3>🎙️ Synchronized Lyrics & Radio</h3>
      <ul>
        <li><b>Real-Time Lyrics</b>: Synchronized time-stamped scrolling lyrics powered by the LRCLIB open catalog.</li>
        <li><b>Local <code>.lrc</code> Import</b>: Automatically loads matching local <code>.lrc</code> files alongside your audio files.</li>
        <li><b>Global Radio</b>: 30,000+ live internet radio stations via RadioBrowser categorized by genre, tag, and country.</li>
      </ul>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔍 Unified Federated Search</h3>
      <ul>
        <li><b>Concurrent Fan-Out</b>: Concurrently queries Spotify, JioSaavn, YouTube, YouTube Music, Radio, and Local Library.</li>
        <li><b>Smart Deduplication</b>: Cross-references song titles, artists, and durations to present clean search results without clutter.</li>
        <li><b>Vibe Recommendation Engine</b>: Auto-queues matching tracks based on acoustic classification when playlists end.</li>
      </ul>
    </td>
    <td width="50%" valign="top">
      <h3>🎨 Premium Glassmorphic UI</h3>
      <ul>
        <li><b>Aesthetic Dark-First Design</b>: Built with custom CSS backdrop filters, ambient light reflections, and responsive breakpoints.</li>
        <li><b>Multi-Theme Support</b>: Deep Dark Glass, Clean Light, and True OLED Black modes.</li>
        <li><b>Adaptive Layouts</b>: Seamless transition between Desktop sidebar + sticky player and Mobile bottom-sheet navigation.</li>
      </ul>
    </td>
  </tr>
</table>

---

## 🏗️ System Architecture

KNOX Music adheres to strict **Layer Separation**: the UI layer never imports or communicates directly with concrete provider implementations.

```mermaid
flowchart TD
    classDef ui fill:#3b82f6,stroke:#1d4ed8,stroke-width:2px,color:#fff;
    classDef core fill:#6366f1,stroke:#4338ca,stroke-width:2px,color:#fff;
    classDef data fill:#10b981,stroke:#047857,stroke-width:2px,color:#fff;
    classDef prov fill:#ec4899,stroke:#be185d,stroke-width:2px,color:#fff;
    classDef native fill:#f97316,stroke:#c2410c,stroke-width:2px,color:#fff;

    UI["🎨 UI & Components\n(React 18 · Zustand · Glass Theme)"]:::ui

    subgraph StateCore ["⚙️ Core Logic & State Management"]
        PS["🎧 playerStore & AudioEngine\n(HTML5 Audio Singleton)"]:::core
        DM["⬇️ DownloadManager\n(Atomic · Resumable)"]:::core
        SM["💾 StorageManager & SmartCache\n(LRU Eviction · Quotas)"]:::core
        PM["🔎 ProviderManager\n(Federated Fan-Out)"]:::core
    end

    subgraph StorageData ["🗄️ Storage Layer"]
        DB[("📦 Dexie DB (IndexedDB)\nSongs · Playlists · History · Blobs")]:::data
    end

    subgraph Adapters ["🌐 Provider Adapters"]
        P_SPOT["🟢 Spotify\n(Catalog · Search · In-App Stream)"]:::prov
        P_JIO["🟢 JioSaavn\n(High-res AAC · Search · Offline)"]:::prov
        P_YT["🟢 YouTube\n(Sidecar · Mix · Download-First)"]:::prov
        P_YTM["🟢 YouTube Music\n(InnerTube · Albums · Artists)"]:::prov
        P_RAD["📻 Radio Browser\n(30,000+ Live Worldwide Stations)"]:::prov
        P_LOC["📂 Local Library\n(Lossless Disk Audio · ID3 Tags)"]:::prov
        P_LRC["📜 LRCLIB\n(Synchronized Timed Lyrics)"]:::prov
    end

    subgraph NativeLayer ["🖥️ Native OS Shell (Tauri 2)"]
        RUST["Rust IPC Core\n(gst_env · sidecar · permissions)"]:::native
        LINUX["🐧 Linux (WebKitGTK + GStreamer)"]:::native
        ANDR["🤖 Android (Foreground Service)"]:::native
        WIN["🪟 Windows (WebView2)"]:::native
    end

    UI --> PS
    UI --> DM
    UI --> PM
    PS --> SM
    DM --> SM
    SM --> DB
    PM --> P_SPOT
    PM --> P_JIO
    PM --> P_YT
    PM --> P_YTM
    PM --> P_RAD
    PM --> P_LOC
    PM --> P_LRC
    UI -. IPC Calls .-> RUST
    RUST --> LINUX
    RUST --> ANDR
    RUST --> WIN
```

---

## 📱 Platform Support & Downloads

| Platform | Target Package | Architecture | Runtime Engine | Status |
|:---|:---|:---|:---|:---:|
| 🐧 **Linux** | `.AppImage` | `x86_64` | WebKitGTK 4.1 + GStreamer | 🟢 Production |
| 🐧 **Linux** | `.deb` | `amd64` | Native Debian package with auto-dependencies | 🟢 Production |
| 🐧 **Linux** | `.rpm` | `x86_64` | Fedora / RHEL package | 🟢 Production |
| 🤖 **Android** | `.apk` | `arm64-v8a`, `armeabi-v7a`, `x86_64` | Android WebView + Foreground Media Service | 🟢 Production |
| 🪟 **Windows** | `.exe` | `x64` | NSIS installer via Microsoft WebView2 | 🟢 Ready |
| 🌐 **Modern Web** | Progressive Web App | All modern browsers | Service Worker + IndexedDB | 🟢 Production |

---

## 🚀 Quick Start

### 1. Prerequisites
Ensure you have the following installed on your development machine:
- **Node.js**: `v20.0.0` or higher ([Download](https://nodejs.org/))
- **npm**: `v10.x` or higher
- **Python**: `3.10+` (for the local YouTube Music discovery sidecar)
- **Rust Toolchain**: `1.75+` *(only needed for desktop/Tauri builds)*

### 2. Clone & Install
```bash
# Clone the repository
git clone https://github.com/Knox-knx/Knox-Music.git
cd Knox-Music

# Install Node dependencies
npm install
```

### 3. Launch Development Servers

```bash
# Option A: Standard Web App (Vite Dev Server on http://localhost:5173)
npm run dev

# Option B: Full Stack (App + YouTube Music Discovery Sidecar concurrently)
npm run dev:all

# Option C: Desktop App (Tauri dev window with native bindings)
npm run desktop:dev

# Option D: Android App (Live on connected device or emulator)
npm run android:dev
```

---

## 📦 Building & Packaging

<details>
<summary><b>Click to expand packaging instructions</b></summary>
<br />

### Web / PWA Build
```bash
npm run build
npm run preview
```
Outputs static production assets into `dist/` ready for hosting on GitHub Pages, Cloudflare Pages, or Vercel.

### Linux AppImage & Debian Package
```bash
npm run desktop:build
```
Bundles the application into:
- `src-tauri/target/release/bundle/appimage/knox-music_1.1.7_amd64.AppImage`
- `src-tauri/target/release/bundle/deb/knox-music_1.1.7_amd64.deb`

Run the AppImage packaging verification gate:
```bash
npm run check:appimage
```

### Standalone Android APK
```bash
# Standard APK build
npm run android:apk

# Debug APK build (for emulator testing)
npm run android:apk:debug
```
Outputs APKs into `src-tauri/gen/android/app/build/outputs/apk/`.

### Windows Installer (.exe)
```bash
cargo tauri build --target x86_64-pc-windows-gnu
```

</details>

---

## 🐧 Linux Desktop Runtime & Codecs

On Linux, KNOX Music utilizes WebKitGTK and GStreamer for hardware-accelerated playback.

> [!IMPORTANT]
> **Why doesn't the AppImage bundle GStreamer?**  
> Bundling GStreamer inside AppImages causes ABI conflicts with the host system's audio daemons (PulseAudio / PipeWire) and breaks WebKit's native codec discovery. Installing the system packages below guarantees reliable playback and minimal resource usage.

### Debian / Ubuntu / Linux Mint / Pop!_OS
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-libav \
  gstreamer1.0-alsa \
  gstreamer1.0-pulseaudio
```

### Fedora / RHEL
```bash
sudo dnf install -y \
  webkit2gtk4.1 \
  gtk3 \
  gstreamer1-plugins-base \
  gstreamer1-plugins-good \
  gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free \
  gstreamer1-libav \
  gstreamer1-plugins-pulseaudio
```

### Arch Linux / Manjaro
```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  gtk3 \
  gst-plugins-base \
  gst-plugins-good \
  gst-plugins-bad \
  gst-plugins-ugly \
  gst-libav
```

### Verification Command
Verify that WebKitGTK can resolve audio sinks:
```bash
gst-inspect-1.0 appsink | head -n 4
gst-inspect-1.0 autoaudiosink | head -n 4
```

---

## 🧪 Testing & Quality Gates

KNOX maintains high test reliability with unit, integration, and packaging tests:

```bash
# Run Vitest test suite (41+ tests across DB, Audio, Downloads, Providers)
npm test

# Watch mode for active development
npm run test:watch

# Test coverage report
npm run test:coverage

# TypeScript compile validation
npm run typecheck

# Rust unit tests
npm run test:rust
```

---

## 📂 Directory Structure

```
MusicProvider/
├── 📁 docs/                   # Architectural blueprints & engineering docs
│   ├── architecture.md        # State machine definitions & layer segregation
│   ├── providers.md           # Provider capability contracts & rules
│   ├── offline-storage.md     # Atomic storage transactions & quota rules
│   ├── linux-desktop.md       # Linux GStreamer runtime resolution guide
│   └── troubleshooting.md     # Engineering troubleshooting guide
├── 📁 public/                 # Static assets, web app manifest, icons
├── 📁 scripts/                # Health checks, dev orchestrators, packaging gates
├── 📁 services/               # Micro-sidecars
│   ├── youtubemusic/          # Python discovery sidecar (stdlib-only, no API key)
│   ├── youtube/               # Node sidecar service
│   └── audioService.js        # Background audio routing service
├── 📁 src/                    # Frontend Application Source (React 18 + TS)
│   ├── 📁 api/                # High-level client API facades
│   ├── 📁 audio/              # AudioEngine singleton, audio state machine
│   ├── 📁 autoplay/           # Recommendation scoring & vibe classifier
│   ├── 📁 cache/              # Smart playback cache & LRU eviction engine
│   ├── 📁 core/               # Domain types, logger, error handlers, states
│   ├── 📁 data/               # Dexie DB schema, repositories & queries
│   ├── 📁 desktop/            # Tauri desktop bridge & lifecycle hooks
│   ├── 📁 discovery/          # Web & catalog discovery adapters
│   ├── 📁 downloads/          # Resumable DownloadManager
│   ├── 📁 library/            # Local directory scanner & ID3 tag parser
│   ├── 📁 os/                 # MediaSession API, hardware keys & native notifications
│   ├── 📁 providers/          # Modular providers (Spotify, JioSaavn, YouTube, Radio, etc.)
│   ├── 📁 screens/            # Top-level route views (Home, Search, Library, Settings, etc.)
│   ├── 📁 search/             # Query normalizer, parser, deduplicator & ranker
│   ├── 📁 settings/           # Persistent user settings store
│   ├── 📁 ui/                 # Glassmorphic UI components, song rows & player
│   └── main.tsx               # React application entry point
├── 📁 src-tauri/              # Tauri 2 Desktop & Mobile Backend (Rust)
│   ├── 📁 capabilities/       # Tauri 2 security permission ACLs
│   ├── 📁 gen/android/        # Android Gradle project & foreground service
│   ├── 📁 icons/              # Multi-resolution application icons
│   ├── 📁 src/                # Rust main entry, GStreamer repair & IPC commands
│   ├── Cargo.toml             # Rust package dependencies
│   └── tauri.conf.json        # Tauri app configuration & build specifications
└── 📁 tests/                  # Integration and unit tests
```

---

## ⚙️ Environment Configuration

Copy `.env.example` to `.env` to customize local development variables:

```bash
cp .env.example .env
```

| Environment Variable | Default Value | Purpose |
|:---|:---|:---|
| `VITE_JIOSAAVN_API_BASE_URL` | `https://www.jiosaavn.com/api.php` | Base endpoint for JioSaavn searches and metadata. |
| `VITE_SPOTIFY_API_BASE_URL` | `https://api.spotify.com/v1` | Public endpoint for Spotify catalog browsing. |
| `VITE_YOUTUBEMUSIC_API_BASE_URL` | `http://127.0.0.1:5000` | Loopback address for the local Python discovery sidecar. |
| `VITE_RADIO_BROWSER_API_BASE_URL` | `https://de1.api.radio-browser.info` | Public community radio database endpoint. |
| `VITE_LRCLIB_API_BASE_URL` | `https://lrclib.net` | Open timestamped synchronized lyrics endpoint. |
| `VITE_REQUEST_TIMEOUT_MS` | `15000` | Per-provider timeout budget in milliseconds. |

> [!WARNING]
> Never put private tokens or client secrets in `.env`. Frontend code compiles directly into client-visible bundles.

---

## ❓ Frequently Asked Questions

<details>
<summary><b>1. Why does playback fail with a blank/grey window on Linux?</b></summary>
<br />
This occurs when WebKitGTK cannot find a valid GStreamer audio sink on the host machine. Run:

```bash
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
```
KNOX includes an early startup repair hook (`src-tauri/src/gst_env.rs`) that automatically binds host GStreamer plugin paths.
</details>

<details>
<summary><b>2. How does YouTube & YouTube Music playback work?</b></summary>
<br />
YouTube tracks utilize a download-first caching strategy via the bundled audio service, validating audio integrity and saving tracks permanently for offline playback. YouTube Music uses a lightweight Python loopback sidecar (`services/youtubemusic`) with zero required API keys.
</details>

<details>
<summary><b>3. How does the Smart Playback Cache work?</b></summary>
<br />
When you stream a song, KNOX opportunistically caches audio chunks into an IndexedDB cache table. If you listen to that track again, it loads instantaneously without network usage. If storage limits are approached, an LRU (Least Recently Used) cleanup prunes oldest cached tracks while <b>never touching your explicitly saved Offline Library</b>.
</details>

---

## 🤝 Contributing

We love contributions! Whether reporting bugs, refining documentation, or proposing new local-first features:

1. **Fork the repo** and create your branch: `git checkout -b feature/my-feature`
2. **Commit your changes**: `git commit -m "feat: add support for flac metadata replaygain"`
3. **Run tests**: Ensure `npm test` and `npm run typecheck` pass.
4. **Push to branch**: `git push origin feature/my-feature`
5. **Open a Pull Request** with clear description and screenshots.

Please read [docs/contributing.md](docs/contributing.md) for full development etiquette.

---

## 📜 License

KNOX Music is distributed under the terms of the **MIT License**.  
See the [LICENSE](LICENSE) file for complete details.

<div align="center">

<br />

**Made with ❤️ for music freedom and local-first software.**

⭐ **Star us on GitHub if you believe in privacy-friendly software!**

</div>
