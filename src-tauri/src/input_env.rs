//! Display-backend / input-method repair for AppImage installs.
//!
//! ROOT CAUSE of the production "cannot type in any search field" failure
//! (proven from the packaged AppImage on GNOME/Wayland):
//!
//! 1. The AppImage's linuxdeploy GTK hook (`apprun-hooks/
//!    linuxdeploy-plugin-gtk.sh`, generated at bundle time) unconditionally
//!    exports `GDK_BACKEND=x11`. That line dates to the Tauri v1 era
//!    (tauri-apps/tauri#8541, old WebKitGTK Wayland crash); on Tauri 2 +
//!    webkit2gtk-4.1 2.52 it is stale and harmful.
//! 2. Forcing `x11` puts GTK on XWayland even in a native Wayland session.
//!    On the X11 backend GTK honors `XMODIFIERS=@im=ibus` and loads the
//!    `ibus` IM module for key handling.
//! 3. The login session exports NO `IBUS_ADDRESS` (GNOME Wayland talks to
//!    ibus through the `ibus-portal` D-Bus portal instead, so plain shells
//!    never see the variable — verified: `QT_IM_MODULE=ibus`,
//!    `XMODIFIERS=@im=ibus`, `IBUS_ADDRESS` empty, daemon running with its
//!    private socket under `~/.cache/ibus/`). The X11-path ibus client
//!    therefore cannot connect:
//!      `IBUS-WARNING: Unable to connect to ibus: Could not connect`
//! 4. The unconnected ibus input context queues every key event waiting for
//!    a daemon reply that never comes, then drops them:
//!      `IBUS-WARNING: Events queue growing too big, will start to drop.`
//!    GDK → WebKit → DOM never see a `keydown` (bug taxonomy CASE B), so
//!    React inputs stay empty while Chromium (own IME stack, native
//!    Wayland text-input) works fine.
//!
//! REPAIR (runs as one of the first statements of `main()`, before any
//! GTK/WebKit init; the WebKitWebProcess inherits this process's
//! environment at spawn, so one early fix covers both processes):
//!
//! A. If `GDK_BACKEND=x11` was forced on us while the session is actually
//!    Wayland-native (`WAYLAND_DISPLAY` set or `XDG_SESSION_TYPE=wayland`),
//!    REMOVE the override so GTK/Wry/WebKit use native Wayland, where input
//!    goes through `im-wayland` + the portal and needs no `IBUS_ADDRESS`.
//!    Explicit user choice always wins: `KNOX_ALLOW_X11=1` (or `true`/`yes`)
//!    keeps the forced backend, and `KNOX_GDK_BACKEND=<backend>` sets exactly
//!    that backend instead.
//!
//! B. If we remain on the X11/XWayland path (plain X11 session, or the user
//!    opted into X11) AND GTK would use the `ibus` IM module while ibus is
//!    provably unreachable (no usable `IBUS_ADDRESS` socket), set
//!    `GTK_IM_MODULE=simple` — the built-in daemon-less IM — so plain
//!    typing, backspace, arrows, Home/End, Enter, Tab and clipboard keep
//!    working instead of being queued and dropped. A reachable ibus
//!    (address set AND socket exists) is never touched, and on Wayland the
//!    IM module is never touched either.
//!
//! What this does NOT do (per the bug constraints): no global shortcut
//! changes, no focus loops/polling, no synthetic events, no JS changes at
//! all, no forced X11, no stderr suppression — every repair logs its marker.

use std::path::{Path, PathBuf};

/// Marker logged when the Wayland backend is restored (also greppable in the
/// shipped binary so packaging checks can prove the repair is present).
pub(crate) const REPAIR_MARKER: &str = "knox-input-env-repair-v1";
/// Marker logged when the daemon-less IM fallback is applied.
pub(crate) const FALLBACK_MARKER: &str = "knox-im-fallback-v1";

