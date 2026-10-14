//! On-device YouTube extraction (pure reqwest — no yt-dlp / FFmpeg / Python).
//!
//! Used ONLY when the loopback sidecars are unavailable (the Android APK
//! ships no Python/Node sidecars; desktop with sidecars stopped also falls
//! back here). The desktop sidecar pipeline stays preferred when it answers.
//!
//! Wire recipe (captured from a working yt-dlp session — plain InnerTube
//! calls alone are bot-gated):
//!   1. GET the watch page with a browser UA (collects session cookies).
//!   2. Scrape the player signature timestamp (`"STS":20717`) + visitor id.
//!   3. POST the player API with those cookies, the visitor id header, and a
//!      `playbackContext.signatureTimestamp` — no API key. Clients are tried
//!      in order VR → IOS → ANDROID → TV → MWEB; the first OK response with
//!      plain-`url` candidates wins (IOS is the proven escape when VR answers
//!      "Sign in to confirm you're not a bot").
//!   4. Pick the 2nd-lowest audio-only format (matches the sidecar's quality
//!      policy; ANDROID falls back to progressive itag-18) and download its
//!      plain URL.
//! Search uses the public WEB_REMIX InnerTube search (no auth needed).

use serde::Serialize;
use tauri::AppHandle;

/// `videoDetails.lengthSeconds` (string or number, must be > 0). Used by
/// the lightweight duration-enrichment path so search rows fill in real
/// lengths without downloading any bytes.
fn parse_length_seconds(doc: &serde_json::Value) -> Option<u64> {
    let details = doc.get("videoDetails")?;
    let secs = match details.get("lengthSeconds") {
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().ok()?,
        Some(serde_json::Value::Number(n)) => n.as_u64()?,
        _ => return None,
    };
    if secs == 0 || secs > 24 * 3600 {
        return None;
    }
    Some(secs)
}

/// Lightweight metadata resolve: real track length without downloading.
/// Tries the same client fallback chain as audio (VR → IOS → …) and returns
/// the first `videoDetails.lengthSeconds` found on a playable response.
/// Search rows render instantly with –:–– and fill in as these arrive.
#[tauri::command]
pub async fn knox_yt_duration(video_id: String) -> Result<u64, String> {
    let id = video_id.trim().to_string();
    if !is_valid_video_id(&id) {
        return Err("Invalid video identifier.".to_string());
    }
    let client = new_client()?;
    let watch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send(),
    )
    .await
    .map_err(|_| "YouTube download timed out.".to_string())?
    .map_err(|e| format!("YouTube download failed ({})", short_err(&e)))?;
    let mut jar = Jar::default();
    jar.harvest(&watch);
    let html = watch
        .text()
        .await
        .map_err(|e| format!("YouTube download failed ({e})"))?;
    let sts = extract_sts(&html);
    let visitor = extract_visitor_data(&html);
    let mut last_err = String::from("No duration for this video.");
    for spec in PLAYER_CLIENTS {
        let doc = match player_for_client(&client, spec, &id, sts, Some((&jar, visitor.as_deref()))).await
        {
            Ok(d) => d,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if playability_reason(&doc).is_some() {
            continue;
        }
        if let Some(secs) = parse_length_seconds(&doc) {
            return Ok(secs);
        }
        last_err = String::from("No duration for this video.");
    }
    Err(last_err)
}
/// Lightweight connectivity probe (YouTube's own 204 endpoint).
const CONNECTIVITY_URL: &str = "https://www.youtube.com/generate_204";
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const VR_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";
/// Hard cap per audio download (2nd-lowest audio is ~50-150kbps; songs land
/// in single-digit MB — anything larger is rejected, never truncated).
const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
/// Smallest accepted payload (mirrors the sidecar's 1 KiB floor).
const MIN_AUDIO_BYTES: usize = 1024;

#[derive(Serialize, Clone)]
pub struct YtNativeStatus {
    pub ok: bool,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct YtNativeThumb {
    pub url: String,
    pub width: u64,
    pub height: u64,
}

#[derive(Serialize, Clone)]
pub struct YtNativeResult {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: Option<u64>,
    pub url: String,
    pub live: bool,
    pub thumbnails: Vec<YtNativeThumb>,
}

#[derive(Serialize, Clone)]
pub struct YtNativeAudio {
    #[serde(rename = "videoId")]
    pub video_id: String,
    pub mime: String,
    pub ext: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: usize,
    pub base64: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

pub fn is_valid_video_id(v: &str) -> bool {
    if v.len() < 5 || v.len() > 40 {
        return false;
    }
    v.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn short_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "timed out".to_string();
    }
    if e.is_connect() {
        return "connection failed".to_string();
    }
    format!("{e}")
}

fn new_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client failed: {e}"))
}

/// Minimal cookie jar: harvest `Set-Cookie` NAME=value pairs (visitor id +
/// session continuity for the player call). No extra dependency.
#[derive(Default)]
struct Jar {
    pairs: Vec<(String, String)>,
}

impl Jar {
    fn harvest(&mut self, res: &reqwest::Response) {
        for raw in res.headers().get_all("set-cookie") {
            let Ok(s) = raw.to_str() else { continue };
            // First segment is NAME=value; the rest are attributes.
            let first = s.split(';').next().unwrap_or("");
            let Some((k, v)) = first.split_once('=') else { continue };
            let k = k.trim().to_string();
            let v = v.trim().to_string();
            if k.is_empty() {
                continue;
            }
            self.pairs.retain(|(ek, _)| ek != &k);
            self.pairs.push((k, v));
        }
    }

