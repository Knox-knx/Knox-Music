//! GStreamer plugin-path repair for AppImage (and other relocated) installs.
//!
//! ROOT CAUSE of the production "black screen on playback" (proven live):
//! the AppImage bundles GStreamer's *core libraries* (pulled in as WebKitGTK
//! dependencies by the packager) but *no plugin directory*. GStreamer 1.28
//! then relocates its plugin search to `<bundled-lib-dir>/gstreamer-1.0`
//! (nonexistent), and the AppRun wrapper additionally sets
//! `GST_PLUGIN_SYSTEM_PATH_1_0` to that same nonexistent directory.
//! Result: ZERO plugins visible (`gst-inspect` count 4 vs 1685 on host) →
//! WebKit's `autoaudiosink` factory lookup returns NULL when audio starts →
//! `g_signal_connect_data: assertion 'G_TYPE_CHECK_INSTANCE' failed` → NULL
//! dereference → **WebKitWebProcess SIGSEGV** → permanent blank WebView
//! (Tauri does not relaunch it; React/ErrorBoundary cannot catch a native
//! crash). The native window/title bar stay alive, which matches the report.
//!
//! REPAIR: runs as the first statement of `main()`, before any GTK/WebKit
//! init. The WebKitWebProcess inherits this process's environment at spawn,
//! so one early fix covers both processes. If the configured plugin path
//! lists no usable directory, the host's real plugin directory is appended
//! (bundled 1.28.4 core + host 1.28.x plugins verified compatible: isolated
//! WebKit harness constructs the pipeline and reaches `canplaythrough`
//! with no crash). Explicitly user-configured VALID paths are never touched,
//! and on a truly plugin-less system the environment is left alone (the
//! .deb already declares the GStreamer runtime dependencies).

use std::path::{Path, PathBuf};

/// Marker logged/emitted when the repair fires (also used by the packaging
/// validation script to prove the repair is present in the binary).
pub(crate) const REPAIR_MARKER: &str = "knox-gst-plugin-path-repair-v1";

/// Plugin-path variables honored by GStreamer 1.x, most-specific first.
const PLUGIN_PATH_VARS: [&str; 2] = ["GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_SYSTEM_PATH"];

/// Helper binary GStreamer spawns to scan plugin files. When the AppImage
/// bundles its own lib/gstreamer tree without this helper (or AppRun points
/// elsewhere), registry rebuilds fail with "External plugin loader failed".
/// This is an executable file — never a plugin `.so` directory.
const SCANNER_VAR: &str = "GST_PLUGIN_SCANNER";
const SCANNER_FILE_NAME: &str = "gst-plugin-scanner";

/// Host plugin directories across distro families (Debian/Ubuntu, Fedora/
/// RHEL, Arch, plus Debian multiarch triplets). First existing directory
/// that actually contains plugins wins.
fn host_candidates() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/usr/lib/x86_64-linux-gnu/gstreamer-1.0"),
        PathBuf::from("/usr/lib/aarch64-linux-gnu/gstreamer-1.0"),
        PathBuf::from("/usr/lib64/gstreamer-1.0"),
        PathBuf::from("/usr/lib/gstreamer-1.0"),
        PathBuf::from("/usr/lib32/gstreamer-1.0"),
    ];
    // Respect an explicit admin override without trusting it blindly (it
    // still has to contain plugins to count).
    if let Some(extra) = std::env::var_os("KNOX_GST_PLUGIN_DIR") {
        let p = PathBuf::from(extra);
        if !out.contains(&p) {
            out.insert(0, p);
        }
    }
    out
}

/// True when `dir` exists and contains at least one loadable plugin object.
/// Cheap by design (short-circuits on the first `.so`); runs once at startup.
fn dir_has_plugins(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    match std::fs::read_dir(dir) {
        Ok(mut entries) => entries.any(|e| {
            e.map(|e| {
                let p = e.path();
                p.is_file()
                    && p.extension().and_then(|x| x.to_str()) == Some("so")
                    && p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.starts_with("libgst"))
                        .unwrap_or(false)
            })
            .unwrap_or(false)
        }),
        Err(_) => false,
    }
}

