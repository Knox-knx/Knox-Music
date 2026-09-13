"""KNOX Music — YouTube Music discovery sidecar (local loopback service).

Runs ONLY on loopback (127.0.0.1, dynamic or configured port). KNOX Music
talks to this service; KNOX never embeds catalog credentials and never
exposes this port publicly.

STDLIB ONLY — no pip/venv/Flask/requests/ytmusicapi required. Runs on any
system python3 (>=3.8). This keeps production bundling trivial: the
desktop host ships this single file and launches it with the bundled or
system interpreter.

    python3 app.py --port 5000
    PORT=5000 python3 app.py   (env fallback)

InnerTube nature: this service speaks the YouTube Music InnerTube protocol
(the same underlying API the ``ytmusicapi`` Python package wraps). When
``ytmusicapi`` happens to be installed it is used opportunistically for
search; otherwise a stdlib-only InnerTube client is used. Either way there
is nothing for the user to install — unauthenticated public discovery only,
no Google login, no API key, no cookies.

Endpoints (all GET, all local):
    /health                   -> {"ok": true, "service": ...} (canonical health)
    /api/health               -> same (compatibility alias)
    /api/search?q=<query>     -> {"results": [...controlled schema...]}
    /api/track/<videoId>      -> {"track": {...} | null}
    /api/artist/<browseId>    -> {"artist": {...} | null}
    /api/album/<browseId>     -> {"album": {...} | null}

CORS: the service answers loopback browser fetches directly
(Access-Control-Allow-Origin: * plus an OPTIONS preflight handler), so
the Vite dev server and the Tauri webview can reach it without a proxy.
The payload is public discovery metadata only — nothing credentialed.

Controlled schema (never raw upstream objects):
    {"id": "youtube-music:<videoId>", "title": ..., "artist": ...,
     "album": ..., "duration": <seconds>, "artwork": ..., "year": ...,
     "videoId": ..., "provider": "youtube-music"}

Errors are structured, never stack traces:
    {"error": {"code": "INVALID_QUERY|UPSTREAM_UNAVAILABLE|TIMEOUT|RATE_LIMITED|INVALID_RESPONSE|NOT_FOUND|INTERNAL_ERROR",
               "message": "..."}}

Production: the Tauri host auto-starts this file (SidecarManager),
health-checks /api/health, and marks the provider available only on
success. If the service is absent or fails, KNOX marks YouTube Music
unavailable and continues normally.

LEGAL: discovery/metadata only. This service never extracts audio streams,
never rips MP3s, never bypasses DRM or access controls, and never writes
YouTube content into offline storage. Stream/download/offline are always
false for this provider — licensed audio providers remain responsible for
playback.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

# Public embedded InnerTube client key (same one ytmusicapi uses for its
# unauthenticated WEB_REMIX client). Not a user secret, not a quota key —
# basic public discovery needs no Google Cloud project.
INNERTUBE_KEY = os.environ.get(
    "YOUTUBEMUSIC_INNERTUBE_KEY", "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30"
)
INNERTUBE_SEARCH_URL = (
    "https://music.youtube.com/youtubei/v1/search?key=%s&prettyPrint=false"
    % urllib.parse.quote(INNERTUBE_KEY, safe="")
)
INNERTUBE_PLAYER_URL = (
    "https://music.youtube.com/youtubei/v1/player?key=%s&prettyPrint=false"
    % urllib.parse.quote(INNERTUBE_KEY, safe="")
)
INNERTUBE_BROWSE_URL = (
    "https://music.youtube.com/youtubei/v1/browse?key=%s&prettyPrint=false"
    % urllib.parse.quote(INNERTUBE_KEY, safe="")
)
INNERTUBE_CLIENT = {
    "clientName": "WEB_REMIX",
    "clientVersion": "1.20251022.01.00",
    "hl": "en",
    "gl": "US",
}
TIMEOUT = float(os.environ.get("YOUTUBEMUSIC_TIMEOUT", "10"))
MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_QUERY_LEN = 256
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,32}$")
BROWSE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,128}$")
DURATION_RE = re.compile(r"^(?:(\d+):)?([0-5]?\d):([0-5]\d)$")


def err(code: str, message: str, status: int = 502) -> tuple[int, object]:
    return (status, {"error": {"code": code, "message": message}})


def parse_duration_to_seconds(text: str) -> int | None:
    text = (text or "").strip()
    m = DURATION_RE.match(text)
    if not m:
        return None
    try:
        h = int(m.group(1)) if m.group(1) else 0
        minutes = int(m.group(2))
        secs = int(m.group(3))
        total = h * 3600 + minutes * 60 + secs
        return total if 0 < total <= 24 * 3600 else None
    except (ValueError, TypeError):
        return None


def pick_largest_thumbnail(thumbnails: object) -> str | None:
    if not isinstance(thumbnails, list):
        return None
    best: str | None = None
    best_area = -1
    for t in thumbnails:
        if not isinstance(t, dict):
            continue
        url = t.get("url")
        if not isinstance(url, str) or not url:
            continue
        try:
            w = int(t.get("width") or 0)
            h = int(t.get("height") or 0)
        except (ValueError, TypeError):
            w, h = 0, 0
        area = w * h
        if area >= best_area:
            best_area = area
            best = url
    return best


def _runs_text(runs: object) -> list[str]:
    out: list[str] = []
    if not isinstance(runs, list):
        return out
    for r in runs:
        if isinstance(r, dict) and isinstance(r.get("text"), str):
            out.append(r["text"])
    return out


def _flex_texts(item: dict, index: int) -> list[dict]:
    """Raw runs (with navigation endpoints) of flex column `index`."""
    try:
        col = item["flexColumns"][index]["musicResponsiveListItemFlexColumnRenderer"]
        runs = col["text"].get("runs", [])
        return [r for r in runs if isinstance(r, dict)]
    except (KeyError, IndexError, TypeError, AttributeError):
        return []


def _fixed_texts(item: dict, index: int) -> list[str]:
    try:
        col = item["fixedColumns"][index]["musicResponsiveListItemFlexColumnRenderer"]
        runs = col["text"].get("runs", [])
        return _runs_text(runs)
    except (KeyError, IndexError, TypeError, AttributeError):
        return []


TYPE_TOKENS = frozenset({
    "song", "video", "single", "ep", "album", "playlist", "artist", "explicit",
})

#: Subtitle type tokens that mark a row as a playable song for discovery.
SONG_TOKENS = frozenset({"song", "single"})
#: Subtitle type tokens that mark a row as NOT a song (videos, podcasts,
#: albums, playlists, artist cards). Such rows are skipped by song search —
#: artists/albums are derived separately from genuine song rows.
NON_SONG_TOKENS = frozenset({
    "video", "album", "ep", "playlist", "artist", "podcast", "episode",
    "show", "channel", "profile",
})


def is_song_row(segments: list[dict]) -> bool:
    """True only for genuine song rows (skips videos/podcasts/albums)."""
    tokens = {(s.get("text") or "").strip().lower() for s in segments}
    if tokens & SONG_TOKENS:
        return True
    if tokens & NON_SONG_TOKENS:
        return False
    # Unknown shape with a playable videoId — accept (defensive).
    return True


def parse_search_items(payload: object) -> list[dict]:
    """Extract controlled track dicts from an InnerTube search response."""
    results: list[dict] = []
    try:
        tabs = payload["contents"]["tabbedSearchResultsRenderer"]["tabs"]  # type: ignore[index]
        content: object | None = None
        for tab in tabs:  # type: ignore[union-attr]
            tab_r = tab.get("tabRenderer") if isinstance(tab, dict) else None
            if isinstance(tab_r, dict) and "content" in tab_r:
                content = tab_r["content"]
                break
        sections = content["sectionListRenderer"]["contents"]  # type: ignore[index]
    except (KeyError, TypeError, AttributeError):
        return results
    if not isinstance(sections, list):
        return results
    for section in sections:
        if not isinstance(section, dict):
            continue
        # Filtered searches return musicShelfRenderer; unfiltered searches
        # return one itemSectionRenderer per row.
        shelf = section.get("musicShelfRenderer")
        if isinstance(shelf, dict):
            items = shelf.get("contents")
            if isinstance(items, list):
                for entry in items:
                    if isinstance(entry, dict):
                        item = entry.get("musicResponsiveListItemRenderer")
                        if isinstance(item, dict):
                            track = parse_list_item(item)
                            if track is not None:
                                results.append(track)
                            if len(results) >= 25:
                                return results
            continue
        item_section = section.get("itemSectionRenderer")
        if isinstance(item_section, dict):
            items = item_section.get("contents")
            if isinstance(items, list):
                for entry in items:
                    if isinstance(entry, dict):
                        item = entry.get("musicResponsiveListItemRenderer")
                        if isinstance(item, dict):
                            track = parse_list_item(item)
                            if track is not None:
                                results.append(track)
                            if len(results) >= 25:
                                return results
            continue
        # Top-result card (best-effort: only when it is a playable song).
        card = section.get("musicCardShelfRenderer")
        if isinstance(card, dict):
            track = parse_card_shelf(card)
            if track is not None:
                results.append(track)
            if len(results) >= 25:
                return results
    return results


def parse_card_shelf(card: dict) -> dict | None:
    """Best-effort top-result card → track (song cards only, else None)."""
    try:
        on_tap = card.get("onTap") or {}
        video_id = (on_tap.get("watchEndpoint") or {}).get("videoId")
        if not isinstance(video_id, str) or not VIDEO_ID_RE.match(video_id):
            return None
        title_runs = (card.get("title") or {}).get("runs", [])
        title = "".join(_runs_text(title_runs)).strip()
        if not title:
            return None
        sub_runs = (card.get("subtitle") or {}).get("runs", [])
        segments = split_subtitle(sub_runs if isinstance(sub_runs, list) else [])
        if not is_song_row(segments):
            return None
        artist, album, year = classify_segments(segments)
        if not artist:
            return None
        thumbs = ((card.get("thumbnail") or {}).get("musicThumbnailRenderer")
                  or {}).get("thumbnail", {}).get("thumbnails")
        return {
            "id": "youtube-music:%s" % video_id,
            "title": title,
            "artist": artist,
            "album": album,
            "duration": 0,
            "artwork": pick_largest_thumbnail(thumbs),
            "year": year,
            "videoId": video_id,
            "provider": "youtube-music",
        }
    except (AttributeError, TypeError):
        return None


def split_subtitle(sub_runs: list) -> list[dict]:
    """Split subtitle runs on ' • ' separators, keeping per-segment browseIds."""
    segments: list[dict] = []
    current: dict = {"text": "", "browseId": None}
    for r in sub_runs:
        if not isinstance(r, dict):
            continue
        text = r.get("text")
        if not isinstance(text, str):
            continue
        if text.strip() == "•":
            segments.append(current)
            current = {"text": "", "browseId": None}
            continue
        current["text"] += text
        try:
            bid = r["navigationEndpoint"]["browseEndpoint"]["browseId"]
            if isinstance(bid, str) and current["browseId"] is None:
                current["browseId"] = bid
        except (KeyError, TypeError):
            pass
    segments.append(current)
    return segments


def classify_segments(segments: list[dict]) -> tuple[str, str, int | None]:
    """First non-type segment → artist; next free text → album; YYYY → year."""
    texts = [(s.get("text") or "").strip() for s in segments]
    artist = ""
    artist_idx = -1
    for i, part in enumerate(texts):
        if not part or part.lower() in TYPE_TOKENS:
            continue
        # Audience/view/count summaries are not artist names.
        low = part.lower()
        if any(k in low for k in ("monthly audience", "subscribers", "views", "songs", "videos")):
            continue
        artist = part
        artist_idx = i
        break
    album = ""
    year = None
    for part in texts[artist_idx + 1:]:
        if not part or part.lower() in TYPE_TOKENS:
            continue
        if parse_duration_to_seconds(part) is not None:
            continue
        if re.fullmatch(r"(19|20)\d{2}", part):
            try:
                year = int(part)
            except ValueError:
                year = None
            continue
        low = part.lower()
        if any(k in low for k in ("monthly audience", "subscribers", "views", "songs", "videos")):
            continue
        if not album:
            album = part
    return (artist or "Unknown artist", album, year)


def parse_list_item(item: dict) -> dict | None:
    # videoId from the play overlay (songs) — skip non-song rows.
    video_id: str | None = None
    try:
        overlay = item["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]
        play = overlay["musicPlayButtonRenderer"]["playNavigationEndpoint"]
        watch = play.get("watchEndpoint") or {}
        vid = watch.get("videoId")
        if isinstance(vid, str) and VIDEO_ID_RE.match(vid):
            video_id = vid
    except (KeyError, TypeError):
        video_id = None
    if not video_id:
        return None

    title_runs = _flex_texts(item, 0)
    title = "".join(_runs_text(title_runs)).strip()
    if not title:
        return None

    sub_runs = _flex_texts(item, 1)
    # Split subtitle into segments on the " • " separators, keeping the
    # browseId of each segment for artist/album attribution.
    segments = split_subtitle(sub_runs)
    if not is_song_row(segments):
        return None
    seg_texts = [(s.get("text") or "").strip() for s in segments]
    artist, album, year = classify_segments(segments)
    artist_id = None
    album_id = None
    for s, part in zip(segments, seg_texts):
        if part == artist and artist_id is None:
            artist_id = s.get("browseId")
        elif part == album and album and album_id is None:
            album_id = s.get("browseId")
    duration_s = None
    # Duration may live in the fixed column or as a trailing subtitle part.
    for cand in _fixed_texts(item, 0):
        duration_s = parse_duration_to_seconds(cand)
        if duration_s is not None:
            break
    if duration_s is None:
        for part in seg_texts:
            duration_s = parse_duration_to_seconds(part)
            if duration_s is not None:
                break

    artwork = None
    try:
        thumbs = item["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"]
        artwork = pick_largest_thumbnail(thumbs)
    except (KeyError, TypeError):
        artwork = None

    track: dict = {
        "id": "youtube-music:%s" % video_id,
        "title": title,
        "artist": artist or "Unknown artist",
        "album": album or "",
        "duration": duration_s or 0,
        "artwork": artwork,
        "year": year,
        "videoId": video_id,
        "provider": "youtube-music",
    }
    if isinstance(artist_id, str) and BROWSE_ID_RE.match(artist_id):
        track["artistId"] = artist_id
    if isinstance(album_id, str) and BROWSE_ID_RE.match(album_id):
        track["albumId"] = album_id
    return track


def innertube_post(url: str, body: dict) -> tuple[int, object]:
    """POST JSON to InnerTube with timeout. Returns (status, parsed-json)."""
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=raw,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) KNOX-Music-Sidecar/1.0",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://music.youtube.com",
            "Referer": "https://music.youtube.com/",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = resp.read(MAX_BODY_BYTES + 1)
            if len(data) > MAX_BODY_BYTES:
                return err("INVALID_RESPONSE", "Upstream body too large.", 502)
            try:
                return (resp.status or 200, json.loads(data.decode("utf-8")))
            except (ValueError, UnicodeDecodeError):
                return err("INVALID_RESPONSE", "Upstream returned invalid data.", 502)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return err("RATE_LIMITED", "YouTube Music is rate-limiting discovery. Try again shortly.", 429)
        if e.code in (408, 500, 502, 503, 504):
            return err("UPSTREAM_UNAVAILABLE", "YouTube Music is temporarily unavailable.", 502)
        return err("INVALID_RESPONSE", "YouTube Music returned an unexpected response.", 502)
    except TimeoutError:
        return err("TIMEOUT", "YouTube Music search timed out.", 504)
    except Exception as e:
        if type(e).__name__ in ("TimeoutError", "socket.timeout") or "timed out" in str(e).lower():
            return err("TIMEOUT", "YouTube Music search timed out.", 504)
        return err("UPSTREAM_UNAVAILABLE", "YouTube Music is temporarily unavailable.", 502)


def try_ytmusicapi_search(query: str) -> tuple[int, object] | None:
    """Use ytmusicapi when installed (optional enhancement, never required)."""
    try:
        from ytmusicapi import YTMusic  # type: ignore
    except Exception:
        return None
    try:
        yt = YTMusic()
        raw = yt.search(query, filter="songs", limit=25)
        results: list[dict] = []
        for r in raw if isinstance(raw, list) else []:
            if not isinstance(r, dict):
                continue
            vid = r.get("videoId")
            if not isinstance(vid, str) or not VIDEO_ID_RE.match(vid):
                continue
            title = str(r.get("title") or "").strip() or "Untitled"
            artists = r.get("artists") or []
            names = [a.get("name") for a in artists if isinstance(a, dict) and a.get("name")]
            artist = ", ".join([str(n) for n in names]) or "Unknown artist"
            album = r.get("album") or {}
            album_name = str(album.get("name") or "") if isinstance(album, dict) else ""
            thumbs = r.get("thumbnails") or []
            artwork = pick_largest_thumbnail(thumbs if isinstance(thumbs, list) else [])
            if not artwork and isinstance(album, dict):
                artwork = pick_largest_thumbnail(album.get("thumbnails"))
            dur = r.get("duration_seconds") or r.get("duration")
            try:
                duration_s = int(dur) if dur is not None else 0
            except (ValueError, TypeError):
                duration_s = 0
            year = r.get("year")
            try:
                year = int(year) if year is not None else None
            except (ValueError, TypeError):
                year = None
            results.append({
                "id": "youtube-music:%s" % vid,
                "title": title,
                "artist": artist,
                "album": album_name,
                "duration": duration_s if duration_s > 0 else 0,
                "artwork": artwork,
                "year": year,
                "videoId": vid,
                "provider": "youtube-music",
            })
        return (200, {"results": results})
    except Exception:
        # Fall through to the stdlib InnerTube client below.
        return None


def do_search(query: str) -> tuple[int, object]:
    via_lib = try_ytmusicapi_search(query)
    if via_lib is not None:
        return via_lib
    status, payload = innertube_post(
        INNERTUBE_SEARCH_URL,
        {"context": {"client": INNERTUBE_CLIENT}, "query": query},
    )
    if status != 200:
        return (status, payload)
    if not isinstance(payload, dict):
        return err("INVALID_RESPONSE", "YouTube Music returned an unexpected response.", 502)
    return (200, {"results": parse_search_items(payload)})


def do_track(video_id: str) -> tuple[int, object]:
    via_lib = None
    try:
        from ytmusicapi import YTMusic  # type: ignore

        try:
            yt = YTMusic()
            info = yt.get_song(video_id)
            details = info.get("videoDetails", {}) if isinstance(info, dict) else {}
            title = str(details.get("title") or "").strip() or "Untitled"
            artist = str(details.get("author") or "").strip() or "Unknown artist"
            try:
                duration_s = int(details.get("lengthSeconds") or 0)
            except (ValueError, TypeError):
                duration_s = 0
            thumbs = (details.get("thumbnail") or {}).get("thumbnails")
            via_lib = (200, {"track": {
                "id": "youtube-music:%s" % video_id,
                "title": title, "artist": artist, "album": "",
                "duration": duration_s if duration_s > 0 else 0,
                "artwork": pick_largest_thumbnail(thumbs),
                "year": None, "videoId": video_id, "provider": "youtube-music",
            }})
        except Exception:
            via_lib = None
    except Exception:
        via_lib = None
    if via_lib is not None:
        return via_lib
    status, payload = innertube_post(
        INNERTUBE_PLAYER_URL,
        {"context": {"client": INNERTUBE_CLIENT}, "videoId": video_id},
    )
    if status != 200:
        return (status, payload)
    try:
        details = payload["videoDetails"]  # type: ignore[index]
        title = str(details.get("title") or "").strip() or "Untitled"
        artist = str(details.get("author") or "").strip() or "Unknown artist"
        try:
            duration_s = int(details.get("lengthSeconds") or 0)
        except (ValueError, TypeError):
            duration_s = 0
        thumbs = (details.get("thumbnail") or {}).get("thumbnails")
        return (200, {"track": {
            "id": "youtube-music:%s" % video_id,
            "title": title, "artist": artist, "album": "",
            "duration": duration_s if duration_s > 0 else 0,
            "artwork": pick_largest_thumbnail(thumbs),
            "year": None, "videoId": video_id, "provider": "youtube-music",
        }})
    except (KeyError, TypeError, AttributeError):
        return err("NOT_FOUND", "Track not found.", 404)


def do_browse(browse_id: str, kind: str) -> tuple[int, object]:
    status, payload = innertube_post(
        INNERTUBE_BROWSE_URL,
        {"context": {"client": INNERTUBE_CLIENT}, "browseId": browse_id},
    )
    if status != 200:
        return (status, payload)
    # Best-effort header title extraction across known header renderers.
    name: str | None = None
    try:
        header = payload["header"]  # type: ignore[index]
        for key in ("musicImmersiveHeaderRenderer", "musicDetailHeaderRenderer",
                    "musicVisualHeaderRenderer"):
            h = header.get(key) if isinstance(header, dict) else None
            if isinstance(h, dict):
                title = h.get("title")
                if isinstance(title, dict):
                    runs = title.get("runs")
                    if isinstance(runs, list) and runs and isinstance(runs[0], dict):
                        name = str(runs[0].get("text") or "").strip() or None
                        break
    except (KeyError, TypeError, AttributeError, IndexError):
        name = None
    if not name:
        return err("NOT_FOUND", "%s not found." % kind.capitalize(), 404)
    key = "artist" if kind == "artist" else "album"
    return (200, {key: {"id": "youtube-music:%s:%s" % (kind, browse_id),
                        "name" if kind == "artist" else "title": name,
                        "provider": "youtube-music"}})


class Handler(BaseHTTPRequestHandler):
    server_version = "KNOX-YouTubeMusic/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        # Single-line access log to stderr (captured by SidecarManager).
        # Path only, never query contents — no private data is logged.
        sys.stderr.write("sidecar %s %s\n" % (self.command, self.path.split("?")[0]))
        sys.stderr.flush()

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Loopback CORS: public discovery metadata only, so any local origin
        # (Vite dev server, Tauri webview) may fetch directly. Without this,
        # browsers block the response while curl succeeds — genuine results
        # then vanish from the UI even though the sidecar is healthy.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server convention)
        # CORS preflight for loopback browser fetches. No body.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 (http.server convention)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        qs = urllib.parse.parse_qs(parsed.query or "")

        if path in ("/health", "/api/health"):
            self._send(200, {"ok": True, "service": "knox-youtube-music"})
            return

        if path == "/api/search":
            query = (qs.get("q", qs.get("query", [""]))[0] if qs else "")
            query = (query or "").strip()
            if not query:
                self._send(400, {"error": {"code": "INVALID_QUERY", "message": "Query must not be empty."}})
                return
            if len(query) > MAX_QUERY_LEN:
                self._send(400, {"error": {"code": "INVALID_QUERY",
                                           "message": "Query too long (max %d characters)." % MAX_QUERY_LEN}})
                return
            status, payload = do_search(query)
            self._send(status, payload)
            return

        for prefix, kind in (("/api/track/", "track"), ("/api/artist/", "artist"), ("/api/album/", "album")):
            if path.startswith(prefix):
                raw_id = path[len(prefix):].strip()
                # Strict id validation: no traversal, no slashes, sane length.
                if (not raw_id or "/" in raw_id or "\\" in raw_id
                        or ".." in raw_id or len(raw_id) > 128):
                    self._send(400, {"error": {"code": "INVALID_QUERY", "message": "Invalid id."}})
                    return
                ident = urllib.parse.unquote(raw_id)
                # Accept provider-qualified ("youtube-music:<id>") or raw ids.
                if ":" in ident:
                    ident = ident.split(":")[-1]
                if kind == "track":
                    if not VIDEO_ID_RE.match(ident):
                        self._send(400, {"error": {"code": "INVALID_QUERY", "message": "Invalid track id."}})
                        return
                    status, payload = do_track(ident)
                else:
                    if not BROWSE_ID_RE.match(ident):
                        self._send(400, {"error": {"code": "INVALID_QUERY", "message": "Invalid id."}})
                        return
                    status, payload = do_browse(ident, kind)
                self._send(status, payload)
                return

        self._send(404, {"error": {"code": "NOT_FOUND", "message": "Not found."}})

    # Only the documented read API exists — reject everything else.
    def do_POST(self) -> None:  # noqa: N802
        self._send(405, {"error": {"code": "INVALID_QUERY", "message": "Method not allowed."}})

    def do_PUT(self) -> None:  # noqa: N802
        self._send(405, {"error": {"code": "INVALID_QUERY", "message": "Method not allowed."}})

    def do_DELETE(self) -> None:  # noqa: N802
        self._send(405, {"error": {"code": "INVALID_QUERY", "message": "Method not allowed."}})

    def do_PATCH(self) -> None:  # noqa: N802
        self._send(405, {"error": {"code": "INVALID_QUERY", "message": "Method not allowed."}})


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="KNOX YouTube Music sidecar (loopback only)")
    p.add_argument("--port", type=int, default=None,
                   help="loopback port (default: $PORT or 5000)")
    p.add_argument("--host", default="127.0.0.1",
                   help="bind host (default 127.0.0.1; never expose publicly)")
    return p.parse_args(argv)


def resolve_port(args: argparse.Namespace) -> int:
    if args.port:
        return args.port
    try:
        return int(os.environ.get("PORT", "5000"))
    except ValueError:
        return 5000


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.host not in ("127.0.0.1", "localhost", "::ffff:127.0.0.1"):
        sys.stderr.write("refusing to bind non-loopback host %r\n" % args.host)
        return 2
    host = "127.0.0.1"  # normalize: always IPv4 loopback
    port = resolve_port(args)
    server = HTTPServer((host, port), Handler)
    sys.stderr.write("knox-youtubemusic-sidecar on http://%s:%d (InnerTube)\n" % (host, port))
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