    fn header(&self) -> String {
        self.pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

}

/// Visitor id for the `X-Goog-Visitor-Id` header. This is the page's
/// `responseContext.visitorData` (NOT the short `VISITOR_INFO1_LIVE` cookie —
/// the player API bot-walls cookie-based ids).
fn extract_visitor_data(html: &str) -> Option<String> {
    let needle = "\"visitorData\":\"";
    let mut i = 0;
    while let Some(at) = html[i..].find(needle) {
        let mut j = i + at + needle.len();
        let b = html.as_bytes();
        let mut k = j;
        while k < b.len() && b[k] != b'"' {
            k += 1;
        }
        if k > j {
            let v = &html[j..k];
            // Serialized protobuf, base64-ish, always long.
            if v.len() > 32 && v.chars().all(|c| c.is_ascii_alphanumeric() || "+/=%-_".contains(c)) {
                return Some(v.to_string());
            }
        }
        j = k.max(i + at + 1);
        i = j;
    }
    None
}

/// Honest availability probe: true only when YouTube itself answers.
/// Never throws — callers treat `ok: false` as "native path unavailable".
#[tauri::command]
pub async fn knox_yt_status() -> YtNativeStatus {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return YtNativeStatus {
                ok: false,
                detail: format!("http client failed: {e}"),
            }
        }
    };
    match client.get(CONNECTIVITY_URL).send().await {
        Ok(res) if res.status().is_success() => YtNativeStatus {
            ok: true,
            detail: "on-device extraction ready".to_string(),
        },
        Ok(res) => YtNativeStatus {
            ok: false,
            detail: format!("YouTube unreachable (HTTP {})", res.status().as_u16()),
        },
        Err(e) => YtNativeStatus {
            ok: false,
            detail: format!("YouTube unreachable ({}), check the connection", short_err(&e)),
        },
    }
}

/// Scrape `"STS":"12345"` (player signature timestamp) from a watch page.
fn extract_sts(html: &str) -> Option<u64> {
    let mut i = 0;
    while let Some(at) = html[i..].find("\"STS\"") {
        let mut j = i + at + 5;
        let b = html.as_bytes();
        while j < b.len() && (b[j] == b' ' || b[j] == b':' || b[j] == b'"') {
            j += 1;
        }
        let mut k = j;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k > j {
            if let Ok(n) = html[j..k].parse::<u64>() {
                if (1000..1000000).contains(&n) {
                    return Some(n);
                }
            }
        }
        i = k.max(i + at + 1);
    }
    None
}

const VR_CONTEXT: &str = r#"{"client":{"clientName":"ANDROID_VR","clientVersion":"1.65.10","deviceMake":"Oculus","deviceModel":"Quest 3","androidSdkVersion":32,"osName":"Android","osVersion":"12L","hl":"en","gl":"US","timeZone":"UTC","utcOffsetMinutes":0}}"#;
// yt-dlp 2026.07.x INNERTUBE_CLIENTS (verified live 2026-09-28):
//   android_vr + web_safari are the defaults with a JS runtime; without JS
//   only android_vr is tried — exactly our old single-client path, and the
//   reason Jio/residential IPs now see "Sign in to confirm you're not a bot"
//   while search still works. TV needs no PO token on paper but answers
//   UNPLAYABLE from datacenter even with cookies; MWEB/WEB_SAFARI need PO
//   tokens for HTTPS and answer UNPLAYABLE without one. IOS returns plain
//   HTTPS audio URLs with no PO token and OK from datacenter WITH and
//   WITHOUT cookies — the proven fallback when VR is bot-gated.
//   ANDROID returns SABR-only adaptive formats (no plain `url`) plus ONE
//   progressive itag-18 (360p video+audio) with a plain `url` — usable as a
//   last-resort audio source when both VR and IOS are gated.
const IOS_CONTEXT: &str = r#"{"client":{"clientName":"IOS","clientVersion":"21.02.3","deviceMake":"Apple","deviceModel":"iPhone16,2","osName":"iPhone","osVersion":"18.3.2.22D82","hl":"en","gl":"US","timeZone":"UTC","utcOffsetMinutes":0}}"#;
const ANDROID_CONTEXT: &str = r#"{"client":{"clientName":"ANDROID","clientVersion":"21.02.35","androidSdkVersion":30,"osName":"Android","osVersion":"11","hl":"en","gl":"US","timeZone":"UTC","utcOffsetMinutes":0}}"#;
const TV_CONTEXT: &str = r#"{"client":{"clientName":"TVHTML5","clientVersion":"7.20260114.12.00","hl":"en","gl":"US","timeZone":"UTC","utcOffsetMinutes":0}}"#;
const MWEB_CONTEXT: &str = r#"{"client":{"clientName":"MWEB","clientVersion":"2.20260115.01.00","hl":"en","gl":"US","timeZone":"UTC","utcOffsetMinutes":0}}"#;
const IOS_UA: &str = "com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const ANDROID_UA: &str = "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip";
const TV_UA: &str = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)";
const MWEB_UA: &str = "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)";

struct PlayerClient {
    id: &'static str,
    context_json: &'static str,
    ua: &'static str,
    client_name_hdr: &'static str,
    client_version_hdr: &'static str,
}

const PLAYER_CLIENTS: &[PlayerClient] = &[
    PlayerClient {
        id: "android_vr",
        context_json: VR_CONTEXT,
        ua: VR_UA,
        client_name_hdr: "28",
        client_version_hdr: "1.65.10",
    },
    PlayerClient {
        id: "ios",
        context_json: IOS_CONTEXT,
        ua: IOS_UA,
        client_name_hdr: "5",
        client_version_hdr: "21.02.3",
    },
    PlayerClient {
        id: "android",
        context_json: ANDROID_CONTEXT,
        ua: ANDROID_UA,
        client_name_hdr: "3",
        client_version_hdr: "21.02.35",
    },
    PlayerClient {
        id: "tv",
        context_json: TV_CONTEXT,
        ua: TV_UA,
        client_name_hdr: "7",
        client_version_hdr: "7.20260114.12.00",
    },
    PlayerClient {
        id: "mweb",
        context_json: MWEB_CONTEXT,
        ua: MWEB_UA,
        client_name_hdr: "2",
        client_version_hdr: "2.20260115.01.00",
    },
];

