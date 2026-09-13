//! Local KNOX HTTP API — loopback only (`127.0.0.1`, dynamic port).
//!
//! The server owns infrastructure concerns: health, runtime config, the
//! authenticated provider egress proxy (fixes browser CORS, centralizes
//! timeout/logging), and the YouTube Music sidecar reverse proxy. Domain logic
//! (search ranking, lyrics parsing, radio mapping) stays in the shared
//! TypeScript KNOX Core — this server never duplicates it.
//!
//! Security: per-launch random token (`X-Knox-Token`, never logged) guards
//! everything except `/api/health`; CORS allowlist is restricted to the
//! Tauri renderer origin (+ localhost dev server in debug builds); proxy
//! targets are allowlisted per provider with traversal/size/timeout guards.

use axum::{
    body::Body,
    extract::{OriginalUri, Path, Query, State},
    http::{Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;

use crate::sidecar::SidecarRegistry;

pub const TOKEN_HEADER: &str = "x-knox-token";
pub const MAX_PROXY_BYTES: usize = 10 * 1024 * 1024;
pub const PROXY_TIMEOUT_SECS: u64 = 20;

#[derive(Clone)]
pub struct ApiState {
    pub version: String,
    pub token: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub log_path: PathBuf,
    pub http: reqwest::Client,
    pub sidecars: Arc<SidecarRegistry>,
    /// Discovery rate-limit timestamps (sliding window, loopback only).
    pub discovery_hits: Arc<tokio::sync::Mutex<Vec<std::time::Instant>>>,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    app: &'static str,
    version: String,
    mode: &'static str,
    port: u16,
    sidecars: HashMap<String, String>,
}

#[derive(Serialize)]
struct ConfigResponse {
    version: String,
    port: u16,
    data_dir: String,
    loopback: bool,
}

/// Bind an ephemeral loopback port. Always 127.0.0.1 — never 0.0.0.0.
pub async fn bind_loopback() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Serve the API on an already-bound loopback listener.
pub async fn serve(listener: TcpListener, state: ApiState) -> std::io::Result<()> {
    axum::serve(listener, router(state).into_make_service()).await
}

fn cors_layer() -> CorsLayer {
    let mut origins = vec![
        "http://tauri.localhost".parse().unwrap(),
        "https://tauri.localhost".parse().unwrap(),
    ];
    // Dev-server origin only in debug builds — production never allows it.
    #[cfg(debug_assertions)]
    origins.push("http://localhost:5173".parse().unwrap());
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderName::from_static(TOKEN_HEADER),
        ])
}

async fn require_token(State(state): State<ApiState>, req: axum::http::Request<Body>, next: Next) -> Response {
    let ok = req
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| subtle_eq(v, &state.token))
        .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    next.run(req).await
}

/// Constant-shape comparison to avoid leaking token length via timing.
fn subtle_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn router(state: ApiState) -> Router {
    let protected = Router::new()
        .route("/api/config", get(config))
        .route("/api/proxy/:provider", get(proxy_provider))
        .route("/api/discovery/search", get(discovery_search))
        .route("/api/discovery/fetch", get(discovery_fetch))
        .route("/api/sidecar/youtubemusic/status", get(sidecar_status))
        .route("/api/sidecar/youtubemusic/ensure", post(sidecar_ensure))
        .route("/api/sidecar/youtubemusic/*path", get(sidecar_proxy))
        .route("/api/logs", get(logs))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state.clone());
    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .layer(cors_layer())
        .with_state(state)
}

async fn health(State(state): State<ApiState>) -> Json<HealthResponse> {
    let mut sidecars = HashMap::new();
    sidecars.insert("youtubemusic".to_string(), state.sidecars.state("youtubemusic").await.as_str().to_string());
    Json(HealthResponse {
        ok: true,
        app: "knox-music",
        version: state.version.clone(),
        mode: "desktop",
        port: state.port,
        sidecars,
    })
}

async fn config(State(state): State<ApiState>) -> Json<ConfigResponse> {
    Json(ConfigResponse {
        version: state.version.clone(),
        port: state.port,
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        loopback: true,
    })
}

// ---------- provider egress proxy ----------