/// Inspect the display/input environment and repair it when it matches the
/// proven-broken shape. Idempotent; safe to call on every launch.
pub(crate) fn repair_input_env() {
    // An explicit backend request is a direct order — honor it verbatim.
    if let Some(wanted) = std::env::var_os("KNOX_GDK_BACKEND") {
        if !wanted.is_empty() {
            std::env::set_var("GDK_BACKEND", &wanted);
            eprintln!(
                "[knox] {REPAIR_MARKER}: KNOX_GDK_BACKEND override honored (GDK_BACKEND={})",
                wanted.to_string_lossy()
            );
        } else {
            std::env::remove_var("GDK_BACKEND");
            eprintln!("[knox] {REPAIR_MARKER}: KNOX_GDK_BACKEND empty — GDK backend auto-detect restored");
        }
    } else if should_restore_wayland(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        allow_x11_opt_out(),
    ) {
        std::env::remove_var("GDK_BACKEND");
        eprintln!(
            "[knox] {REPAIR_MARKER}: removed AppImage-forced GDK_BACKEND=x11; native Wayland session detected, GTK backend auto-detect restored"
        );
    }

    if should_fallback_im_module(
        std::env::var("GDK_BACKEND").ok().as_deref(),
        std::env::var("GTK_IM_MODULE").ok().as_deref(),
        std::env::var("IBUS_ADDRESS").ok().as_deref(),
        std::env::var("XMODIFIERS").ok().as_deref(),
        &ibus_socket_exists,
    ) {
        std::env::set_var("GTK_IM_MODULE", "simple");
        eprintln!(
            "[knox] {FALLBACK_MARKER}: ibus IM requested but unreachable on X11 path; using built-in GTK_IM_MODULE=simple so keyboard input is delivered"
        );
    }
}

