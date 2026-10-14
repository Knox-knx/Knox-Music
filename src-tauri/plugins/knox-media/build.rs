const COMMANDS: &[&str] = &[
    "sync",
    "clear",
    "status",
    "notification_state",
    "request_notification_permission",
    "open_app_settings",
    "request_battery_exemption",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build()
        .expect("failed to build knox-media plugin");

    // `cfg(mobile)` alias (mirrors tauri-plugin-opener): true when the
    // target is Android or iOS so `#[cfg(mobile)]` gates JNI-only paths.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let mobile = target_os == "ios" || target_os == "android";
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    if mobile {
        println!("cargo:rustc-cfg=mobile");
    }
}