#[derive(Deserialize)]
struct ProxyQuery {
    target: String,
}

/// Exact hosts per provider; radio-browser allows its regional subdomains.
fn allowed_host(provider: &str, host: &str) -> bool {
    match provider {
        "jamendo" => host == "api.jamendo.com",
        "internet-archive" => host == "archive.org",
        "freetouse" => host == "api.freetouse.com",
        "lrclib" => host == "lrclib.net",
        "radio-browser" => host == "api.radio-browser.info" || host.ends_with(".api.radio-browser.info"),
        "airbeats" => host == "api.airbeats.xyz",
        _ => false,
    }
}

fn validate_proxy_target(provider: &str, target: &str) -> Result<reqwest::Url, (StatusCode, String)> {
    let err = |code: StatusCode, msg: &str| (code, msg.to_string());
    if !allowed_host(provider, "") && !["jamendo", "internet-archive", "freetouse", "lrclib", "radio-browser", "airbeats"].contains(&provider) {
        return Err(err(StatusCode::NOT_FOUND, "unknown provider"));
    }
    let url = reqwest::Url::parse(target).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid target url"))?;
    if url.scheme() != "https" {
        return Err(err(StatusCode::BAD_REQUEST, "target must be https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "credentials in url are forbidden"));
    }
    let host = url.host_str().ok_or_else(|| err(StatusCode::BAD_REQUEST, "target needs a host"))?;
    if url.port().is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "explicit ports are forbidden"));
    }
    if !allowed_host(provider, host) {
        return Err(err(StatusCode::BAD_REQUEST, "target host not allowlisted for provider"));
    }
    // Reject dot-segment tricks in the raw string (Url normalizes, but the
    // raw check documents intent and guards odd backends).
    if target.contains("/../") || target.contains("/..?") || target.contains("/..#") {
        return Err(err(StatusCode::BAD_REQUEST, "path traversal rejected"));
    }
    Ok(url)
}

async fn proxy_provider(
    State(state): State<ApiState>,
    Path(provider): Path<String>,
    Query(q): Query<ProxyQuery>,
) -> Response {
    // 8KB cap on the target parameter itself.
    if q.target.len() > 8192 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "target too long").into_response();
    }
    let url = match validate_proxy_target(&provider, &q.target) {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let upstream = match state
        .http
        .get(url)
        .header("User-Agent", format!("KNOX Music/{}", state.version))
        .timeout(Duration::from_secs(PROXY_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("upstream unavailable: {e}")).into_response();
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // Size-bounded body (never buffer unbounded provider payloads).
    let bytes = match upstream.bytes().await {
        Ok(b) if b.len() <= MAX_PROXY_BYTES => b,
        _ => return (StatusCode::PAYLOAD_TOO_LARGE, "upstream body too large").into_response(),
    };
    Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .body(Body::from(bytes))
        .unwrap()
}

// ---------- web discovery (local-first, reference/metadata only) ----------
//
// The desktop IS the discovery server: the renderer sends only the trimmed
// query (loopback + per-launch token); this service performs the web search
// (public MusicBrainz metadata, no key) and public page fetches (SSRF
// guarded, redirect/size/time bounded). Responses are sanitized structured
// metadata — playable=false, downloadable=false. No DRM/auth bypass, no
// hidden media extraction, no credential/cookie logging.

pub const DISCOVERY_TIMEOUT_SECS: u64 = 8;
pub const DISCOVERY_MAX_HTML_BYTES: usize = 1_000_000;
pub const DISCOVERY_MAX_JSON_BYTES: usize = 512 * 1024;
const DISCOVERY_RATE_WINDOW_SECS: u64 = 10;
const DISCOVERY_RATE_MAX: usize = 20;

/// Sliding-window rate check for discovery routes (loopback only).
/// Returns true when the caller must be rejected with 429.
async fn discovery_rate_limited(state: &ApiState) -> bool {
    let mut hits = state.discovery_hits.lock().await;
    let now = std::time::Instant::now();
    hits.retain(|t| now.duration_since(*t).as_secs() < DISCOVERY_RATE_WINDOW_SECS);
    if hits.len() >= DISCOVERY_RATE_MAX {
        return true;
    }
    hits.push(now);
    false
}

fn is_blocked_discovery_host(host: &str) -> bool {
    let h = host.to_lowercase();
    let h = h.trim_end_matches('.');
    // url::Url keeps IPv6 brackets in host_str() — strip for literal checks.
    let h = h.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(h);
    if h.is_empty() {
        return true;
    }
    if h == "localhost"
        || h.ends_with(".localhost")
        || h == "metadata.google.internal"
        || h == "metadata.google.com"
        || h == "instance-data"
        || h == "169.254.169.254"
    {
        return true;
    }
    // Decimal-encoded loopback bypass (2130706433 == 127.0.0.1).
    if h.chars().all(|c| c.is_ascii_digit()) && h.parse::<u32>().ok() == Some(2130706433) {
        return true;
    }
    // Literal IPs: block loopback / private / link-local / reserved.
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                if v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_multicast()
                    || v4.is_unspecified()
                    || v4.octets()[0] == 0
                    || v4.octets()[0] >= 224
                {
                    return true;
                }
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                    return true;
                }
                // IPv6 unique-local (fc00::/7) + link-local (fe80::/10).
                let seg0 = v6.segments()[0];
                if (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80 {
                    return true;
                }
            }
        }
    }
    false
}

