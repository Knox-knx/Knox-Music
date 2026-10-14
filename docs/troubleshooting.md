# Troubleshooting

- **Search shows "Unable to load results"** — a provider failed. Retry; check Providers settings; offline mode still searches locally.
- **Online search returns nothing / only partial results** — check: (1) 📴 Offline mode OFF, (2) Settings → Providers has Jamendo / Internet Archive / FreeToUse / AirBeats / YouTube Music enabled, (3) internet reachable. Queries with characters like `/ : ( )` are now escaped automatically for Internet Archive. FreeToUse blocks direct browser requests (no CORS headers) — in dev set `VITE_FREETOUSE_API_BASE_URL=/api/freetouse` to use the built-in Vite proxy; Jamendo + Archive work direct.
- **"FreeToUse unavailable — showing partial results" on every search** — expected without the proxy (see above). Jamendo + Internet Archive results still show.
- **"Music service is taking too long"** — per-provider 15s timeout (configurable in Network settings).
- **"Search temporarily limited"** — provider rate limit; wait and retry.
- **"YouTube Music unavailable — showing partial results"** — the local discovery service isn't running. Desktop: it auto-starts; check Settings → Providers → YouTube Music → Check service. Browser dev: run `python3 services/youtubemusic/app.py --port 5000` (stdlib only, nothing to install). Other providers keep working meanwhile.
- **Linux AppImage: "GStreamer element appsink/autoaudiosink not found" / no audio** — the OS GStreamer runtime is incomplete (WebKitGTK backend). This error is not hidden — install system packages (see `docs/linux-desktop.md`): `libwebkit2gtk-4.1-0 libgtk-3-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-alsa gstreamer1.0-pulseaudio`. Bundling GStreamer in the AppImage is unreliable with WebKitGTK, so the `.deb` declares these in `depends` and the AppImage requires them on the host.
- **Download stuck/failed** — retry from Downloads → "Needs attention"; check Wi-Fi-only setting and storage limit.
- **"Offline storage limit reached"** — Storage screen → clear cache or raise the limit. Saved songs are never auto-deleted.
- **No audio output devices listed** — the browser doesn't expose `setSinkId`; output follows the OS mixer.
- **Library rescan is slow** — scanning is incremental and backgrounded; use Cancel and re-add smaller folders.
- **Corrupt state after crash** — restart; transient downloads reset to PAUSED and the DB uses atomic transactions. Restore from a JSON backup if needed.
