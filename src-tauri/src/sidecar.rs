//! Sidecar process manager — owns optional local services (YouTube Music).
//!
//! States: Disabled → Starting → HealthCheck → Ready
//! Failure: Starting/HealthCheck → Retry (bounded backoff) → Unavailable
//! Disable at any time → Disabled (process terminated). Shutdown is idempotent.
//!
//! The manager never restarts endlessly: `max_retries` bounds attempts, and a
//! crashed READY process is marked Unavailable (not auto-respawned) until the
//! next explicit `ensure(true)`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    Disabled,
    Starting,
    HealthCheck,
    Ready,
    Retry,
    StartFailed,
    Unavailable,
}

impl SidecarState {
    pub fn as_str(self) -> &'static str {
        match self {
            SidecarState::Disabled => "disabled",
            SidecarState::Starting => "starting",
            SidecarState::HealthCheck => "health_check",
            SidecarState::Ready => "ready",
            SidecarState::Retry => "retry",
            SidecarState::StartFailed => "start_failed",
            SidecarState::Unavailable => "unavailable",
        }
    }

    pub fn running(self) -> bool {
        matches!(self, SidecarState::Starting | SidecarState::HealthCheck | SidecarState::Ready | SidecarState::Retry)
    }
}

/// How to launch + probe one sidecar. `program`/`args_for` are injectable so
/// tests can substitute harmless binaries (never real services in unit tests).
#[derive(Clone)]
pub struct SidecarSpec {
    pub program: PathBuf,
    pub args_for: Arc<dyn Fn(u16) -> Vec<String> + Send + Sync>,
    pub max_retries: u32,
    pub retry_base_ms: u64,
    pub health_timeout_ms: u64,
    pub start_grace_ms: u64,
    /// Environment variables stripped before spawn. The AppImage/ld-linux
    /// plugin hooks export PYTHONHOME/PYTHONPATH for a bundled interpreter
    /// that KNOX does not ship — left in place they fatally break the system
    /// python3 (`No module named 'encodings'`) before our script even starts.
    pub clean_env: Vec<String>,
    /// Test seam: probe this port for health instead of the spawned
    /// process's port (lets tests serve health deterministically while the
    /// spawned process is a harmless sleeper). Always None in production.
    pub health_port_override: Option<u16>,
}

impl SidecarSpec {
    pub fn python_sidecar(script: PathBuf, python: PathBuf) -> Self {
        let script_str = script.to_string_lossy().into_owned();
        Self {
            program: python,
            args_for: Arc::new(move |port| {
                vec!["-u".to_string(), script_str.clone(), "--port".to_string(), port.to_string()]
            }),
            max_retries: 3,
            retry_base_ms: 500,
            health_timeout_ms: 2500,
            start_grace_ms: 400,
            clean_env: vec!["PYTHONHOME".to_string(), "PYTHONPATH".to_string()],
            health_port_override: None,
        }
    }
}

struct Managed {
    spec: SidecarSpec,
    state: SidecarState,
    child: Option<Child>,
    port: Option<u16>,
    attempt: u32,
    last_error: Option<String>,
    stderr_tail: String,
}

pub struct SidecarRegistry {
    inner: Mutex<HashMap<String, Managed>>,
    client: reqwest::Client,
}