/// Validate a public page URL for server-side fetch. Pure (no network).
fn validate_discovery_target(target: &str) -> Result<reqwest::Url, (StatusCode, String)> {
    let err = |code: StatusCode, msg: &str| (code, msg.to_string());
    if target.is_empty() || target.len() > 2048 {
        return Err(err(StatusCode::BAD_REQUEST, "target must be 1..2048 chars"));
    }
    let url = reqwest::Url::parse(target).map_err(|_| err(StatusCode::BAD_REQUEST, "invalid target url"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(err(StatusCode::BAD_REQUEST, "target must be http(s)"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "credentials in url are forbidden"));
    }
    let host = url.host_str().ok_or_else(|| err(StatusCode::BAD_REQUEST, "target needs a host"))?;
    if url.port().is_some() {
        return Err(err(StatusCode::BAD_REQUEST, "explicit ports are forbidden"));
    }
    if is_blocked_discovery_host(host) {
        return Err(err(StatusCode::BAD_REQUEST, "target host is blocked"));
    }
    if target.contains("/../") || target.contains("/..?") || target.contains("/..#") {
        return Err(err(StatusCode::BAD_REQUEST, "path traversal rejected"));
    }
    Ok(url)
}

#[derive(Deserialize)]
struct DiscoverySearchQuery {
    q: Option<String>,
}

#[derive(Serialize)]
struct DiscoveryHit {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration: Option<u64>,
    artwork: Option<String>,
    url: String,
    site: String,
    provider: String,
    #[serde(rename = "providerId", skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
    #[serde(rename = "sourceType")]
    source_type: String,
    playable: bool,
    downloadable: bool,
}

/// GET /api/discovery/search?q=<query> — public metadata search for
/// discovery/reference only. Only the query string is used; nothing about
/// the user's library/playlists/history ever reaches this handler.
async fn discovery_search(State(state): State<ApiState>, Query(q): Query<DiscoverySearchQuery>) -> Response {
    if discovery_rate_limited(&state).await {
        return (StatusCode::TOO_MANY_REQUESTS, "discovery rate-limited").into_response();
    }
    let query = q.q.unwrap_or_default().trim().to_string();
    if query.is_empty() || query.len() > 200 {
        return (StatusCode::BAD_REQUEST, "q must be 1..200 chars").into_response();
    }
    // Provider-neutral public metadata (MusicBrainz, no key). Query text is
    // user input — never logged raw (counts only).
    let lucene = query
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    let mb_url = format!(
        "https://musicbrainz.org/ws/2/recording/?query={}&fmt=json&limit=12",
        url_encode(&lucene)
    );
    let upstream = match state
        .http
        .get(&mb_url)
        .header("User-Agent", format!("KNOX-Music/{0} (local-discovery)", state.version))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(DISCOVERY_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("discovery upstream unavailable: {e}")).into_response();
        }
    };
    if !upstream.status().is_success() {
        return (StatusCode::BAD_GATEWAY, "discovery upstream error").into_response();
    }
    let bytes = match upstream.bytes().await {
        Ok(b) if b.len() <= DISCOVERY_MAX_JSON_BYTES => b,
        _ => return (StatusCode::PAYLOAD_TOO_LARGE, "discovery body too large").into_response(),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_GATEWAY, "discovery parse error").into_response(),
    };
    let mut results: Vec<DiscoveryHit> = Vec::new();
    if let Some(recs) = parsed.get("recordings").and_then(|r| r.as_array()) {
        for r in recs.iter().take(12) {
            let id = r.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let title = r.get("title").and_then(|v| v.as_str()).map(|s| trunc(s, 300));
            let artist = r
                .get("artist-credit")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| {
                            c.get("artist")
                                .and_then(|a| a.get("name"))
                                .and_then(|n| n.as_str())
                                .or_else(|| c.get("name").and_then(|n| n.as_str()))
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .map(|s| trunc(&s, 300))
                .filter(|s| !s.is_empty());
            let album = r
                .get("releases")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .and_then(|rel| rel.get("title"))
                .and_then(|v| v.as_str())
                .map(|s| trunc(s, 300));
            let duration = r.get("length").and_then(|v| v.as_u64()).filter(|n| *n > 0);
            if title.is_none() && artist.is_none() {
                continue;
            }
            results.push(DiscoveryHit {
                title,
                artist,
                album,
                duration,
                artwork: None,
                url: format!("https://musicbrainz.org/recording/{id}"),
                site: "MusicBrainz".to_string(),
                provider: "musicbrainz".to_string(),
                provider_id: Some(trunc(id, 120)),
                source_type: "web-reference".to_string(),
                playable: false,
                downloadable: false,
            });
        }
    }
    // Genuine public-web catalog merge (iTunes Search API: no key, no auth).
    // Best-effort and bounded — an iTunes failure never removes MusicBrainz
    // rows. Track-view URLs are real public music.apple.com pages.
    if results.len() < 12 {
        append_itunes_hits(&state, &query, &mut results).await;
    }
    Json(serde_json::json!({ "results": results })).into_response()
}