fn path_list_has_plugins(value: &std::ffi::OsStr) -> bool {
    std::env::split_paths(value).any(|p| dir_has_plugins(&p))
}

/// Repair one variable against an explicit candidate list (pure enough to
/// unit-test; production passes [`host_candidates`]).
/// Returns the host dir that was appended, if any.
fn repair_one_with(var: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    let current = std::env::var_os(var);
    let usable = current
        .as_ref()
        .map(|v| path_list_has_plugins(v))
        .unwrap_or(false);
    if usable {
        return None; // valid config (e.g. admin/user override) — never clobber
    }
    let host = candidates.iter().find(|p| dir_has_plugins(p))?.clone();
    let mut paths: Vec<PathBuf> = current
        .as_ref()
        .map(|v| std::env::split_paths(v).collect())
        .unwrap_or_default();
    if !paths.contains(&host) {
        paths.push(host.clone());
    }
    // join_paths only fails on embedded `:`/`;` — paths came from split_paths
    // plus our own vetted candidate, so this cannot realistically fail; if it
    // does, fall back to the host dir alone rather than leaving it broken.
    match std::env::join_paths(paths) {
        Ok(joined) => std::env::set_var(var, joined),
        Err(_) => std::env::set_var(var, &host),
    }
    Some(host)
}

/// Inspect both GStreamer plugin-path variables and append a working host
/// plugin directory when nothing configured is usable. Idempotent.
pub(crate) fn repair_gstreamer_env() {
    let candidates = host_candidates();
    for var in PLUGIN_PATH_VARS {
        match repair_one_with(var, &candidates) {
            Some(host) => eprintln!(
                "[knox] {REPAIR_MARKER}: {var} listed no usable plugin directory; using {}",
                host.display()
            ),
            None => {
                // Either already usable (untouched) or no host plugins exist
                // anywhere (truly minimal system — leave the env alone).
            }
        }
    }
    // Independent scanner repair (never touches the directory vars above):
    // a missing/unusable GST_PLUGIN_SCANNER is pointed at a valid host
    // helper so "External plugin loader failed" goes away. Never crashes.
    match repair_scanner_env() {
        Some(scanner) => eprintln!(
            "[knox] {REPAIR_MARKER}: {SCANNER_VAR} listed no usable scanner; using {}",
            scanner.display()
        ),
        None => {
            if std::env::var_os(SCANNER_VAR)
                .map(|v| scanner_is_usable(&PathBuf::from(v)))
                .unwrap_or(false)
            {
                // Valid user-provided scanner — untouched, no log spam.
            } else {
                eprintln!(
                    "[knox] {REPAIR_MARKER}: {SCANNER_VAR} has no usable scanner and none was found on the host; continuing without scanner repair"
                );
            }
        }
    }
}