/// True when the user explicitly asked to keep the X11 backend.
fn allow_x11_opt_out() -> bool {
    match std::env::var("KNOX_ALLOW_X11") {
        Ok(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        Err(_) => false,
    }
}

/// Pure decision for repair step A. Returns true only for the exact
/// proven-broken shape: something forced the `x11` backend while the session
/// is Wayland-native and the user did not opt into X11. Pure (no env access)
/// so it is unit-testable.
fn should_restore_wayland(
    gdk_backend: Option<&str>,
    wayland_display: Option<&str>,
    session_type: Option<&str>,
    allow_x11: bool,
) -> bool {
    if allow_x11 {
        return false;
    }
    let forced_x11 = matches!(gdk_backend.map(str::trim), Some("x11"));
    if !forced_x11 {
        return false;
    }
    let wayland_socket = wayland_display.map(str::trim).is_some_and(|d| !d.is_empty());
    let wayland_session = session_type.map(str::trim).is_some_and(|s| s.eq_ignore_ascii_case("wayland"));
    wayland_socket || wayland_session
}

/// Extract the filesystem socket from an `IBUS_ADDRESS` value such as
/// `unix:path=/home/u/.cache/ibus/dbus-XXXX,guid=...`. Returns None when the
/// value is not a `unix:path=` address.
fn ibus_socket_from_address(addr: &str) -> Option<PathBuf> {
    for part in addr.split(',') {
        let part = part.trim();
        if let Some(path) = part.strip_prefix("unix:path=") {
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
        // `unix:abstract=` sockets have no filesystem entry to probe.
        if part.starts_with("unix:abstract=") {
            return None;
        }
    }
    None
}

fn ibus_socket_exists(addr: &str) -> bool {
    match ibus_socket_from_address(addr) {
        Some(p) => is_live_socket(&p),
        None => false,
    }
}

fn is_live_socket(p: &Path) -> bool {
    // A daemon socket is a Unix socket; accept any existing filesystem node
    // here (tests use regular files) — existence is the reachability signal.
    p.exists()
}

/// Whether GTK on this launch would route keys through ibus: an explicit
/// `GTK_IM_MODULE=ibus`, an empty/unset module together with
/// `XMODIFIERS=@im=ibus` (the X11 backend honors XMODIFIERS), or an
/// explicit empty module on the X11 path (GTK falls back to XMODIFIERS).
fn wants_ibus(gtk_im_module: Option<&str>, xmodifiers: Option<&str>) -> bool {
    match gtk_im_module.map(str::trim) {
        Some("ibus") => true,
        Some(other) if !other.is_empty() => false,
        _ => xmodifiers
            .map(|x| x.to_ascii_lowercase().contains("im=ibus"))
            .unwrap_or(false),
    }
}

/// Pure decision for repair step B. Falls back only when ALL hold:
/// still on the `x11` backend, ibus would handle keys, and no usable ibus
/// socket exists. `socket_ok` is injectable so tests never touch the fs.
fn should_fallback_im_module(
    gdk_backend: Option<&str>,
    gtk_im_module: Option<&str>,
    ibus_address: Option<&str>,
    xmodifiers: Option<&str>,
    socket_ok: &dyn Fn(&str) -> bool,
) -> bool {
    if !matches!(gdk_backend.map(str::trim), Some("x11")) {
        return false;
    }
    if !wants_ibus(gtk_im_module, xmodifiers) {
        return false;
    }
    match ibus_address.map(str::trim) {
        Some(addr) if !addr.is_empty() => !socket_ok(addr),
        _ => true, // no address at all: the X11 ibus client cannot connect
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_wayland_only_for_forced_x11_on_wayland() {
        // The exact AppImage failure shape.
        assert!(should_restore_wayland(Some("x11"), Some("wayland-0"), Some("wayland"), false));
        // WAYLAND_DISPLAY alone is enough (XDG_SESSION_TYPE sometimes unset).
        assert!(should_restore_wayland(Some("x11"), Some("wayland-0"), None, false));
        // Session type alone is enough (display var sometimes scrubbed).
        assert!(should_restore_wayland(Some("x11"), None, Some("wayland"), false));
        // User opt-out always wins.
        assert!(!should_restore_wayland(Some("x11"), Some("wayland-0"), Some("wayland"), true));
        // Non-forced backends are never touched.
        assert!(!should_restore_wayland(None, Some("wayland-0"), Some("wayland"), false));
        assert!(!should_restore_wayland(Some("wayland"), Some("wayland-0"), Some("wayland"), false));
        // Plain X11 session keeps working as before (no Wayland to restore).
        assert!(!should_restore_wayland(Some("x11"), None, Some("x11"), false));
        assert!(!should_restore_wayland(Some("x11"), None, None, false));
    }

    #[test]
    fn parses_ibus_socket_paths() {
        assert_eq!(
            ibus_socket_from_address("unix:path=/home/u/.cache/ibus/dbus-Ab12,guid=34"),
            Some(PathBuf::from("/home/u/.cache/ibus/dbus-Ab12"))
        );
        // Abstract sockets have no file to probe → unusable for us.
        assert_eq!(ibus_socket_from_address("unix:abstract=/tmp/dbus-Ab12,guid=34"), None);
        assert_eq!(ibus_socket_from_address(""), None);
        assert_eq!(ibus_socket_from_address("tcp:host=127.0.0.1,port=1234"), None);
    }

    #[test]
    fn detects_ibus_intent() {
        assert!(wants_ibus(Some("ibus"), None));
        assert!(wants_ibus(None, Some("@im=ibus")));
        assert!(wants_ibus(Some(""), Some("@im=ibus")));
        assert!(!wants_ibus(Some("simple"), Some("@im=ibus")));
        assert!(!wants_ibus(Some("wayland"), None));
        assert!(!wants_ibus(None, None));
        assert!(!wants_ibus(None, Some("")));
    }

    #[test]
    fn falls_back_only_when_x11_ibus_and_unreachable() {
        let down = |_: &str| false;
        let up = |_: &str| true;
        // Broken shape: XWayland + ibus intent + no address → fallback.
        assert!(should_fallback_im_module(Some("x11"), None, None, Some("@im=ibus"), &down));
        assert!(should_fallback_im_module(Some("x11"), Some("ibus"), None, None, &down));
        // Address set but socket gone → still broken → fallback.
        assert!(should_fallback_im_module(Some("x11"), Some("ibus"), Some("unix:path=/gone/dbus-X"), None, &down));
        // Reachable daemon → NEVER touch (CJK users keep ibus).
        assert!(!should_fallback_im_module(Some("x11"), Some("ibus"), Some("unix:path=/run/dbus-X"), None, &up));
        // Not on X11 (native Wayland after repair A) → never touch IM.
        assert!(!should_fallback_im_module(None, None, None, Some("@im=ibus"), &down));
        assert!(!should_fallback_im_module(Some("wayland"), Some("ibus"), None, None, &down));
        // X11 but no ibus intent (e.g. already simple/wayland) → untouched.
        assert!(!should_fallback_im_module(Some("x11"), Some("simple"), None, Some("@im=ibus"), &down));
        assert!(!should_fallback_im_module(Some("x11"), None, None, None, &down));
    }

    #[test]
    fn markers_are_stable_for_packaging_checks() {
        assert_eq!(REPAIR_MARKER, "knox-input-env-repair-v1");
        assert_eq!(FALLBACK_MARKER, "knox-im-fallback-v1");
    }
}