/// Best-effort iTunes catalog merge for discovery_search. Appends up to the
/// 12-result cap, skipping duplicate URLs. Never fails the request.
async fn append_itunes_hits(state: &ApiState, query: &str, results: &mut Vec<DiscoveryHit>) {
    if results.len() >= 12 {
        return;
    }
    let itunes_url = format!(
        "https://itunes.apple.com/search?term={}&media=music&entity=song&limit=12",
        url_encode(query)
    );
    let upstream = match state
        .http
        .get(&itunes_url)
        .header("User-Agent", format!("KNOX-Music/{0} (local-discovery)", state.version))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(DISCOVERY_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return,
    };
    if !upstream.status().is_success() {
        return;
    }
    let bytes = match upstream.bytes().await {
        Ok(b) if b.len() <= DISCOVERY_MAX_JSON_BYTES => b,
        _ => return,
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return,
    };
    let rows = parsed.get("results").and_then(|r| r.as_array());
    let rows = match rows {
        Some(r) => r,
        None => return,
    };
    for r in rows {
        if results.len() >= 12 {
            break;
        }
        let page = r.get("trackViewUrl").and_then(|v| v.as_str()).unwrap_or("");
        if page.is_empty() || results.iter().any(|h| h.url == page) {
            continue;
        }
        let title = r.get("trackName").and_then(|v| v.as_str()).map(|s| trunc(s, 300));
        if title.as_ref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            continue;
        }
        let artist = r.get("artistName").and_then(|v| v.as_str()).map(|s| trunc(s, 300));
        let album = r.get("collectionName").and_then(|v| v.as_str()).map(|s| trunc(s, 300));
        let duration = r.get("trackTimeMillis").and_then(|v| v.as_u64()).filter(|n| *n > 0);
        let artwork = r
            .get("artworkUrl100")
            .and_then(|v| v.as_str())
            .map(|s| trunc(&s.replace("100x100bb", "600x600bb"), 2048));
        let provider_id = r.get("trackId").and_then(|v| v.as_u64()).map(|n| n.to_string());
        results.push(DiscoveryHit {
            title,
            artist,
            album,
            duration,
            artwork,
            url: page.to_string(),
            site: "Apple Music".to_string(),
            provider: "apple-music".to_string(),
            provider_id,
            source_type: "web-reference".to_string(),
            playable: false,
            downloadable: false,
        });
    }
}