/// True when `p` is an existing executable helper file (not a directory —
/// a plugin `.so` directory such as `.../gstreamer-1.0` never counts).
fn scanner_is_usable(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(p) {
            Ok(md) => md.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Host scanner helpers across distro families. Explicit known multiarch
/// paths first (Kali/Debian i386 + amd64 verified on host), then
/// architecture-independent discovery (`/usr/lib/*/gstreamer1.0/...` plus
/// `$PATH`), so no single hardcoded path is the only solution.
fn scanner_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    // Explicit admin override wins when usable (still validated on use).
    if let Some(extra) = std::env::var_os("KNOX_GST_SCANNER") {
        let p = PathBuf::from(extra);
        if !out.contains(&p) {
            out.push(p);
        }
    }
    for p in [
        "/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib/i386-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib64/gstreamer-1.0/gstreamer-1.0/gst-plugin-scanner",
        "/usr/libexec/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib/gstreamer-1.0/gstreamer-1.0/gst-plugin-scanner",
    ] {
        let pb = PathBuf::from(p);
        if !out.contains(&pb) {
            out.push(pb);
        }
    }
    // Architecture-independent Debian/Kali multiarch discovery: any
    // `/usr/lib/<triplet>/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner`.
    if let Ok(entries) = std::fs::read_dir("/usr/lib") {
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| {
                e.path()
                    .join("gstreamer1.0")
                    .join("gstreamer-1.0")
                    .join(SCANNER_FILE_NAME)
            })
            .filter(|p| !out.contains(p))
            .collect();
        found.sort();
        out.append(&mut found);
    }
    // `$PATH` fallback (e.g. /usr/bin/gst-plugin-scanner on some distros).
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(SCANNER_FILE_NAME);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Repair one scanner variable against an explicit candidate list (pure
/// enough to unit-test; production passes [`scanner_candidates`]).
/// Returns the scanner path that was set, if any. Never overwrites a valid
/// user-provided scanner and never points at a plugin directory.
fn repair_scanner_with(var: &str, candidates: &[PathBuf]) -> Option<PathBuf> {
    let current = std::env::var_os(var);
    let usable = current
        .as_ref()
        .map(|v| scanner_is_usable(&PathBuf::from(v)))
        .unwrap_or(false);
    if usable {
        return None; // valid config — never clobber
    }
    let scanner = candidates.iter().find(|p| scanner_is_usable(p))?.clone();
    std::env::set_var(var, &scanner);
    Some(scanner)
}

/// Inspect `GST_PLUGIN_SCANNER` and point it at a valid host helper when
/// missing or unusable. Idempotent. Returns the scanner set, if any.
fn repair_scanner_env() -> Option<PathBuf> {
    let candidates = scanner_candidates();
    repair_scanner_with(SCANNER_VAR, &candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env vars are process-global: serialize these tests.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn unique_base(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "knox-gst-test-{}-{}-{}",
            tag,
            std::process::id(),
            // nanos for uniqueness across repeated runs
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ))
    }

    fn make_plugin_dir(tag: &str) -> PathBuf {
        let dir = unique_base(tag);
        std::fs::create_dir_all(&dir).expect("create temp plugin dir");
        std::fs::write(dir.join("libgstcoreelements.so"), b"fake").expect("write fake plugin");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_file(dir.join("libgstcoreelements.so"));
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn empty_var_gets_host_dir() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_GST_EMPTY";
        std::env::remove_var(var);
        let host = make_plugin_dir("empty");
        let got = repair_one_with(var, &[host.clone()]);
        assert_eq!(got, Some(host.clone()));
        let val = std::env::var_os(var).expect("var must be set");
        assert!(std::env::split_paths(&val).any(|p| p == host));
        std::env::remove_var(var);
        cleanup(&host);
    }

    #[test]
    fn ghost_appdir_path_is_repaired_not_clobbered() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_GST_GHOST";
        // Exactly what the AppImage AppRun produces: nonexistent AppDir dirs.
        std::env::set_var(
            var,
            "/tmp/appimage-extracted-xxxx/usr/lib/gstreamer-1.0:/nonexistent/gst",
        );
        let host = make_plugin_dir("ghost");
        let got = repair_one_with(var, &[host.clone()]);
        assert_eq!(got, Some(host.clone()));
        let val = std::env::var_os(var).expect("var must be set");
        let paths: Vec<PathBuf> = std::env::split_paths(&val).collect();
        assert!(paths.contains(&host), "host dir must be appended");
        std::env::remove_var(var);
        cleanup(&host);
    }

    #[test]
    fn valid_user_path_is_never_touched() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_GST_VALID";
        let user = make_plugin_dir("user");
        let other = make_plugin_dir("other");
        std::env::set_var(var, &user);
        let got = repair_one_with(var, &[other.clone()]);
        assert_eq!(got, None, "valid config must not be modified");
        assert_eq!(std::env::var_os(var).as_deref(), Some(user.as_os_str()));
        std::env::remove_var(var);
        cleanup(&user);
        cleanup(&other);
    }

    #[test]
    fn no_candidates_anywhere_leaves_env_alone() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_GST_NONE";
        std::env::remove_var(var);
        let missing = unique_base("missing"); // never created
        let got = repair_one_with(var, &[missing]);
        assert_eq!(got, None);
        assert!(std::env::var_os(var).is_none());
    }

    #[test]
    fn empty_dir_without_plugins_does_not_count() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_GST_EMPTYDIR";
        let empty = unique_base("emptydir");
        std::fs::create_dir_all(&empty).expect("create empty dir");
        std::env::set_var(var, &empty);
        let host = make_plugin_dir("realplugins");
        let got = repair_one_with(var, &[host.clone()]);
        assert_eq!(got, Some(host.clone()));
        std::env::remove_var(var);
        let _ = std::fs::remove_dir(&empty);
        cleanup(&host);
    }

    // --- Scanner repair tests (independent of the directory repair) ---

    #[cfg(unix)]
    fn make_scanner_file(tag: &str, executable: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_base(tag);
        std::fs::create_dir_all(&dir).expect("create temp scanner dir");
        let file = dir.join(SCANNER_FILE_NAME);
        std::fs::write(&file, b"#!/bin/sh\nexit 0\n").expect("write fake scanner");
        let mut perms = std::fs::metadata(&file).expect("stat scanner").permissions();
        perms.set_mode(if executable { 0o755 } else { 0o644 });
        std::fs::set_permissions(&file, perms).expect("chmod scanner");
        file
    }

    #[cfg(unix)]
    fn cleanup_scanner(file: &Path) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::remove_file(file);
            let _ = std::fs::remove_dir(dir);
        }
    }

    #[test]
    fn scanner_already_valid_is_preserved() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_VALID";
        #[cfg(unix)]
        {
            let good = make_scanner_file("scannervalid", true);
            let other = make_scanner_file("scannerother", true);
            std::env::set_var(var, &good);
            let got = repair_scanner_with(var, &[other.clone()]);
            assert_eq!(got, None, "valid user scanner must not be modified");
            assert_eq!(std::env::var_os(var).as_deref(), Some(good.as_os_str()));
            std::env::remove_var(var);
            cleanup_scanner(&good);
            cleanup_scanner(&other);
        }
        #[cfg(not(unix))]
        {
            let _ = var;
        }
    }

    #[test]
    fn scanner_missing_is_discovered() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_MISSING";
        std::env::remove_var(var);
        #[cfg(unix)]
        {
            let host = make_scanner_file("scannermissing", true);
            let got = repair_scanner_with(var, &[host.clone()]);
            assert_eq!(got, Some(host.clone()));
            assert_eq!(std::env::var_os(var).as_deref(), Some(host.as_os_str()));
            std::env::remove_var(var);
            cleanup_scanner(&host);
        }
        #[cfg(not(unix))]
        {
            let _ = var;
        }
    }

    #[test]
    fn scanner_pointing_to_nonexistent_file_falls_back() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_GHOST";
        std::env::set_var(var, "/nonexistent/gst-plugin-scanner");
        #[cfg(unix)]
        {
            let host = make_scanner_file("scannerghost", true);
            let got = repair_scanner_with(var, &[host.clone()]);
            assert_eq!(got, Some(host.clone()));
            assert_eq!(std::env::var_os(var).as_deref(), Some(host.as_os_str()));
            std::env::remove_var(var);
            cleanup_scanner(&host);
        }
        #[cfg(not(unix))]
        {
            let _ = var;
        }
    }

    #[test]
    fn non_executable_scanner_is_rejected_and_search_continues() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_NOEXEC";
        #[cfg(unix)]
        {
            let bad = make_scanner_file("scannerbad", false);
            let good = make_scanner_file("scannergood", true);
            std::env::remove_var(var);
            let got = repair_scanner_with(var, &[bad.clone(), good.clone()]);
            assert_eq!(got, Some(good.clone()), "non-executable must be skipped");
            assert_eq!(std::env::var_os(var).as_deref(), Some(good.as_os_str()));
            // A non-executable current value is unusable → also repaired.
            std::env::set_var(var, &bad);
            let got2 = repair_scanner_with(var, &[bad.clone(), good.clone()]);
            assert_eq!(got2, Some(good.clone()));
            std::env::remove_var(var);
            cleanup_scanner(&bad);
            cleanup_scanner(&good);
        }
        #[cfg(not(unix))]
        {
            let _ = var;
        }
    }

    #[test]
    fn scanner_pointing_to_plugin_directory_is_rejected() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_ISDIR";
        // A plugin directory is not the scanner executable — must not count.
        let plugdir = make_plugin_dir("scannerisdir");
        std::env::set_var(var, &plugdir);
        #[cfg(unix)]
        {
            let good = make_scanner_file("scannerisdirgood", true);
            let got = repair_scanner_with(var, &[plugdir.clone(), good.clone()]);
            assert_eq!(got, Some(good.clone()));
            assert_eq!(std::env::var_os(var).as_deref(), Some(good.as_os_str()));
            std::env::remove_var(var);
            cleanup_scanner(&good);
        }
        #[cfg(not(unix))]
        {
            let _ = var;
        }
        std::env::remove_var(var);
        cleanup(&plugdir);
    }

    #[test]
    fn no_scanner_anywhere_leaves_env_alone_without_crash() {
        let _g = ENV_LOCK.lock().unwrap();
        let var = "KNOX_TEST_SCANNER_NONE";
        std::env::remove_var(var);
        let missing = unique_base("scannermissingbin").join(SCANNER_FILE_NAME); // never created
        let got = repair_scanner_with(var, &[missing]);
        assert_eq!(got, None);
        assert!(std::env::var_os(var).is_none());
    }

    #[test]
    fn plugin_dir_and_scanner_repair_independently() {
        let _g = ENV_LOCK.lock().unwrap();
        let dir_var = "KNOX_TEST_BOTH_DIR";
        let scan_var = "KNOX_TEST_BOTH_SCAN";
        std::env::set_var(dir_var, "/nonexistent/gst-plugins");
        std::env::remove_var(scan_var);
        let host_dir = make_plugin_dir("bothdir");
        let dir_got = repair_one_with(dir_var, &[host_dir.clone()]);
        assert_eq!(dir_got, Some(host_dir.clone()));
        #[cfg(unix)]
        {
            let host_scan = make_scanner_file("bothscan", true);
            let scan_got = repair_scanner_with(scan_var, &[host_scan.clone()]);
            assert_eq!(scan_got, Some(host_scan.clone()));
            // Each repair touched only its own variable.
            let dir_val = std::env::var_os(dir_var).expect("dir var set");
            assert!(std::env::split_paths(&dir_val).any(|p| p == host_dir));
            assert_eq!(std::env::var_os(scan_var).as_deref(), Some(host_scan.as_os_str()));
            std::env::remove_var(scan_var);
            cleanup_scanner(&host_scan);
        }
        std::env::remove_var(dir_var);
        cleanup(&host_dir);
    }

    #[test]
    fn scanner_candidates_include_known_kali_paths_and_path_discovery() {
        let _g = ENV_LOCK.lock().unwrap();
        let c = scanner_candidates();
        assert!(c.iter().any(|p| p
            == &PathBuf::from(
                "/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
            )));
        assert!(c.iter().any(|p| p
            == &PathBuf::from(
                "/usr/lib/i386-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
            )));
        // Never a bare plugin directory.
        assert!(!c.iter().any(|p| p
            == &PathBuf::from("/usr/lib/x86_64-linux-gnu/gstreamer-1.0")));
        // File names are always the helper, and discovery is not limited to
        // a single hardcoded entry.
        assert!(c.len() > 2);
        assert!(c.iter().all(|p| p.file_name().and_then(|n| n.to_str()) == Some(SCANNER_FILE_NAME)
            || std::env::var_os("KNOX_GST_SCANNER").map(|v| PathBuf::from(v) == *p).unwrap_or(false)));
    }
}