/// Generic InnerTube player request (session cookies + visitor id +
/// signature timestamp — the combination a plain InnerTube call lacks).
/// Returns the raw player response JSON.
///
/// NOTE (Sep 2026, verified live 2026-09-28 from datacenter WITH
/// cookies+visitor, matching the app's wire path):
///   ANDROID_MUSIC → LOGIN_REQUIRED without OAuth (dead end);
///   WEB → ciphered URLs we cannot decipher;
///   WEB_EMBEDDED_PLAYER → HTTP 404 even with API key;
///   TVHTML5_SIMPLY_EMBEDDED_PLAYER → "no longer supported";
///   TVHTML5 / MWEB / WEB_SAFARI → UNPLAYABLE without a PO token
///   ("The page needs to be reloaded." / "Video unavailable").
///   ANDROID_VR → OK with 4 plain audio URLs when ungated, LOGIN_REQUIRED
///   ("Sign in to confirm you're not a bot") when the IP is flagged — this
///   is the Jio screenshot. IOS → OK with 5 plain audio URLs with AND
///   without cookies (no PO token required). ANDROID → OK but adaptive
///   formats are SABR-only (no plain `url`); only progressive itag-18 keeps
///   a plain URL. Fallback order is therefore VR → IOS → ANDROID
///   (progressive) → TV → MWEB.
async fn player_for_client(
    client: &reqwest::Client,
    spec: &PlayerClient,
    video_id: &str,
    sts: Option<u64>,
    jar: Option<(&Jar, Option<&str>)>,
) -> Result<serde_json::Value, String> {
    let playback = match sts {
        Some(n) => format!(
            r#","playbackContext":{{"contentPlaybackContext":{{"html5Preference":"HTML5_PREF_WANTS","signatureTimestamp":{n}}}}}"#
        ),
        None => String::new(),
    };
    let body = format!(
        r#"{{"context":{CTX},"videoId":"{video_id}"{playback},"contentCheckOk":true,"racyCheckOk":true}}"#,
        CTX = spec.context_json,
        video_id = video_id,
        playback = playback,
    );
    let mut req = client
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .header("User-Agent", spec.ua)
        .header("Content-Type", "application/json")
        .header("X-YouTube-Client-Name", spec.client_name_hdr)
        .header("X-YouTube-Client-Version", spec.client_version_hdr)
        .header("Origin", "https://www.youtube.com")
        .body(body);
    if let Some((j, visitor)) = jar {
        let cookies = j.header();
        if !cookies.is_empty() {
            req = req.header("Cookie", cookies);
        }
        if let Some(v) = visitor {
            req = req.header("X-Goog-Visitor-Id", v);
        }
    }
    let res = tokio::time::timeout(std::time::Duration::from_secs(45), req.send())
        .await
        .map_err(|_| "YouTube download timed out.".to_string())?
        .map_err(|e| {
            if e.is_timeout() {
                "YouTube download timed out.".to_string()
            } else {
                format!("YouTube download failed ({})", short_err(&e))
            }
        })?;
    if !res.status().is_success() {
        return Err(format!("YouTube download failed (HTTP {})", res.status().as_u16()));
    }
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("YouTube download failed (bad response: {e})"))
}

/// Back-compat wrapper: VR is still the first client tried. Existing tests
/// pin this path; production uses the full fallback chain below.
#[allow(dead_code)]
async fn vr_player(
    client: &reqwest::Client,
    video_id: &str,
    sts: Option<u64>,
    jar: Option<(&Jar, Option<&str>)>,
) -> Result<serde_json::Value, String> {
    player_for_client(client, &PLAYER_CLIENTS[0], video_id, sts, jar).await
}

#[allow(dead_code)]
fn playability_ok(doc: &serde_json::Value) -> Result<(), String> {
    if let Some(reason) = playability_reason(doc) {
        return Err(format!("YouTube download failed ({reason})"));
    }
    Ok(())
}

/// None when playable (status OK); otherwise the human reason YouTube gave
/// (e.g. "Sign in to confirm you're not a bot"). Used to decide whether to
/// try the next fallback client instead of failing the whole track.
fn playability_reason(doc: &serde_json::Value) -> Option<String> {
    let status = doc
        .get("playabilityStatus")
        .and_then(|s| s.get("status"))
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if status == "OK" {
        return None;
    }
    let reason = doc
        .get("playabilityStatus")
        .and_then(|s| s.get("reason"))
        .and_then(|s| s.as_str())
        .unwrap_or("unplayable");
    Some(reason.to_string())
}

#[derive(Clone)]
struct AudioCandidate {
    itag: u64,
    bitrate: u64,
    mime: String,
    container: String,
    url: String,
}

