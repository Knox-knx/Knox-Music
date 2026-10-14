//! KNOX Music desktop host (Tauri).
//!
//! Startup sequence (§18):
//!   1. launch shell → 2. data dir → 3. config/token → 4. bind loopback API →
//!   5. start local API → 6. renderer init → 7. UI connects → 8. UI drives
//!      KNOX Core init + sidecars (renderer owns settings; host owns processes).
//!
//! Shutdown (§19, idempotent): stop sidecars → stop API (runtime drops with
//! the process) → exit. Calling shutdown twice is safe.

mod api;
mod gst_env;
mod input_env;
mod sidecar;
mod yt_device;

use api::{bind_loopback, log_line, serve, ApiState};
use serde::Serialize;
use sidecar::{find_node, find_python, find_sidecar_script, SidecarRegistry, SidecarSpec};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

pub(crate) struct KnoxHost {
    port: u16,
    token: String,
    data_dir: PathBuf,
    log_path: PathBuf,
    pub(crate) state: ApiState,
}

pub fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn knox_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("KNOX Music"))
        .unwrap_or_else(|_| PathBuf::from("KNOX Music"))
}

fn ensure_data_dirs(data_dir: &std::path::Path) {
    for sub in ["database", "artwork", "lyrics", "cache", "offline", "playlists", "logs", "backups"] {
        let _ = std::fs::create_dir_all(data_dir.join(sub));
    }
    // Temporary playback buffer root (short-lived per-session audio only).
    // Sessions are cleaned on shutdown/startup; never user downloads.
    let _ = std::fs::create_dir_all(data_dir.join("temp").join("playback"));
}

#[derive(Serialize, Clone)]
struct ApiConfig {
    port: u16,
    token: String,
    data_dir: String,
    version: String,
}