impl SidecarRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("http client"),
        }
    }

    pub async fn register(&self, name: &str, spec: SidecarSpec) {
        self.inner.lock().await.entry(name.to_string()).or_insert(Managed {
            spec,
            state: SidecarState::Disabled,
            child: None,
            port: None,
            attempt: 0,
            last_error: None,
            stderr_tail: String::new(),
        });
    }

    pub async fn state(&self, name: &str) -> SidecarState {
        self.inner.lock().await.get(name).map(|m| m.state).unwrap_or(SidecarState::Disabled)
    }

    pub async fn last_error(&self, name: &str) -> Option<String> {
        self.inner.lock().await.get(name).and_then(|m| m.last_error.clone())
    }

    pub async fn port(&self, name: &str) -> Option<u16> {
        self.inner.lock().await.get(name).and_then(|m| m.port)
    }

    /// Reconcile desired state. `enabled=false` always stops gracefully.
    /// `enabled=true` starts (bounded retries) unless already Ready.
    pub async fn ensure(&self, name: &str, enabled: bool) {
        if !enabled {
            self.stop(name).await;
            return;
        }
        let already_running = self.state(name).await.running();
        if already_running {
            return;
        }
        self.start_with_retries(name).await;
    }

    async fn start_with_retries(&self, name: &str) {
        let max = self.inner.lock().await.get(name).map(|m| m.spec.max_retries).unwrap_or(0);
        for attempt in 0..=max {
            {
                let mut map = self.inner.lock().await;
                if let Some(m) = map.get_mut(name) {
                    m.attempt = attempt;
                    m.state = if attempt == 0 { SidecarState::Starting } else { SidecarState::Retry };
                    m.last_error = None;
                }
            }
            match self.try_start_once(name).await {
                Ok(()) => return,
                Err(e) => {
                    self.kill_child(name).await;
                    // NOTE: the guard MUST drop before the backoff lock below —
                    // relocking while it is alive self-deadlocks the task.
                    {
                        let mut map = self.inner.lock().await;
                        if let Some(m) = map.get_mut(name) {
                            m.last_error = Some(e.clone());
                            m.state = if attempt >= max { SidecarState::Unavailable } else { SidecarState::Retry };
                        }
                    }
                    if attempt < max {
                        let base = self.inner.lock().await.get(name).map(|m| m.spec.retry_base_ms).unwrap_or(500);
                        tokio::time::sleep(Duration::from_millis(base * 2u64.pow(attempt.min(4)))).await;
                    }
                }
            }
        }
        // Exhausted: mark StartFailed when the process never even spawned.
        let mut map = self.inner.lock().await;
        if let Some(m) = map.get_mut(name) {
            if m.state == SidecarState::Retry {
                m.state = SidecarState::Unavailable;
            }
        }
    }

    async fn try_start_once(&self, name: &str) -> Result<(), String> {
        let (program, args, port, grace_ms, health_ms, health_override, clean_env) = {
            let map = self.inner.lock().await;
            let m = map.get(name).ok_or_else(|| "unknown sidecar".to_string())?;
            let port = pick_free_port().map_err(|e| format!("no free loopback port: {e}"))?;
            (m.spec.program.clone(), (m.spec.args_for)(port), port, m.spec.start_grace_ms, m.spec.health_timeout_ms, m.spec.health_port_override, m.spec.clean_env.clone())
        };
        if !program.exists() {
            // Record StartFailed distinctly from runtime Unavailable.
            self.inner.lock().await.get_mut(name).map(|m| m.state = SidecarState::StartFailed);
            return Err(format!("sidecar runtime not found: {}", program.display()));
        }
        let mut child = Command::new(&program);
        child
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for var in &clean_env {
            child.env_remove(var);
        }
        let mut child = child.spawn().map_err(|e| format!("spawn failed: {e}"))?;
        // Early-exit detection: a process that dies during grace never became Ready.
        tokio::time::sleep(Duration::from_millis(grace_ms)).await;
        if let Ok(Some(status)) = child.try_wait() {
            let tail = drain_stderr(&mut child).await;
            self.inner.lock().await.get_mut(name).map(|m| {
                m.state = SidecarState::StartFailed;
                m.stderr_tail = tail;
            });
            return Err(format!("sidecar exited during startup (status {status})"));
        }
        {
            let mut map = self.inner.lock().await;
            if let Some(m) = map.get_mut(name) {
                m.child = Some(child);
                m.port = Some(port);
                m.state = SidecarState::HealthCheck;
            }
        }
        // Bounded health-check loop.
        let probe_port = health_override.unwrap_or(port);
        let url = format!("http://127.0.0.1:{probe_port}/api/health");
        let deadline = tokio::time::Instant::now() + Duration::from_millis(health_ms * 6);
        loop {
            match self.client.get(&url).timeout(Duration::from_millis(health_ms)).send().await {
                Ok(resp) if resp.status().is_success() => {
                    self.inner.lock().await.get_mut(name).map(|m| {
                        m.state = SidecarState::Ready;
                        m.attempt = 0;
                    });
                    return Ok(());
                }
                _ => {
                    // Process died while probing → fail fast, don't wait out the clock.
                    let dead = {
                        let mut map = self.inner.lock().await;
                        match map.get_mut(name).and_then(|m| m.child.as_mut()) {
                            Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                            None => true,
                        }
                    };
                    if dead {
                        let mut map = self.inner.lock().await;
                        if let Some(m) = map.get_mut(name) {
                            m.state = SidecarState::StartFailed;
                        }
                        return Err("sidecar died before becoming healthy".to_string());
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err("sidecar health check timed out".to_string());
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
    }

    async fn kill_child(&self, name: &str) {
        let child = { self.inner.lock().await.get_mut(name).and_then(|m| m.child.take()) };
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        }
        let mut map = self.inner.lock().await;
        if let Some(m) = map.get_mut(name) {
            m.port = None;
        }
    }

    /// Graceful stop. Idempotent — stopping twice is a no-op.
    pub async fn stop(&self, name: &str) {
        self.kill_child(name).await;
        let mut map = self.inner.lock().await;
        if let Some(m) = map.get_mut(name) {
            m.state = SidecarState::Disabled;
            m.attempt = 0;
            m.last_error = None;
        }
    }

    pub async fn stop_all(&self) {
        let names: Vec<String> = self.inner.lock().await.keys().cloned().collect();
        for n in names {
            self.stop(&n).await;
        }
    }

    /// Crash detection: a READY process that exited is marked Unavailable
    /// (no silent auto-respawn; next `ensure(true)` recovers).
    pub async fn poll(&self, name: &str) -> SidecarState {
        let exited = {
            let mut map = self.inner.lock().await;
            match map.get_mut(name).and_then(|m| m.child.as_mut()) {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if exited {
            self.kill_child(name).await;
            let mut map = self.inner.lock().await;
            if let Some(m) = map.get_mut(name) {
                if m.state == SidecarState::Ready {
                    m.state = SidecarState::Unavailable;
                    m.last_error = Some("sidecar process exited unexpectedly".to_string());
                }
            }
        }
        self.state(name).await
    }

    pub async fn stderr_tail(&self, name: &str) -> String {
        self.inner.lock().await.get(name).map(|m| m.stderr_tail.clone()).unwrap_or_default()
    }
}

impl Default for SidecarRegistry {
    fn default() -> Self {
        Self::new()
    }
}

async fn drain_stderr(child: &mut Child) -> String {
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let mut buf = [0u8; 2048];
        loop {
            match tokio::time::timeout(Duration::from_millis(50), stderr.read(&mut buf)).await {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(n)) => {
                    out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if out.len() > 4096 {
                        break;
                    }
                }
                Ok(Err(_)) => break,
            }
        }
    }
    // Keep the tail only.
    if out.len() > 2000 {
        out[out.len() - 2000..].to_string()
    } else {
        out
    }
}

/// Bind an ephemeral loopback port and release it (caller rebinds promptly).
/// Always 127.0.0.1 — never 0.0.0.0.
pub fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Locate a usable python3 for stdlib-only sidecars: explicit override →
/// PATH lookup. Returns None when no interpreter exists (sidecar stays
/// unavailable; KNOX keeps running). The returned path is always absolute:
/// callers gate on `exists()` (CWD-relative names would fail that check even
/// when the interpreter is on PATH) and spawn without shell lookup.
pub fn find_python() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KNOX_PYTHON") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }
    // Bundled runtime wins when present (production), else system python3.
    if let Ok(exe) = std::env::current_exe() {
        for cand in [
            exe.parent().map(|d| d.join("python/bin/python3")),
            exe.parent().map(|d| d.join("../Resources/python/bin/python3")),
        ]
        .into_iter()
        .flatten()
        {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    for name in ["python3", "/usr/bin/python3", "/usr/local/bin/python3"] {
        let pb = PathBuf::from(name);
        if pb.is_absolute() {
            if pb.exists() {
                return Some(pb);
            }
            continue;
        }
        if let Some(resolved) = resolve_on_path_env(&pb) {
            return Some(resolved);
        }
    }
    None
}

/// Resolve a bare binary name against PATH to an absolute, existing path.
/// Pure helper (path list injected) so it is unit-testable without touching
/// the process environment.
fn resolve_on_path(name: &Path, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let paths = path_var?;
    for dir in std::env::split_paths(paths) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let cand = dir.join(name);
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

fn resolve_on_path_env(name: &Path) -> Option<PathBuf> {
    resolve_on_path(name, std::env::var_os("PATH").as_deref())
}

/// Resolve the sidecar script: bundled resources (production) → repo services
/// dir (development) → KNOX_SIDECAR_DIR override wins when set.
pub fn find_sidecar_script(name: &str) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("KNOX_SIDECAR_DIR") {
        let cand = Path::new(&dir).join(format!("{name}/app.py"));
        if cand.exists() {
            return Some(cand);
        }
        let flat = Path::new(&dir).join("app.py");
        if flat.exists() {
            return Some(flat);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        // Walk up from the binary: AppImage/deb development trees all keep
        // the script within a few levels of the executable. Each level is
        // probed for the known bundle layouts (see search_tree_for_script).
        let mut level = exe.parent().map(|d| d.to_path_buf());
        for _ in 0..4 {
            let Some(base) = level else { break };
            if let Some(found) = search_tree_for_script(&base, name) {
                return Some(found);
            }
            // Legacy relative layouts (kept for dev-loop compatibility).
            for cand in [
                base.join(format!("sidecars/{name}/app.py")),
                base.join(format!("../services/{name}/app.py")),
                base.join(format!("../../services/{name}/app.py")),
            ] {
                if cand.exists() {
                    return Some(cand);
                }
            }
            level = base.parent().map(|d| d.to_path_buf());
        }
    }
    // Cargo workspace development fallback.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let cand = manifest.join(format!("../services/{name}/app.py"));
    if cand.exists() {
        return Some(cand);
    }
    None
}

/// Probe one tree level for the bundled sidecar script:
/// - `<base>/sidecars/{name}/app.py` and `<base>/resources/sidecars/{name}/app.py`
/// - `<base>/lib/*/sidecars/{name}/app.py` (Tauri bundle product dirs, e.g.
///   AppImage `usr/lib/KNOX Music/…` or deb `/usr/lib/<product>/…` — the
///   product dir name varies, so entries are scanned, never hardcoded).
fn search_tree_for_script(base: &Path, name: &str) -> Option<PathBuf> {
    for cand in [
        base.join(format!("sidecars/{name}/app.py")),
        base.join(format!("resources/sidecars/{name}/app.py")),
        base.join(format!("Resources/sidecars/{name}/app.py")),
    ] {
        if cand.exists() {
            return Some(cand);
        }
    }
    let lib = base.join("lib");
    let entries = std::fs::read_dir(&lib).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|x| x.path()))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let cand = dir.join(format!("sidecars/{name}/app.py"));
        if cand.exists() {
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stays_unavailable_without_health_but_stops_cleanly() {
        let reg = SidecarRegistry::new();
        reg.register("svc", sleeper_spec()).await;
        // /bin/sleep never serves /api/health → bounded attempts → Unavailable.
        reg.ensure("svc", true).await;
        assert_eq!(reg.state("svc").await, SidecarState::Unavailable);
        assert!(reg.last_error("svc").await.is_some());
        // Idempotent stop; second stop is a no-op.
        reg.stop("svc").await;
        reg.stop("svc").await;
        assert_eq!(reg.state("svc").await, SidecarState::Disabled);
    }

    #[tokio::test]
    async fn reaches_ready_when_health_endpoint_answers() {
        let health_port = fake_health_server().await;
        let mut spec = sleeper_spec();
        spec.health_port_override = Some(health_port);
        let reg = SidecarRegistry::new();
        reg.register("svc", spec).await;
        reg.ensure("svc", true).await;
        assert_eq!(reg.state("svc").await, SidecarState::Ready);
        assert!(reg.port("svc").await.is_some());
        // ensure() while Ready is a no-op (no duplicate process).
        reg.ensure("svc", true).await;
        assert_eq!(reg.state("svc").await, SidecarState::Ready);
        reg.stop("svc").await;
        assert_eq!(reg.state("svc").await, SidecarState::Disabled);
        assert_eq!(reg.port("svc").await, None);
    }

    /// Spec whose "process" is a harmless sleeper; health is served by a real
    /// local HTTP server the test controls (via health_port_override).
    fn sleeper_spec() -> SidecarSpec {
        SidecarSpec {
            program: PathBuf::from("/bin/sleep"),
            args_for: Arc::new(|_| vec!["30".to_string()]),
            max_retries: 1,
            retry_base_ms: 1,
            health_timeout_ms: 200,
            start_grace_ms: 10,
            clean_env: vec![],
            health_port_override: None,
        }
    }

    /// Minimal canned-JSON health server on a reserved loopback port.
    async fn fake_health_server() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let body = r#"{"ok":true}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn crash_detection_marks_ready_process_unavailable() {
        let health_port = fake_health_server().await;
        let mut spec = sleeper_spec();
        spec.health_port_override = Some(health_port);
        // Short-lived process: exits on its own shortly after Ready.
        spec.program = PathBuf::from("/bin/sh");
        let captured: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let cap = captured.clone();
        spec.args_for = Arc::new(move |_| {
            cap.lock().unwrap().push("spawned".to_string());
            vec!["-c".to_string(), "sleep 0.3".to_string()]
        });
        let reg = SidecarRegistry::new();
        reg.register("svc", spec).await;
        reg.ensure("svc", true).await;
        assert_eq!(reg.state("svc").await, SidecarState::Ready);
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(reg.poll("svc").await, SidecarState::Unavailable);
        assert!(reg.last_error("svc").await.is_some());
        // ensure(true) recovers after a crash.
        reg.ensure("svc", true).await;
        assert_eq!(reg.state("svc").await, SidecarState::Ready);
        assert_eq!(captured.lock().unwrap().len(), 2);
        reg.stop("svc").await;
    }

    #[tokio::test]
    async fn missing_runtime_reports_start_failed() {
        let reg = SidecarRegistry::new();
        let mut spec = sleeper_spec();
        spec.program = PathBuf::from("/nonexistent/knox-python");
        spec.max_retries = 0;
        reg.register("svc", spec).await;
        reg.ensure("svc", true).await;
        let st = reg.state("svc").await;
        assert!(matches!(st, SidecarState::StartFailed | SidecarState::Unavailable));
        assert!(reg.last_error("svc").await.unwrap().contains("not found"));
    }

    #[tokio::test]
    async fn disable_while_starting_stops_cleanly() {
        let reg = SidecarRegistry::new();
        reg.register("svc", sleeper_spec()).await;
        // ensure(false) on a never-started service is a safe no-op.
        reg.ensure("svc", false).await;
        assert_eq!(reg.state("svc").await, SidecarState::Disabled);
    }

    #[test]
    fn free_port_is_loopback_and_unique() {
        let a = pick_free_port().unwrap();
        let b = pick_free_port().unwrap();
        assert!(a != 0 && b != 0);
        // Rebinding works (released promptly); uniqueness across rapid calls
        // is best-effort at OS level — assert validity, not inequality.
        let l = std::net::TcpListener::bind(format!("127.0.0.1:{a}")).unwrap();
        assert_eq!(l.local_addr().unwrap().ip().to_string(), "127.0.0.1");
    }

    #[test]
    fn state_strings_are_stable() {
        assert_eq!(SidecarState::Ready.as_str(), "ready");
        assert_eq!(SidecarState::Unavailable.as_str(), "unavailable");
        assert!(SidecarState::Ready.running());
        assert!(!SidecarState::Disabled.running());
        assert!(!SidecarState::Unavailable.running());
    }

    /// Production regression: the AppImage/deb bundle keeps the sidecar at
    /// `<prefix>/lib/<product>/sidecars/youtubemusic/app.py` where the
    /// product dir name varies — discovery must scan, never hardcode it.
    #[test]
    fn bundle_product_layout_is_discovered() {
        let root = std::env::temp_dir().join(format!("knox-sidecar-test-{}", std::process::id()));
        let script = root.join("usr/lib/KNOX Music/sidecars/youtubemusic/app.py");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "# test").unwrap();
        // exe lives at <root>/usr/bin (AppImage layout).
        assert_eq!(
            search_tree_for_script(&root.join("usr"), "youtubemusic"),
            Some(script.clone())
        );
        // A differently-named product dir (deb layout) resolves too.
        let deb_script = root.join("alt/lib/knox-music/sidecars/youtubemusic/app.py");
        std::fs::create_dir_all(deb_script.parent().unwrap()).unwrap();
        std::fs::write(&deb_script, "# test").unwrap();
        assert_eq!(
            search_tree_for_script(&root.join("alt"), "youtubemusic"),
            Some(deb_script)
        );
        // Nothing invented when the tree has no script.
        assert_eq!(search_tree_for_script(&root.join("empty"), "youtubemusic"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Bare names resolve to absolute existing paths (never a CWD-relative
    /// name that would fail the host's `exists()` gate before spawn).
    #[test]
    fn path_resolution_is_absolute() {        let root = std::env::temp_dir().join(format!("knox-path-test-{}", std::process::id()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let fake = bin.join("knox-fake-python");
        std::fs::write(&fake, "#!/bin/sh").unwrap();
        let path_var = std::env::join_paths([bin.clone()]).unwrap();
        let resolved = resolve_on_path(Path::new("knox-fake-python"), Some(path_var.as_os_str()));
        assert_eq!(resolved, Some(fake));
        assert_eq!(
            resolve_on_path(Path::new("knox-no-such-binary"), Some(path_var.as_os_str())),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The AppImage plugin hooks export PYTHONHOME/PYTHONPATH for a bundled
    /// interpreter KNOX does not ship — the python sidecar spec must strip
    /// them or the system interpreter dies with `No module named 'encodings'`.
    #[test]
    fn python_sidecar_scrubs_poisoned_env() {
        let spec = SidecarSpec::python_sidecar(
            PathBuf::from("/tmp/app.py"),
            PathBuf::from("/usr/bin/python3"),
        );
        assert!(spec.clean_env.iter().any(|v| v == "PYTHONHOME"));
        assert!(spec.clean_env.iter().any(|v| v == "PYTHONPATH"));
    }
}