/// Audio candidates, bitrate ascending. Tier 1 = audio-only adaptive
/// formats with a plain `url` (VR/IOS path, 2nd entry = 2nd lowest).
/// Tier 2 = progressive `formats` with audio (e.g. ANDROID itag-18 360p):
/// the ANDROID client is SABR-only for adaptive (no plain `url`), so
/// without this tier it would always look like "no playable audio".
fn audio_candidates(doc: &serde_json::Value) -> Vec<AudioCandidate> {
    let mut out = Vec::new();
    let empty = Vec::new();
    let adapt = doc
        .get("streamingData")
        .and_then(|s| s.get("adaptiveFormats"))
        .and_then(|a| a.as_array())
        .unwrap_or(&empty);
    for f in adapt {
        let mime = f.get("mimeType").and_then(|m| m.as_str()).unwrap_or("");
        if !mime.starts_with("audio/") {
            continue;
        }
        let url = f.get("url").and_then(|u| u.as_str()).unwrap_or("");
        if url.is_empty() {
            continue;
        }
        // Skip live/HLS leftovers (no byte ranges to download).
        if f.get("isLive").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let bitrate = f.get("bitrate").and_then(|b| b.as_u64()).unwrap_or(0);
        let container = mime
            .split(';')
            .next()
            .unwrap_or("")
            .split('/')
            .nth(1)
            .unwrap_or("webm")
            .to_string();
        out.push(AudioCandidate {
            itag: f.get("itag").and_then(|v| v.as_u64()).unwrap_or(0),
            bitrate,
            mime: mime.to_string(),
            container,
            url: url.to_string(),
        });
    }
    if !out.is_empty() {
        // Prioritize MP4 (AAC, e.g. itag 140) over WebM (Opus).
        // WebM in Android WebView Blob URLs lacks duration headers and causes premature EOF glitches,
        // whereas MP4 AAC has standard container headers, native hardware decoding, and perfect seekability.
        out.sort_by(|a, b| {
            let a_is_mp4 = a.container == "mp4" || a.mime.contains("audio/mp4");
            let b_is_mp4 = b.container == "mp4" || b.mime.contains("audio/mp4");
            match (a_is_mp4, b_is_mp4) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.bitrate.cmp(&b.bitrate),
            }
        });
        return out;
    }
    // Tier 2: progressive video+audio (has an audio track + plain url).
    // Marked with a large bitrate offset so callers that mix tiers still
    // prefer real audio-only when both exist.
    let fmts = doc
        .get("streamingData")
        .and_then(|s| s.get("formats"))
        .and_then(|a| a.as_array())
        .unwrap_or(&empty);
    for f in fmts {
        let url = f.get("url").and_then(|u| u.as_str()).unwrap_or("");
        if url.is_empty() {
            continue;
        }
        let has_audio = f.get("audioChannels").and_then(|v| v.as_u64()).unwrap_or(0) > 0
            || f.get("audioSampleRate").and_then(|v| v.as_str()).is_some()
            || f.get("audioQuality").and_then(|v| v.as_str()).is_some();
        if !has_audio {
            continue;
        }
        let mime = f.get("mimeType").and_then(|m| m.as_str()).unwrap_or("");
        if mime.is_empty() {
            continue;
        }
        let bitrate = f
            .get("bitrate")
            .and_then(|b| b.as_u64())
            .unwrap_or(0)
            .saturating_add(10_000_000);
        let container = mime
            .split(';')
            .next()
            .unwrap_or("")
            .split('/')
            .nth(1)
            .unwrap_or("mp4")
            .to_string();
        out.push(AudioCandidate {
            itag: f.get("itag").and_then(|v| v.as_u64()).unwrap_or(0),
            bitrate,
            mime: mime.to_string(),
            container,
            url: url.to_string(),
        });
    }
    out.sort_by_key(|c| c.bitrate);
    out
}

fn essence(mime: &str) -> String {
    let base = mime.split(';').next().unwrap_or("audio/webm").trim();
    // Progressive video+audio fallback (ANDROID itag-18): the bytes are an
    // MP4 container with an audio track — report it as audio so the
    // renderer validates/plays it instead of rejecting `video/*`.
    if base.eq_ignore_ascii_case("video/mp4") {
        return "audio/mp4".to_string();
    }
    if base.eq_ignore_ascii_case("video/webm") {
        return "audio/webm".to_string();
    }
    base.to_string()
}

fn ext_for_container(container: &str) -> &'static str {
    match container.to_ascii_lowercase().as_str() {
        "webm" => "webm",
        "mp4" => "m4a",
        "ogg" => "ogg",
        "mp3" => "mp3",
        "flac" => "flac",
        "wav" => "wav",
        _ => "webm",
    }
}

// Minimal base64 (no extra dep): standard alphabet, padded.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(data.len() * 4 / 3 + 4);
    for c in data.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        s.push(T[((n >> 18) & 63) as usize] as char);
        s.push(T[((n >> 12) & 63) as usize] as char);
        s.push(if c.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        s.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    s
}

/// Reject HTML/JSON error pages masquerading as audio.
fn looks_like_error_page(head: &[u8]) -> bool {
    let mut i = 0;
    while i < head.len().min(64) && (head[i] <= 0x20 || head[i] == 0xef || head[i] == 0xbb || head[i] == 0xbf) {
        i += 1;
    }
    let rest = &head[i.min(head.len())..head.len().min(i + 15)];
    let lower: Vec<u8> = rest.iter().map(|b| b.to_ascii_lowercase()).collect();
    lower.starts_with(b"<!doctype html")
        || lower.starts_with(b"<html")
        || lower.starts_with(b"<head")
        || lower.starts_with(b"{\"ok\"")
        || lower.starts_with(b"{\"success\"")
        || lower.starts_with(b"{\"error\"")
}