/// Renderer bootstrap: loopback port + per-launch token + data dir.
/// The token is handed over IPC only — never logged, never persisted.
#[tauri::command]
fn knox_api_config(host: State<'_, KnoxHost>) -> ApiConfig {
    ApiConfig {
        port: host.port,
        token: host.token.clone(),
        data_dir: host.data_dir.to_string_lossy().into_owned(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[derive(Serialize, Clone)]
struct SidecarStatusDto {
    name: String,
    state: String,
    port: Option<u16>,
    last_error: Option<String>,
}

/// Egress proxy over IPC (no loopback socket from the page).
///
/// Mobile WebViews block https-page → http-127.0.0.1 as mixed content, so the
/// renderer cannot always reach the loopback API. This command runs the exact
/// same allowlisted provider fetch server-side and returns the body. Same
/// guards as the HTTP route (provider/host allowlist, https-only, 8KB target
/// cap, 10MB body cap) — enforced inside `api::proxy_fetch`.
#[derive(Serialize, Clone)]
struct ProxyGetResult {
    status: u16,
    #[serde(rename = "contentType")]
    content_type: String,
    body: String,
}

#[tauri::command]
async fn knox_proxy_get(
    host: State<'_, KnoxHost>,
    provider: String,
    target: String,
) -> Result<ProxyGetResult, String> {
    match api::proxy_fetch(&host.state, &provider, &target).await {
        Ok((status, content_type, bytes)) => Ok(ProxyGetResult {
            status,
            content_type,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }),
        Err((status, msg)) => Err(format!("proxy {provider} failed (HTTP {status}): {msg}")),
    }
}

/// Desktop ack for the native media bridge (`knox_media_sync`).
/// Desktop has no native now-playing surface — the Chromium Media Session
/// API owns it — so this only acknowledges. Android builds additionally
/// ship the `knox-media` plugin (MediaSession + mediaPlayback foreground
/// service); the renderer prefers the plugin there and only falls back to
/// this ack. Never throws: a rejection would trip the renderer's bridge
/// cooldown on every position tick.
#[tauri::command]
async fn knox_media_sync(snapshot: serde_json::Value) -> Result<serde_json::Value, String> {
    let _ = snapshot;
    Ok(serde_json::json!({ "ok": true }))
}

/// Live OS permission states. Anything the host cannot answer is ABSENT
/// (never a fake grant) — the renderer reports missing keys as "unknown".
#[tauri::command]
async fn knox_permissions_status() -> Result<std::collections::HashMap<String, String>, String> {
    Ok(std::collections::HashMap::new())
}

/// Android-only battery-exemption flow. This host cannot fire OS settings
/// intents from Rust, so it rejects with human guidance the UI shows
/// instead (the `knox-media` plugin owns the real flow on Android).
#[tauri::command]
async fn knox_request_battery_exemption() -> Result<bool, String> {
    Err("Open Settings → Apps → KNOX Music → Battery → Unrestricted to allow background playback.".to_string())
}

/// Deep link to this app's OS settings page. Same story as above: rejects
/// with the manual path (the plugin owns the real intent on Android).
#[tauri::command]
async fn knox_open_app_settings() -> Result<(), String> {
    Err("Open Settings → Apps → KNOX Music to change permissions.".to_string())
}

/// Host health over IPC (same payload as GET /api/health, no socket needed).
#[derive(Serialize, Clone)]
struct HealthDto {
    ok: bool,
    app: &'static str,
    version: String,
    mode: &'static str,
    port: u16,
    sidecars: std::collections::HashMap<String, String>,
}

#[tauri::command]
async fn knox_health(host: State<'_, KnoxHost>) -> Result<HealthDto, String> {
    let mut sidecars = std::collections::HashMap::new();
    sidecars.insert(
        "youtubemusic".to_string(),
        host.state.sidecars.state("youtubemusic").await.as_str().to_string(),
    );
    Ok(HealthDto {
        ok: true,
        app: "knox-music",
        version: host.state.version.clone(),
        mode: "desktop",
        port: host.port,
        sidecars,
    })
}

#[tauri::command]
async fn knox_sidecar_status(host: State<'_, KnoxHost>) -> Result<SidecarStatusDto, String> {
    let ytm_state = host.state.sidecars.state("youtubemusic").await;
    let _yt_state = host.state.sidecars.state("youtube-audio").await;
    // Prefer YouTube Music status for backward compat, but include both
    Ok(SidecarStatusDto {
        name: "youtubemusic".to_string(),
        state: ytm_state.as_str().to_string(),
        port: host.state.sidecars.port("youtubemusic").await,
        last_error: host.state.sidecars.last_error("youtubemusic").await,
    })
}

#[tauri::command]
async fn knox_youtube_audio_status(host: State<'_, KnoxHost>) -> Result<SidecarStatusDto, String> {
    let state = host.state.sidecars.state("youtube-audio").await;
    Ok(SidecarStatusDto {
        name: "youtube-audio".to_string(),
        state: state.as_str().to_string(),
        port: host.state.sidecars.port("youtube-audio").await,
        last_error: host.state.sidecars.last_error("youtube-audio").await,
    })
}

#[tauri::command]
async fn knox_sidecar_ensure(host: State<'_, KnoxHost>, enabled: bool) -> Result<SidecarStatusDto, String> {
    // Lazily register the sidecar on first ensure (python/script discovery
    // happens here so a missing runtime degrades to Unavailable, not a crash).
    // Lazily (re)register the sidecar: the entry API is a no-op when present,
    // and discovery failure degrades to Unavailable instead of crashing.
    let python = find_python();
    let script = find_sidecar_script("youtubemusic");
    let missing_runtime = python.is_none();
    let missing_script = script.is_none();
    if let (Some(python), Some(script)) = (python, script) {
        host.state.sidecars.register("youtubemusic", SidecarSpec::python_sidecar(script, python)).await;
        host.state.sidecars.ensure("youtubemusic", enabled).await;
    } else if enabled {
        // Name the missing piece (runtime vs bundled script) so production
        // logs diagnose "YouTube Music unavailable" directly.
        let missing = match (missing_runtime, missing_script) {
            (true, true) => "no python3 and no sidecar script found",
            (true, false) => "no python3 found",
            (false, true) => "sidecar script not found in bundle resources",
            (false, false) => "unreachable",
        };
        log_line(&host.log_path, "WARN", "sidecar", &format!("youtubemusic unavailable: {missing}")).await;
    } else {
        host.state.sidecars.ensure("youtubemusic", false).await;
    }

    // YouTube Audio sidecar (Node.js) — uses bundled node + yt-dlp/FFmpeg.
    // Script lives at services/youtube/sidecar.js in dev ("youtube") but is
    // registered as "youtube-audio" at runtime (dynamic port, health-gated).
    let node = find_node();
    let yt_script = find_sidecar_script("youtube");
    let missing_node = node.is_none();
    let missing_yt_script = yt_script.is_none();
    if let (Some(node), Some(yt_script)) = (node, yt_script) {
        host.state.sidecars.register("youtube-audio", SidecarSpec::node_sidecar(yt_script, node)).await;
        host.state.sidecars.ensure("youtube-audio", enabled).await;
    } else if enabled {
        let missing = match (missing_node, missing_yt_script) {
            (true, true) => "no node and no youtube-audio sidecar script found",
            (true, false) => "no node found",
            (false, true) => "youtube-audio sidecar script not found in bundle resources",
            (false, false) => "unreachable",
        };
        log_line(&host.log_path, "WARN", "sidecar", &format!("youtube-audio unavailable: {missing}")).await;
    } else {
        host.state.sidecars.ensure("youtube-audio", false).await;
    }

    let st = host.state.sidecars.state("youtubemusic").await;
    log_line(
        &host.log_path,
        "INFO",
        "sidecar",
        &format!("youtubemusic ensure(enabled={enabled}) → {}", st.as_str()),
    )
    .await;
    // Same outcome line for the audio sidecar (with its dynamic port when
    // known): without it a failed youtube-audio start leaves no trace in the
    // log at all — only the renderer's derived "health check timed out".
    let yt_st = host.state.sidecars.state("youtube-audio").await;
    let yt_port = host.state.sidecars.port("youtube-audio").await;
    let yt_err = host.state.sidecars.last_error("youtube-audio").await;
    {
        let mut msg = format!("youtube-audio ensure(enabled={enabled}) → {}", yt_st.as_str());
        if let Some(p) = yt_port {
            msg.push_str(&format!(" port={p}"));
        }
        if let Some(e) = yt_err {
            msg.push_str(&format!(" error={e}"));
        }
        log_line(&host.log_path, "INFO", "sidecar", &msg).await;
    }
    knox_sidecar_status(host).await
}

#[tauri::command]
async fn knox_open_data_dir(app: AppHandle, host: State<'_, KnoxHost>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // Reveal the data dir; opener handles platform differences.
    app.opener()
        .open_path(host.data_dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("cannot open data directory: {e}"))?;
    Ok(())
}

// ---------- disk-backed temporary playback (PHASE 2/16) ----------
//
// Preferred final architecture: provider → fresh URL → temporary local FILE
// → AudioEngine → single HTMLAudioElement → play → delete after end/change.
//
// The host downloads the file itself (no CORS limits, no multi-MB IPC
// payloads) into <data_dir>/temp/playback/<session>/ ONLY. Nothing is ever
// written outside that root; offline/downloads/library/playlists are never
// touched. The renderer plays the file via convertFileSrc (asset protocol).

/// Max temp audio bytes per session (mirrors TEMP_FILE_CAP, 100 MiB).
const TEMP_FILE_CAP_BYTES: usize = 100 * 1024 * 1024;
/// Min temp audio bytes (mirrors TEMP_MIN_BYTES — truncated downloads fail).
const TEMP_MIN_BYTES_USIZE: usize = 1024;

fn temp_playback_root(host: &KnoxHost) -> PathBuf {
    host.data_dir.join("temp").join("playback")
}

/// Strict single path-segment check: no separators, no `..`, bounded.
fn valid_temp_segment(s: &str, max_len: usize) -> bool {
    !s.is_empty()
        && s.len() <= max_len
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Strict `name.ext` check for the audio file inside a session dir.
fn valid_temp_filename(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    let mut parts = s.split('.');
    let (Some(name), Some(ext), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && (2..=5).contains(&ext.len())
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
        && matches!(
            ext.to_ascii_lowercase().as_str(),
            "mp3" | "m4a" | "mp4" | "aac" | "ogg" | "oga" | "opus" | "flac" | "wav" | "weba" | "webm"
        )
}

/// Magic-byte container detection (mirrors mediaDiagnostics, PHASE 9).
/// Returns the container label, or None for HTML/JSON/unrecognized bytes.
fn detect_temp_container(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    let ascii = |at: usize, len: usize| -> &[u8] {
        let end = (at + len).min(head.len());
        &head[at.min(head.len())..end]
    };
    // HTML/JSON error pages masquerading as audio are never accepted.
    let lower_end = head.len().min(64);
    let mut i = 0;
    while i < lower_end && (head[i] <= 0x20 || head[i] == 0xef || head[i] == 0xbb || head[i] == 0xbf) {
        i += 1;
    }
    let rest = &head[i.min(head.len())..lower_end.min(head.len())];
    let starts_with = |pat: &[u8]| rest.len() >= pat.len() && rest[..pat.len()].eq_ignore_ascii_case(pat);
    if starts_with(b"<!doctype html") || starts_with(b"<html") || starts_with(b"<head") {
        return None;
    }
    if starts_with(b"{\"ok\"") || starts_with(b"{\"success\"") || starts_with(b"{\"error\"") {
        return None;
    }
    // MP3: ID3 or frame sync.
    if head.starts_with(b"ID3") || (head[0] == 0xff && head[1] & 0xe0 == 0xe0) {
        return Some("mp3");
    }
    // MP4/M4A: ftyp at offset 4. ADTS AAC counted as mp4-m4a family.
    if head.len() >= 8 && ascii(4, 4) == b"ftyp" {
        return Some("mp4-m4a");
    }
    if head[0] == 0xff && head[1] & 0xf6 == 0xf0 {
        return Some("mp4-m4a");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.len() >= 12 && ascii(0, 4) == b"RIFF" && ascii(8, 4) == b"WAVE" {
        return Some("wav");
    }
    if head.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some("webm");
    }
    // Not an error page, but no known signature — element decides.
    Some("unknown-audio")
}

fn canonical_temp_mime(container: &str, content_type: &str) -> String {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let playable = matches!(
        ct.as_str(),
        "audio/mpeg" | "audio/mp3" | "audio/x-mp3"
            | "audio/mp4" | "audio/x-m4a" | "audio/aac" | "audio/x-aac"
            | "audio/ogg" | "audio/opus" | "audio/flac" | "audio/x-flac"
            | "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/webm"
            | "application/ogg" | "application/octet-stream"
    );
    if playable && !ct.is_empty() {
        return ct;
    }
    match container {
        "mp3" => "audio/mpeg".to_string(),
        "mp4-m4a" => "audio/mp4".to_string(),
        "ogg" => "audio/ogg".to_string(),
        "flac" => "audio/flac".to_string(),
        "wav" => "audio/wav".to_string(),
        "webm" => "audio/webm".to_string(),
        _ => "audio/mpeg".to_string(),
    }
}

#[derive(Serialize)]
struct TempFetchResult {
    /// Absolute file path (renderer converts via convertFileSrc).
    #[serde(rename = "filePath")]
    file_path: String,
    bytes: usize,
    #[serde(rename = "mimeType")]
    mime_type: String,
    container: String,
    extension: String,
}

/// Download + validate + write one temp audio file (host-side, PHASE 2/16).
/// Never logs the URL (only byte counts + container on success/failure).
#[tauri::command]
async fn knox_temp_fetch(
    host: State<'_, KnoxHost>,
    session: String,
    filename: String,
    url: String,
) -> Result<TempFetchResult, String> {
    if !valid_temp_segment(&session, 64) {
        return Err("invalid temp session".to_string());
    }
    if !valid_temp_filename(&filename) {
        return Err("invalid temp filename".to_string());
    }
    if url.is_empty() || url.len() > 8192 {
        return Err("invalid temp url".to_string());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|_| "invalid temp url".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("temp url must be http(s)".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("credentials in temp url are forbidden".to_string());
    }
    let ext = filename.rsplit('.').next().unwrap_or("mp3").to_ascii_lowercase();
    let dir = temp_playback_root(&host).join(&session);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create temp session dir: {e}"))?;
    let mut res = host
        .state
        .http
        .get(parsed)
        .header("User-Agent", format!("KNOX Music/{}", host.state.version))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("temp download failed: {e}"))?;
    let status = res.status().as_u16();
    if status != 200 && status != 206 {
        return Err(format!("temp download failed (HTTP {status})"));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ct_base = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if ct_base.starts_with("text/html")
        || ct_base.starts_with("application/json")
        || ct_base.starts_with("text/plain")
        || ct_base.starts_with("application/xml")
        || ct_base.starts_with("text/xml")
    {
        return Err("temp download is not audio (error page)".to_string());
    }
    // Stream to memory with a hard cap (songs are small; bombs are not).
    // Response::chunk() needs no extra reqwest features (unlike bytes_stream).
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() > TEMP_FILE_CAP_BYTES {
                    return Err("temp file exceeds size cap".to_string());
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("temp download interrupted: {e}")),
        }
    }
    if buf.len() < TEMP_MIN_BYTES_USIZE {
        return Err("temp download truncated".to_string());
    }
    let head_len = buf.len().min(512);
    let container = detect_temp_container(&buf[..head_len]).ok_or_else(|| "temp download is not audio".to_string())?;
    let mime = canonical_temp_mime(container, &content_type);
    let path = dir.join(&filename);
    std::fs::write(&path, &buf).map_err(|e| format!("cannot write temp file: {e}"))?;
    log_line(
        &host.log_path,
        "INFO",
        "temp-playback",
        &format!("disk temp ready session={} bytes={} container={container} ext={ext}", &session[..session.len().min(8)], buf.len()),
    )
    .await;
    Ok(TempFetchResult {
        file_path: path.to_string_lossy().into_owned(),
        bytes: buf.len(),
        mime_type: mime,
        container: container.to_string(),
        extension: ext,
    })
}

/// Delete ONE temp session dir. Only inside temp/playback — validated.
#[tauri::command]
async fn knox_temp_remove(host: State<'_, KnoxHost>, session: String) -> Result<bool, String> {
    if !valid_temp_segment(&session, 64) {
        return Err("invalid temp session".to_string());
    }
    let dir = temp_playback_root(&host).join(&session);
    if !dir.exists() {
        return Ok(false);
    }
    // Safety: refuse unless the canonical path stays under the temp root.
    let root = temp_playback_root(&host);
    let canon_dir = dir.canonicalize().map_err(|_| "temp session not found".to_string())?;
    let canon_root = root.canonicalize().unwrap_or(root);
    if !canon_dir.starts_with(&canon_root) {
        return Err("temp session escape rejected".to_string());
    }
    std::fs::remove_dir_all(&canon_dir).map_err(|e| format!("cannot remove temp session: {e}"))?;
    Ok(true)
}

/// Delete ALL temp session dirs (shutdown/startup/explicit clean).
/// Returns sessions removed. Never touches anything outside temp/playback.
#[tauri::command]
async fn knox_temp_clear(host: State<'_, KnoxHost>) -> Result<u64, String> {
    let root = temp_playback_root(&host);
    let mut removed: u64 = 0;
    let entries = std::fs::read_dir(&root).map_err(|_| "temp root unavailable".to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        // Only remove directories (session dirs); never stray files.
        if !path.is_dir() {
            continue;
        }
        // Extra guard: single-segment names only.
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_temp_segment(&name, 64) {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST, before any GTK/WebKit init: restore a working display/input
    // environment. The AppImage hook forces GDK_BACKEND=x11, which strands
    // GTK on XWayland with an unconnectable ibus IM (no IBUS_ADDRESS in a
    // GNOME Wayland session) → key events queue up and are dropped before
    // the WebView ever sees them, so no search field can receive typing.
    // See input_env for the full root-cause record. The WebKitWebProcess
    // inherits this environment at spawn, so one early repair covers both
    // processes.
    input_env::repair_input_env();

    // THEN, before any GTK/WebKit init: repair the GStreamer plugin path.
    // The AppImage bundles GStreamer core libs but no plugins, which leaves
    // WebKit with zero plugins → NULL audio sink → WebKitWebProcess SIGSEGV
    // on playback start (permanent blank WebView). The web process inherits
    // this environment at spawn, so one early repair covers both processes.
    // See gst_env for the full root-cause record.
    gst_env::repair_gstreamer_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_knox_media::init())
        .setup(|app| {
            let data_dir = knox_data_dir(app.handle());
            ensure_data_dirs(&data_dir);
            let log_path = data_dir.join("logs").join("knox.log");

            // Bind loopback FIRST so the port is known before state exists.
            let (listener, port) = tauri::async_runtime::block_on(bind_loopback())
                .expect("cannot bind 127.0.0.1 ephemeral port");

            // Per-launch session token: random, memory-only, never logged.
            let token = new_token();
            let version = env!("CARGO_PKG_VERSION").to_string();
            let sidecars = Arc::new(SidecarRegistry::new());
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(25))
                .build()
                .expect("http client");
            let api_state = ApiState {
                version: version.clone(),
                token: token.clone(),
                port,
                data_dir: data_dir.clone(),
                log_path: log_path.clone(),
                http,
                sidecars,
                discovery_hits: Arc::new(tokio::sync::Mutex::new(Vec::new())),
            };

            let serve_state = api_state.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(listener, serve_state).await {
                    eprintln!("[knox] local api failed: {e}");
                }
            });

            app.manage(KnoxHost { port, token, data_dir, log_path: log_path.clone(), state: api_state });
            // block_on inside setup is acceptable for a one-shot file write.
            tauri::async_runtime::block_on(log_line(&log_path, "INFO", "lifecycle", &format!("knox desktop v{version} starting, api on 127.0.0.1:{port}")));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Graceful sidecar stop on close; idempotent and time-boxed.
                let state: State<'_, KnoxHost> = window.state();
                let sidecars = state.state.sidecars.clone();
                let log_path = state.log_path.clone();
                tauri::async_runtime::block_on(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(5), async {
                        sidecars.stop_all(
).await;
                    })
                    .await;
                    log_line(&log_path, "INFO", "lifecycle", "knox desktop shutdown").await;
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            knox_api_config,
            knox_sidecar_status,
            knox_youtube_audio_status,
            knox_sidecar_ensure,
            knox_open_data_dir,
            knox_temp_fetch,
            knox_temp_remove,
            knox_temp_clear,
            knox_proxy_get,
            knox_health,
            knox_media_sync,
            knox_permissions_status,
            knox_request_battery_exemption,
            knox_open_app_settings,
            yt_device::knox_yt_status,
            yt_device::knox_yt_search,
            yt_device::knox_yt_mix,
            yt_device::knox_yt_duration,
            yt_device::knox_yt_audio,
            yt_device::knox_fetch_audio_bytes
        ])
        .run(tauri::generate_context!())
        .expect("failed to run KNOX Music");
}

#[cfg(test)]
mod temp_tests {
    use super::*;

    #[test]
    fn temp_segments_reject_escapes() {
        assert!(valid_temp_segment("abc-123_XYZ", 64));
        assert!(!valid_temp_segment("", 64));
        assert!(!valid_temp_segment("../evil", 64));
        assert!(!valid_temp_segment("a/b", 64));
        assert!(!valid_temp_segment("a\\b", 64));
        assert!(!valid_temp_segment("a b", 64));
        assert!(!valid_temp_segment(&"a".repeat(65), 64));
    }

    #[test]
    fn temp_filenames_allow_only_audio_names() {
        assert!(valid_temp_filename("track.mp3"));
        assert!(valid_temp_filename("a-b_c.flac"));
        assert!(valid_temp_filename("x_320.mp4"));
        assert!(!valid_temp_filename(""));
        assert!(!valid_temp_filename("noext"));
        assert!(!valid_temp_filename("../evil.mp3"));
        assert!(!valid_temp_filename("a/b.mp3"));
        assert!(!valid_temp_filename("track.exe"));
        assert!(!valid_temp_filename("track.html"));
        assert!(!valid_temp_filename(".mp3"));
    }

    #[test]
    fn temp_container_detects_real_signatures() {
        assert_eq!(detect_temp_container(b"ID3\x04\x00\x00"), Some("mp3"));
        assert_eq!(detect_temp_container(&[0xff, 0xfb, 0x90, 0x00]), Some("mp3"));
        assert_eq!(detect_temp_container(b"\x00\x00\x00\x20ftypM4A extra"), Some("mp4-m4a"));
        assert_eq!(detect_temp_container(b"OggS\x00\x02"), Some("ogg"));
        assert_eq!(detect_temp_container(b"fLaC\x00\x00"), Some("flac"));
        assert_eq!(detect_temp_container(b"RIFF\x00\x00\x00\x00WAVEfmt "), Some("wav"));
        assert_eq!(detect_temp_container(&[0x1a, 0x45, 0xdf, 0xa3, 0x93]), Some("webm"));
        // Error pages are never audio.
        assert_eq!(detect_temp_container(b"<html><body>nope"), None);
        assert_eq!(detect_temp_container(b"<!DOCTYPE html><html"), None);
        assert_eq!(detect_temp_container(b"{\"error\":\"nope\"}"), None);
        // Too short to judge.
        assert_eq!(detect_temp_container(b"ID"), None);
        // Unknown but not an error page → element decides.
        assert_eq!(detect_temp_container(b"aaaaaaaaaaaaaaaa"), Some("unknown-audio"));
    }

    #[test]
    fn temp_mime_prefers_real_content_type() {
        assert_eq!(canonical_temp_mime("mp3", "audio/mpeg"), "audio/mpeg");
        assert_eq!(canonical_temp_mime("mp3", "text/html"), "audio/mpeg");
        assert_eq!(canonical_temp_mime("flac", ""), "audio/flac");
        assert_eq!(canonical_temp_mime("unknown-audio", ""), "audio/mpeg");
    }
}