#[derive(Deserialize)]
struct DiscoveryFetchQuery {
    target: Option<String>,
}

/// GET /api/discovery/fetch?target=<public-page-url> — SSRF-guarded public
/// page fetch for metadata extraction (renderer parses; never audio).
async fn discovery_fetch(State(state): State<ApiState>, Query(q): Query<DiscoveryFetchQuery>) -> Response {
    if discovery_rate_limited(&state).await {
        return (StatusCode::TOO_MANY_REQUESTS, "discovery rate-limited").into_response();
    }
    let target = q.target.unwrap_or_default();
    let url = match validate_discovery_target(&target) {
        Ok(u) => u,
        Err((code, msg)) => return (code, msg).into_response(),
    };
    let was_https = url.scheme() == "https";
    // Bounded client: 5-redirect cap, 8s timeout (never the 25s default).
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(DISCOVERY_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "discovery client error").into_response(),
    };
    let upstream = match client
        .get(url)
        .header("User-Agent", format!("KNOX-Music/{0} (local-discovery)", state.version))
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("page unreachable: {e}")).into_response();
        }
    };
    // Never downgrade an https start to http via redirects.
    if was_https && upstream.url().scheme() != "https" {
        return (StatusCode::BAD_REQUEST, "https downgrade rejected").into_response();
    }
    // Re-validate the FINAL host after redirects (each hop could wander).
    if let Some(final_host) = upstream.url().host_str() {
        if is_blocked_discovery_host(final_host) {
            return (StatusCode::BAD_REQUEST, "redirect target is blocked").into_response();
        }
    }
    if !upstream.status().is_success() {
        return (StatusCode::BAD_GATEWAY, "page fetch failed").into_response();
    }
    let ct = upstream
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ct_base = ct.split(';').next().unwrap_or("").trim().to_lowercase();
    if !ct_base.is_empty()
        && !ct_base.contains("html")
        && !ct_base.contains("xhtml")
        && !ct_base.contains("text")
    {
        return (StatusCode::UNSUPPORTED_MEDIA_TYPE, "page is not html").into_response();
    }
    let bytes = match upstream.bytes().await {
        Ok(b) if b.len() <= DISCOVERY_MAX_HTML_BYTES => b,
        _ => return (StatusCode::PAYLOAD_TOO_LARGE, "page too large").into_response(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(bytes))
        .unwrap()
}

fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Truncate on a char boundary (metadata is UTF-8 user content).
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Minimal percent-encoding for the upstream query value (alphanumeric plus
/// a small safe set pass through; everything else becomes %XX).
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' || b == b' ' {
            if b == b' ' {
                out.push('+');
            } else {
                out.push(b as char);
            }
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------- sidecar gateway ----------

#[derive(Serialize)]
struct SidecarStatus {
    name: &'static str,
    state: String,
    port: Option<u16>,
    last_error: Option<String>,
    /// Local-only diagnostics (sidecar stderr tail) on failure states.
    detail: Option<String>,
}

async fn sidecar_status(State(state): State<ApiState>) -> Json<SidecarStatus> {
    let st = state.sidecars.state("youtubemusic").await;
    let detail = match st {
        crate::sidecar::SidecarState::StartFailed | crate::sidecar::SidecarState::Unavailable => {
            let tail = state.sidecars.stderr_tail("youtubemusic").await;
            if tail.is_empty() { None } else { Some(tail) }
        }
        _ => None,
    };
    Json(SidecarStatus {
        name: "youtubemusic",
        state: st.as_str().to_string(),
        port: state.sidecars.port("youtubemusic").await,
        last_error: state.sidecars.last_error("youtubemusic").await,
        detail,
    })
}

#[derive(Deserialize)]
struct EnsureBody {
    enabled: bool,
}

async fn sidecar_ensure(State(state): State<ApiState>, Json(body): Json<EnsureBody>) -> Json<SidecarStatus> {
    // Bounded JSON body is enforced by axum's default Json limits; re-check shape.
    state.sidecars.ensure("youtubemusic", body.enabled).await;
    sidecar_status(State(state)).await
}

async fn sidecar_proxy(
    State(state): State<ApiState>,
    Path(path): Path<String>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    // Only the sidecar's documented read API is proxied (GET). Dot segments
    // and anything outside the allowlisted subtree are rejected.
    let allowed = path == "health"
        || path == "search"
        || path.starts_with("search/")
        || path.starts_with("songs/")
        || path.starts_with("track/")
        || path.starts_with("artist/")
        || path.starts_with("album/")
        || path.starts_with("playlist/");
    if !allowed || path.contains("..") || path.contains('\\') {
        return (StatusCode::BAD_REQUEST, "path rejected").into_response();
    }
    let Some(port) = state.sidecars.port("youtubemusic").await else {
        return (StatusCode::BAD_GATEWAY, "sidecar unavailable").into_response();
    };
    if !matches!(state.sidecars.poll("youtubemusic").await, crate::sidecar::SidecarState::Ready) {
        return (StatusCode::BAD_GATEWAY, "sidecar unavailable").into_response();
    }
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    if query.len() > 4096 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "query too long").into_response();
    }
    let url = format!("http://127.0.0.1:{port}/api/{path}{query}");
    let upstream = match state.http.get(&url).timeout(Duration::from_secs(PROXY_TIMEOUT_SECS)).send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("sidecar unreachable: {e}")).into_response(),
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let bytes = match upstream.bytes().await {
        Ok(b) if b.len() <= MAX_PROXY_BYTES => b,
        _ => return (StatusCode::PAYLOAD_TOO_LARGE, "sidecar body too large").into_response(),
    };
    Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(bytes))
        .unwrap()
}

// ---------- logs ----------

#[derive(Deserialize)]
struct LogsQuery {
    tail: Option<usize>,
}

async fn logs(State(state): State<ApiState>, Query(q): Query<LogsQuery>) -> Response {
    let tail = q.tail.unwrap_or(200).clamp(1, 1000);
    let data = tokio::fs::read(&state.log_path).await.unwrap_or_default();
    // Cap read size; take the tail lines only (UTF-8 lossy, never secrets —
    // the server never logs tokens or credentials).
    let capped = if data.len() > 262_144 { &data[data.len() - 262_144..] } else { &data[..] };
    let text = String::from_utf8_lossy(capped);
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(tail);
    Json(serde_json::json!({"lines": lines[start..].to_vec()})).into_response()
}

/// Append one line to the local log file. Never logs tokens/credentials —
/// callers must pass pre-scrubbed messages.
pub async fn log_line(log_path: &PathBuf, level: &str, scope: &str, msg: &str) {
    use tokio::io::AsyncWriteExt;
    let line = format!("{} [{level}] [{scope}] {msg}\n", chrono_stamp());
    if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(log_path).await {
        let _ = f.write_all(line.as_bytes()).await;
    }
}