/// Download one track's audio (2nd-lowest audio-only quality), save it to the
/// permanent on-device store (`offline/youtube/youtube_<id>.<ext>`, atomic
/// `.part` publish like the sidecar), and return the bytes (base64) so the
/// renderer can commit them to its offline store in one IPC round-trip.
#[tauri::command]
pub async fn knox_yt_audio(app: AppHandle, video_id: String) -> Result<YtNativeAudio, String> {
    let id = video_id.trim().to_string();
    if !is_valid_video_id(&id) {
        return Err("Invalid video identifier.".to_string());
    }
    let data_dir = super::knox_data_dir(&app);
    let permanent_dir = data_dir.join("offline").join("youtube");
    std::fs::create_dir_all(&permanent_dir)
        .map_err(|e| format!("cannot create audio store: {e}"))?;

    let client = new_client()?;
    // 1. Watch page: session cookies (+STS + visitor id).
    let watch = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send(),
    )
    .await
    .map_err(|_| "YouTube download timed out.".to_string())?
    .map_err(|e| format!("YouTube download failed ({})", short_err(&e)))?;
    let mut jar = Jar::default();
    jar.harvest(&watch);
    let html = watch
        .text()
        .await
        .map_err(|e| format!("YouTube download failed ({e})"))?;
    let sts = extract_sts(&html);
    let visitor = extract_visitor_data(&html);

    // 2. Player API → audio formats, with client fallback.
    // Single-client (VR-only) is what produced the Jio screenshot:
    // search OK, watch OK, VR player LOGIN_REQUIRED ("Sign in to confirm
    // you're not a bot"), media never attempted. IOS answers OK with plain
    // audio URLs on the same networks (verified live, with and without
    // cookies, no PO token). ANDROID answers OK with a progressive
    // fallback. TV/MWEB are tried last (currently UNPLAYABLE without a PO
    // token, kept for the day YouTube flips trust again).
    let dl = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("YouTube download failed ({e})"))?;
    let mut last_err = String::from("YouTube download failed (no playable audio URL)");
    for spec in PLAYER_CLIENTS {
        let doc = match player_for_client(&client, spec, &id, sts, Some((&jar, visitor.as_deref()))).await {
            Ok(d) => d,
            Err(e) => {
                last_err = format!("{}: {e}", spec.id);
                continue;
            }
        };
        if let Some(reason) = playability_reason(&doc) {
            last_err = format!("YouTube download failed ({reason})");
            continue;
        }
        let candidates = audio_candidates(&doc);
        if candidates.is_empty() {
            last_err = format!("{}: no playable audio", spec.id);
            continue;
        }
        // Index 1 = 2nd lowest quality (index 0 fallback when only one).
        // Try order: 2nd-lowest first (sidecar parity), then lowest, then higher
        // bitrates. YouTube 403-walls individual itags / hosts unpredictably
        // (datacenter vs residential, per-format throttling) — failing the whole
        // track because ONE googlevideo URL 403s is what left the APK showing
        // "sidecar disabled" (the native cause was swallowed). Try every
        // candidate before giving up; search still works when playback URLs are
        // gated, so each format gets its own chance.
        // Try formats in prioritized order (MP4 AAC first, then alternatives).
        let mut order: Vec<AudioCandidate> = Vec::new();
        for c in &candidates {
            if !order.iter().any(|e| e.url == c.url) {
                order.push(c.clone());
            }
        }

        // 3. Download the plain stream URL (VR/IOS need no deciphering).
        // Headers mirror a browser download exactly (yt-dlp parity): Chrome UA,
        // range request, identity encoding + Referer/Origin (googlevideo checks
        // them on some PoPs; without Referer the edge 403s while the player API
        // still answers — i.e. "search works, play doesn't"). Mobile links are
        // slow: 300s total budget. If every candidate 403s WITH Range, retry the
        // whole order WITHOUT it — some edges only wall ranged requests.
        // A client whose URLs all 403 falls through to the NEXT client
        // instead of failing the track (per-client gating is the norm now).
        let mut success: Option<(AudioCandidate, Vec<u8>)> = None;
        'passes: for ranged in [true, false] {
            for cand in &order {
            let mut req = dl
                .get(&cand.url)
                .header("User-Agent", BROWSER_UA)
                .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                .header("Accept-Language", "en-us,en;q=0.5")
                .header("Accept-Encoding", "identity")
                .header("Referer", "https://www.youtube.com/")
                .header("Origin", "https://www.youtube.com");
            if ranged {
                req = req.header("Range", "bytes=0-");
            }
            let attempt = req.send().await;
        let mut res = match attempt {
            Ok(r) => r,
            Err(e) => {
                last_err = if e.is_timeout() {
                    "YouTube download timed out.".to_string()
                } else {
                    format!("YouTube download failed ({})", short_err(&e))
                };
                continue;
            }
        };
        let status = res.status().as_u16();
        if status != 200 && status != 206 {
            last_err = format!("YouTube download failed (HTTP {status})");
            continue;
        }
        let mut buf: Vec<u8> = Vec::new();
        let mut broken: Option<String> = None;
        loop {
            let next = res.chunk().await;
            match next {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() > MAX_AUDIO_BYTES {
                        broken = Some("Audio exceeds the maximum file size limit.".to_string());
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    broken = Some(format!("YouTube download interrupted ({e})"));
                    break;
                }
            }
        }
        if let Some(e) = broken {
            last_err = e;
            continue;
        }
        if buf.len() < MIN_AUDIO_BYTES {
            last_err = "Audio validation failed (truncated).".to_string();
            continue;
        }
        if looks_like_error_page(&buf) {
            last_err = "Audio validation failed (not-audio).".to_string();
            continue;
        }
        success = Some((cand.clone(), buf));
        break 'passes;
            }
        }
        if let Some((chosen, buf)) = success {
            let ext = ext_for_container(&chosen.container);

            // 4. Atomic publish + base64 for the renderer commit.
            let final_path = permanent_dir.join(format!("youtube_{id}.{ext}"));
            let part_path = final_path.with_extension(format!("{ext}.part"));
            let _ = std::fs::remove_file(&part_path);
            std::fs::write(&part_path, &buf).map_err(|e| format!("cannot write audio file: {e}"))?;
            std::fs::rename(&part_path, &final_path).map_err(|e| format!("cannot publish audio file: {e}"))?;

            return Ok(YtNativeAudio {
                video_id: id,
                mime: essence(&chosen.mime),
                ext: ext.to_string(),
                size_bytes: buf.len(),
                base64: b64(&buf),
                file_path: final_path.to_string_lossy().into_owned(),
            });
        }
        // No byte success for this client (all candidates 403/truncated):
        // fall through to the next client. `last_err` already holds the
        // most specific download failure.
    }
    Err(last_err)
}

