# KNOX YouTube Music sidecar (discovery/metadata only)

Local loopback service (`127.0.0.1`, dynamic port) that KNOX Music's
YouTube Music provider talks to. KNOX never contacts InnerTube endpoints
directly from the renderer and never exposes this port publicly.

## Development

```sh
cd services/youtubemusic
python3 app.py --port 5000   # stdlib only — no venv, no pip install
```

`PORT=5000 python3 app.py` also works (env fallback).

Health check (canonical): `GET http://127.0.0.1:5000/health` → `{"ok": true, "service": "knox-youtube-music"}`
(`GET /api/health` is kept as a compatibility alias.)

The service sends `Access-Control-Allow-Origin: *` and answers `OPTIONS`
preflights so loopback browser fetches (Vite dev server, Tauri webview) work
directly — the payload is public discovery metadata only.

Search: `GET http://127.0.0.1:5000/api/search?q=alan%20walker`

Optional detail endpoints: `GET /api/track/<videoId>`,
`GET /api/artist/<browseId>`, `GET /api/album/<browseId>`.

## KNOX integration

- Provider: `src/providers/youtubeMusic/` (enabled by default, discovery-only).
- Enable/disable in app: Settings → Providers → YouTube Music.
- Sidecar down → provider marked unavailable, app continues normally.

## Production

Bundle this service's runtime with the installer so users never run
pip/venv manually. KNOX auto-starts it, health-checks it, and enables the
provider only on success. No `pip install ytmusicapi`, no API key, and no
Google login are ever required. When `ytmusicapi` is present it is used
opportunistically; otherwise the bundled stdlib InnerTube client is used.

## Limitations (honest)

- Discovery/metadata only: search, artists, albums, artwork, durations.
- No audio streams, no downloads, no offline storage from this provider.
- InnerTube is not an official public API contract — treat it
  conservatively (timeouts, backoff, short-lived cache).

## Legal

Discovery/metadata relay only. No audio extraction, no MP3 ripping, no
DRM, authentication, access-control, or paywall bypass — ever.