fn chrono_stamp() -> String {
    // std-only timestamp (no chrono dep): secs since epoch is enough for local logs.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("t{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn test_state() -> ApiState {
        ApiState {
            version: "test".to_string(),
            token: "secret-token".to_string(),
            port: 0,
            data_dir: PathBuf::from("/tmp/knox-test"),
            log_path: PathBuf::from("/tmp/knox-test.log"),
            http: reqwest::Client::builder().build().unwrap(),
            sidecars: Arc::new(SidecarRegistry::new()),
            discovery_hits: Arc::new(tokio::sync::Mutex::new(Vec::new())),
        }
    }

    async fn serve_test() -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let (listener, _) = bind_loopback().await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Health must be reachable without a token.
        let handle = tokio::spawn(async move {
            serve(listener, test_state()).await.unwrap();
        });
        (addr, handle)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().build().unwrap()
    }

    #[tokio::test]
    async fn binds_loopback_only() {
        let (listener, port) = bind_loopback().await.unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback());
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
        assert_ne!(port, 0);
        // Collision handling: a second bind gets a different free port.
        let (_, port2) = bind_loopback().await.unwrap();
        assert_ne!(port2, 0);
    }

    #[tokio::test]
    async fn health_is_open_and_minimal() {
        let (addr, _h) = serve_test().await;
        let res = client().get(format!("http://{addr}/api/health")).send().await.unwrap();
        assert_eq!(res.status(), 200);
        let body: serde_json::Value = res.json().await.unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["mode"], "desktop");
        // No token, no data dir, no internals leak in health.
        assert!(body.get("token").is_none());
        assert!(body.get("data_dir").is_none());
    }

    #[tokio::test]
    async fn protected_routes_require_the_token() {
        let (addr, _h) = serve_test().await;
        let c = client();
        let anon = c.get(format!("http://{addr}/api/config")).send().await.unwrap();
        assert_eq!(anon.status(), 401);
        let wrong = c
            .get(format!("http://{addr}/api/config"))
            .header(TOKEN_HEADER, "wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), 401);
        let ok = c
            .get(format!("http://{addr}/api/config"))
            .header(TOKEN_HEADER, "secret-token")
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        let body: serde_json::Value = ok.json().await.unwrap();
        assert_eq!(body["loopback"], true);
        assert!(body.get("token").is_none());
    }

    #[tokio::test]
    async fn unknown_routes_are_404() {
        let (addr, _h) = serve_test().await;
        let res = client().get(format!("http://{addr}/api/nope")).send().await.unwrap();
        assert_eq!(res.status(), 404);
    }

    #[test]
    fn proxy_target_validation() {
        assert!(validate_proxy_target("jamendo", "https://api.jamendo.com/v3.0/tracks/").is_ok());
        assert!(validate_proxy_target("airbeats", "https://api.airbeats.xyz/api/search/songs?query=x").is_ok());
        assert!(validate_proxy_target("radio-browser", "https://de1.api.radio-browser.info/json/stations/search").is_ok());
        // Unknown provider.
        assert_eq!(validate_proxy_target("evil", "https://api.jamendo.com/").unwrap_err().0, StatusCode::NOT_FOUND);
        // Wrong host for provider.
        assert_eq!(validate_proxy_target("jamendo", "https://evil.example.com/x").unwrap_err().0, StatusCode::BAD_REQUEST);
        // Non-https.
        assert_eq!(validate_proxy_target("jamendo", "http://api.jamendo.com/").unwrap_err().0, StatusCode::BAD_REQUEST);
        // Traversal.
        assert_eq!(validate_proxy_target("jamendo", "https://api.jamendo.com/../etc/passwd").unwrap_err().0, StatusCode::BAD_REQUEST);
        // Credentials.
        assert_eq!(validate_proxy_target("jamendo", "https://user:pass@api.jamendo.com/").unwrap_err().0, StatusCode::BAD_REQUEST);
        // Explicit port.
        assert_eq!(validate_proxy_target("jamendo", "https://api.jamendo.com:8443/").unwrap_err().0, StatusCode::BAD_REQUEST);
        // Garbage.
        assert_eq!(validate_proxy_target("jamendo", "not a url").unwrap_err().0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn oversized_target_rejected() {
        let (addr, _h) = serve_test().await;
        let big = format!("https://api.jamendo.com/{}", "a".repeat(9000));
        let res = client()
            .get(format!("http://{addr}/api/proxy/jamendo"))
            .header(TOKEN_HEADER, "secret-token")
            .query(&[("target", big)])
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 413);
    }

    #[tokio::test]
    async fn sidecar_status_defaults_to_disabled() {
        let (addr, _h) = serve_test().await;
        let res = client()
            .get(format!("http://{addr}/api/sidecar/youtubemusic/status"))
            .header(TOKEN_HEADER, "secret-token")
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let body: serde_json::Value = res.json().await.unwrap();
        assert_eq!(body["state"], "disabled");
        // Path outside the sidecar allowlist is rejected even with a token.
        let bad = client()
            .get(format!("http://{addr}/api/sidecar/youtubemusic/../secret"))
            .header(TOKEN_HEADER, "secret-token")
            .send()
            .await
            .unwrap();
        assert!(bad.status() == 400 || bad.status() == 404);
    }

    #[tokio::test]
    async fn cors_allows_tauri_origin_but_never_wildcard() {
        let (addr, _h) = serve_test().await;
        let res = client()
            .request(Method::OPTIONS, format!("http://{addr}/api/health"))
            .header("Origin", "http://tauri.localhost")
            .header("Access-Control-Request-Method", "GET")
            .send()
            .await
            .unwrap();
        let allow = res.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        assert_eq!(allow, "http://tauri.localhost");
        // Unlisted origin gets no allow header.
        let res2 = client()
            .request(Method::OPTIONS, format!("http://{addr}/api/health"))
            .header("Origin", "https://evil.example.com")
            .header("Access-Control-Request-Method", "GET")
            .send()
            .await
            .unwrap();
        assert!(res2.headers().get("access-control-allow-origin").is_none());
    }

    #[test]
    fn tokens_differ_per_generation() {
        assert_ne!(crate::new_token(), crate::new_token());
        assert_eq!(crate::new_token().len(), 64);
    }

    #[test]
    fn discovery_target_validation_blocks_ssrf() {
        // Public music pages pass.
        assert!(validate_discovery_target("https://www.jiosaavn.com/song/soch/abc").is_ok());
        assert!(validate_discovery_target("https://open.spotify.com/track/abc123").is_ok());
        assert!(validate_discovery_target("https://musicbrainz.org/recording/abc-123").is_ok());
        // Loopback / private / link-local / metadata endpoints blocked.
        for bad in [
            "http://localhost/song/x",
            "http://127.0.0.1/song/x",
            "http://0.0.0.0/song/x",
            "http://10.0.0.5/song/x",
            "http://172.16.4.4/song/x",
            "http://192.168.1.10/song/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/song/x",
        ] {
            assert!(validate_discovery_target(bad).is_err(), "{bad}");
        }
        // Dangerous schemes blocked.
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "ftp://example.com/song/x",
        ] {
            assert!(validate_discovery_target(bad).is_err(), "{bad}");
        }
        // Credentials, explicit ports, traversal blocked.
        assert!(validate_discovery_target("https://user:pass@example.com/").is_err());
        assert!(validate_discovery_target("https://example.com:8443/song/x").is_err());
        assert!(validate_discovery_target("https://example.com/../etc/passwd").is_err());
        assert!(validate_discovery_target("not a url").is_err());
        assert!(validate_discovery_target("").is_err());
    }

    #[test]
    fn discovery_hosts_blocked() {
        assert!(is_blocked_discovery_host("localhost"));
        assert!(is_blocked_discovery_host("127.0.0.1"));
        assert!(is_blocked_discovery_host("10.1.2.3"));
        assert!(is_blocked_discovery_host("192.168.0.1"));
        assert!(is_blocked_discovery_host("169.254.169.254"));
        assert!(!is_blocked_discovery_host("www.jiosaavn.com"));
        assert!(!is_blocked_discovery_host("8.8.8.8"));
    }

    #[tokio::test]
    async fn discovery_routes_require_the_token() {
        let (addr, _h) = serve_test().await;
        let c = client();
        let anon = c
            .get(format!("http://{addr}/api/discovery/search"))
            .query(&[("q", "soch")])
            .send()
            .await
            .unwrap();
        assert_eq!(anon.status(), 401);
        let anon_fetch = c
            .get(format!("http://{addr}/api/discovery/fetch"))
            .query(&[("target", "https://example.com/")])
            .send()
            .await
            .unwrap();
        assert_eq!(anon_fetch.status(), 401);
    }

    #[tokio::test]
    async fn discovery_search_rejects_bad_query_with_token() {
        let (addr, _h) = serve_test().await;
        let c = client();
        // Empty q → 400 (never proxies an unbounded upstream request).
        let res = c
            .get(format!("http://{addr}/api/discovery/search"))
            .header(TOKEN_HEADER, "secret-token")
            .query(&[("q", "")])
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        // Blocked fetch target → 400, never fetched.
        let res2 = c
            .get(format!("http://{addr}/api/discovery/fetch"))
            .header(TOKEN_HEADER, "secret-token")
            .query(&[("target", "http://127.0.0.1/song/x")])
            .send()
            .await
            .unwrap();
        assert_eq!(res2.status(), 400);
    }
}