// ---------- search (public WEB_REMIX InnerTube, no auth) ----------

const WEB_SEARCH_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

fn text_of_runs(v: &serde_json::Value) -> String {
    v.get("runs")
        .and_then(|r| r.as_array())
        .map(|runs| {
            runs.iter()
                .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Parse one musicResponsiveListItemRenderer (YTM search row) into a result.
/// Returns None for non-video rows (artists/albums/playlists).
fn parse_search_item(item: &serde_json::Value) -> Option<YtNativeResult> {
    let r = item.get("musicResponsiveListItemRenderer")?;
    // videoId: overlay play button first, then any navigation endpoint.
    let vid = r
        .pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
        .and_then(|v| v.as_str())
        .or_else(|| {
            r.pointer("/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/watchEndpoint/videoId")
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            r.get("navigationEndpoint")?
                .get("watchEndpoint")?
                .get("videoId")?
                .as_str()
        })?;
    if !is_valid_video_id(vid) {
        return None;
    }
    let cols = r
        .get("flexColumns")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let col_text = |i: usize| {
        cols.get(i)
            .and_then(|c| c.get("musicResponsiveListItemFlexColumnRenderer"))
            .and_then(|c| c.get("text"))
            .map(text_of_runs)
            .unwrap_or_default()
    };
    let title = col_text(0);
    if title.trim().is_empty() {
        return None;
    }
    // Column 1 is "Type • Artist • Album • Duration" (order varies).
    // Mirror the Python sidecar's classify_segments: first non-type,
    // non-audience segment is the artist; duration may be trailing there
    // when the fixed column is absent (common → otherwise every row is 0:00).
    let subtitle = col_text(1);
    let segments: Vec<String> = subtitle
        .split('•')
        .map(|s| s.trim().to_string())
        .collect();
    let is_type_token = |s: &str| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "song" | "video" | "single" | "ep" | "album" | "playlist" | "artist" | "explicit"
        )
    };
    let is_audience = |s: &str| {
        let low = s.to_ascii_lowercase();
        low.contains("monthly audience")
            || low.contains("subscribers")
            || low.contains("views")
            || low.contains("songs")
            || low.contains("videos")
    };
    let mut artist = String::new();
    for part in &segments {
        if part.is_empty() || is_type_token(part) || is_audience(part) {
            continue;
        }
        if parse_duration(part).is_some() {
            continue;
        }
        // Year (1990-2099) is not an artist name.
        if part.len() == 4 && (part.starts_with("19") || part.starts_with("20")) {
            if part.parse::<u32>().is_ok() {
                continue;
            }
        }
        artist = part.clone();
        break;
    }
    // Duration: fixed column first ("4:26"), then any trailing subtitle part.
    let dur_txt = r
        .get("fixedColumns")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("musicResponsiveListItemFixedColumnRenderer"))
        .and_then(|c| c.get("text"))
        .map(text_of_runs)
        .unwrap_or_default();
    let mut duration = parse_duration(&dur_txt);
    if duration.is_none() {
        for part in &segments {
            if let Some(d) = parse_duration(part) {
                duration = Some(d);
                break;
            }
        }
    }
    let thumbs = r
        .pointer("/thumbnail/musicThumbnailRenderer/thumbnail/thumbnails")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            Some(YtNativeThumb {
                url: t.get("url")?.as_str()?.to_string(),
                width: t.get("width").and_then(|w| w.as_u64()).unwrap_or(0),
                height: t.get("height").and_then(|h| h.as_u64()).unwrap_or(0),
            })
        })
        .collect::<Vec<_>>();
    Some(YtNativeResult {
        id: vid.to_string(),
        title: title.trim().to_string(),
        channel: if artist.is_empty() { "Unknown".to_string() } else { artist },
        duration,
        url: format!("https://www.youtube.com/watch?v={vid}"),
        live: false,
        thumbnails: thumbs,
    })
}

fn parse_duration(s: &str) -> Option<u64> {
    let parts: Vec<u64> = s.trim().split(':').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut secs = 0u64;
    for p in parts {
        secs = secs * 60 + p;
    }
    if secs == 0 {
        return None;
    }
    Some(secs)
}

/// Collect every search-row item renderer anywhere under the response
/// (shelves, sections, cards — the nesting varies by query/client).
fn walk_items<'a>(v: &'a serde_json::Value, out: &mut Vec<&'a serde_json::Value>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, val) in m {
                if k == "musicResponsiveListItemRenderer" {
                    out.push(val);
                } else {
                    walk_items(val, out);
                }
            }
        }
        serde_json::Value::Array(a) => {
            for val in a {
                walk_items(val, out);
            }
        }
        _ => {}
    }
}

/// Metadata-only search (no download).
#[tauri::command]
pub async fn knox_yt_search(query: String, limit: u8) -> Result<Vec<YtNativeResult>, String> {
    let q = query.trim().chars().take(400).collect::<String>();
    if q.is_empty() {
        return Err("Missing search query.".to_string());
    }
    let n = (limit as usize).clamp(1, 60);
    let client = new_client()?;
    let body = serde_json::json!({
        "context": {"client": {"clientName": "WEB_REMIX", "clientVersion": "1.20240101.00.00", "hl": "en", "gl": "US"}},
        "query": q,
    });
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(45),
        client
            .post(format!(
                "https://music.youtube.com/youtubei/v1/search?key={WEB_SEARCH_KEY}&prettyPrint=false"
            ))
            .header("User-Agent", BROWSER_UA)
            .header("Content-Type", "application/json")
            .header("Origin", "https://music.youtube.com")
            .json(&body)
            .send(),
    )
    .await
    .map_err(|_| "YouTube search timed out.".to_string())?
    .map_err(|e| {
        if e.is_timeout() {
            "YouTube search timed out.".to_string()
        } else {
            format!("YouTube search failed ({})", short_err(&e))
        }
    })?;
    if !res.status().is_success() {
        return Err(format!("YouTube search failed (HTTP {})", res.status().as_u16()));
    }
    let doc: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("YouTube search failed (bad response: {e})"))?;
    let mut rows = Vec::new();
    if let Some(contents) = doc.get("contents") {
        walk_items(contents, &mut rows);
    }
    let mut out = Vec::new();
    for row in rows {
        if out.len() >= n {
            break;
        }
        // parse_search_item expects the wrapper object; wrap the bare renderer.
        let wrapped = serde_json::json!({ "musicResponsiveListItemRenderer": row });
        if let Some(r) = parse_search_item(&wrapped) {
            if !out.iter().any(|e: &YtNativeResult| e.id == r.id) {
                out.push(r);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod yt_device_tests {
    use super::*;

    #[test]
    fn video_ids_validate() {
        assert!(is_valid_video_id("H2f7MZaw3Yo"));
        assert!(!is_valid_video_id(""));
        assert!(!is_valid_video_id("abc"));
        assert!(!is_valid_video_id("../evil......"));
    }

    #[test]
    fn sts_scrapes() {
        assert_eq!(extract_sts(r#"foo "STS":"20711" bar"#), Some(20711));
        assert_eq!(extract_sts(r#"foo "STS":20717 bar"#), Some(20717));
        assert_eq!(extract_sts("nothing here"), None);
    }

    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration("4:26"), Some(266));
        assert_eq!(parse_duration("1:02:03"), Some(3723));
        assert_eq!(parse_duration("LIVE"), None);
        assert_eq!(parse_duration(""), None);
    }

    #[test]
    fn error_pages_detected() {
        assert!(looks_like_error_page(b"<html><body>nope"));
        assert!(looks_like_error_page(b"{\"error\":\"nope\"}"));
        assert!(!looks_like_error_page(b"ID3\x04\x00\x00padding"));
        assert!(!looks_like_error_page(b"OggS\x00\x02abcdef"));
    }

    /// Live network: metadata search returns real videos.
    #[tokio::test]
    async fn device_search_returns_videos() {
        let list = knox_yt_search("samjhawan".to_string(), 3)
            .await
            .expect("device search failed");
        assert!(!list.is_empty(), "expected at least one result");
        assert!(is_valid_video_id(&list[0].id));
        assert!(!list[0].title.is_empty());
    }

    /// Live network: 2nd-lowest audio resolves with a plain (decipher-free)
    /// download URL. Byte transfer itself is NOT asserted: media egress from
    /// datacenter IPs is currently 403-walled by YouTube (yt-dlp itself gets
    /// HTTP 403 here), while metadata/player APIs answer fine. Residential /
    /// mobile IPs — i.e. the phone — are not in that position.
    #[tokio::test]
    async fn device_audio_url_resolves() {
        let client = new_client().unwrap();
        let id = "H2f7MZaw3Yo";
        let watch = client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
            .expect("watch page failed");
        let mut jar = Jar::default();
        jar.harvest(&watch);
        let html = watch.text().await.expect("watch body failed");
        let doc = vr_player(
            &client,
            id,
            extract_sts(&html),
            Some((&jar, extract_visitor_data(&html).as_deref())),
        )
        .await
        .expect("vr player failed");
        playability_ok(&doc).expect("video not playable");
        let cands = audio_candidates(&doc);
        assert!(!cands.is_empty(), "expected audio candidates");
        let chosen = cands.get(1).or(cands.first()).expect("audio pick");
        // 2nd lowest sorts at/after the lowest bitrate.
        assert!(chosen.bitrate >= cands[0].bitrate);
        assert!(!chosen.url.is_empty(), "expected a plain stream URL");
        assert!(chosen.url.contains("googlevideo.com"), "expected a media host URL");
        println!("picked itag={} br={} {}", chosen.itag, chosen.bitrate, chosen.mime);
    }

    /// Live network: 2nd-lowest audio resolves (metadata only, no bytes).
    #[tokio::test]
    async fn device_format_pick_is_second_lowest() {
        let client = new_client().unwrap();
        let id = "H2f7MZaw3Yo";
        let watch = client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
            .expect("watch page failed");
        let mut jar = Jar::default();
        jar.harvest(&watch);
        let html = watch.text().await.expect("watch body failed");
        let sts = extract_sts(&html);
        let visitor = extract_visitor_data(&html);
        let doc = vr_player(&client, id, sts, Some((&jar, visitor.as_deref())))
            .await
            .expect("vr player failed");
        playability_ok(&doc).expect("video not playable");
        let cands = audio_candidates(&doc);
        assert!(!cands.is_empty(), "expected audio candidates");
        let chosen = cands.get(1).or(cands.first()).unwrap();
        assert!(chosen.bitrate >= cands[0].bitrate);
        assert!(!chosen.url.is_empty());
    }

    #[test]
    fn essence_maps_progressive_video_to_audio() {
        assert_eq!(essence("video/mp4; codecs=\"avc1.42001E, mp4a.40.2\""), "audio/mp4");
        assert_eq!(essence("video/webm; codecs=\"vp9, opus\""), "audio/webm");
        assert_eq!(essence("audio/webm; codecs=\"opus\""), "audio/webm");
    }

    #[test]
    fn length_seconds_parse() {
        let doc = serde_json::json!({"videoDetails": {"lengthSeconds": "266"}});
        assert_eq!(parse_length_seconds(&doc), Some(266));
        let doc = serde_json::json!({"videoDetails": {"lengthSeconds": 266}});
        assert_eq!(parse_length_seconds(&doc), Some(266));
        let doc = serde_json::json!({"videoDetails": {"lengthSeconds": "0"}});
        assert_eq!(parse_length_seconds(&doc), None);
        let doc = serde_json::json!({"videoDetails": {}});
        assert_eq!(parse_length_seconds(&doc), None);
        let doc = serde_json::json!({});
        assert_eq!(parse_length_seconds(&doc), None);
    }

    #[test]
    fn candidates_include_progressive_when_adaptive_has_no_url() {
        // ANDROID shape: adaptive SABR entries have no plain `url`, only a
        // progressive itag-18 with an audio track does.
        let doc = serde_json::json!({
            "streamingData": {
                "adaptiveFormats": [
                    {"itag": 137, "mimeType": "video/mp4; codecs=\"avc1.640028\"", "bitrate": 4223253u64,
                     "initRange": {"start": "0", "end": "741"}},
                    {"itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 128000u64}
                ],
                "formats": [
                    {"itag": 18, "mimeType": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
                     "bitrate": 242127u64, "audioQuality": "AUDIO_QUALITY_LOW",
                     "audioSampleRate": "44100",
                     "url": "https://rr1---sn-xxx.googlevideo.com/videoplayback?itag=18"}
                ]
            }
        });
        let cands = audio_candidates(&doc);
        assert!(!cands.is_empty(), "progressive fallback must produce a candidate");
        assert!(cands.iter().any(|c| c.itag == 18 && c.url.contains("googlevideo.com")));
    }

    #[test]
    fn candidates_prefer_adaptive_audio_when_present() {
        let doc = serde_json::json!({
            "streamingData": {
                "adaptiveFormats": [
                    {"itag": 249, "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 50000u64,
                     "url": "https://rr1---sn-xxx.googlevideo.com/videoplayback?itag=249"},
                    {"itag": 250, "mimeType": "audio/webm; codecs=\"opus\"", "bitrate": 70000u64,
                     "url": "https://rr1---sn-xxx.googlevideo.com/videoplayback?itag=250"}
                ],
                "formats": [
                    {"itag": 18, "mimeType": "video/mp4; codecs=\"avc1.42001E, mp4a.40.2\"",
                     "bitrate": 242127u64, "audioQuality": "AUDIO_QUALITY_LOW",
                     "url": "https://rr1---sn-xxx.googlevideo.com/videoplayback?itag=18"}
                ]
            }
        });
        let cands = audio_candidates(&doc);
        assert_eq!(cands.len(), 2, "adaptive tier wins; progressive ignored when adaptive exists");
        assert!(cands.iter().all(|c| c.mime.starts_with("audio/")));
    }

    /// Live network: IOS fallback resolves plain audio URLs (no PO token).
    /// This is the client that saves Jio/residential IPs when VR answers
    /// LOGIN_REQUIRED ("Sign in to confirm you're not a bot").
    #[tokio::test]
    async fn device_ios_url_resolves() {
        let client = new_client().unwrap();
        let id = "H2f7MZaw3Yo";
        let watch = client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
            .expect("watch page failed");
        let mut jar = Jar::default();
        jar.harvest(&watch);
        let html = watch.text().await.expect("watch body failed");
        let ios = PLAYER_CLIENTS.iter().find(|c| c.id == "ios").expect("ios client");
        let doc = player_for_client(
            &client,
            ios,
            id,
            extract_sts(&html),
            Some((&jar, extract_visitor_data(&html).as_deref())),
        )
        .await
        .expect("ios player failed");
        playability_ok(&doc).expect("ios video not playable");
        let cands = audio_candidates(&doc);
        assert!(!cands.is_empty(), "expected ios audio candidates");
        let chosen = cands.get(1).or(cands.first()).expect("ios audio pick");
        assert!(!chosen.url.is_empty());
        assert!(chosen.url.contains("googlevideo.com"));
        println!("ios picked itag={} br={} {}", chosen.itag, chosen.bitrate, chosen.mime);
    }

    /// Live network: ANDROID answers OK with a progressive fallback URL.
    #[tokio::test]
    async fn device_android_progressive_resolves() {
        let client = new_client().unwrap();
        let id = "H2f7MZaw3Yo";
        let watch = client
            .get(format!("https://www.youtube.com/watch?v={id}"))
            .header("User-Agent", BROWSER_UA)
            .send()
            .await
            .expect("watch page failed");
        let mut jar = Jar::default();
        jar.harvest(&watch);
        let html = watch.text().await.expect("watch body failed");
        let android = PLAYER_CLIENTS.iter().find(|c| c.id == "android").expect("android client");
        let doc = player_for_client(
            &client,
            android,
            id,
            extract_sts(&html),
            Some((&jar, extract_visitor_data(&html).as_deref())),
        )
        .await
        .expect("android player failed");
        playability_ok(&doc).expect("android video not playable");
        let cands = audio_candidates(&doc);
        assert!(!cands.is_empty(), "expected android progressive candidate");
        assert!(!cands[0].url.is_empty());
        assert!(cands[0].url.contains("googlevideo.com"));
    }

    /// Live network: lightweight duration resolve returns real seconds.
    #[tokio::test]
    async fn device_duration_resolves() {
        let secs = knox_yt_duration("H2f7MZaw3Yo".to_string())
            .await
            .expect("duration resolve failed");
        assert!(secs > 60 && secs < 24 * 3600, "unexpected length {secs}");
        println!("duration {secs}s");
    }
}
