//! knox-media plugin — renderer side of the platform media contract.
//!
//! Android: forwards now-playing snapshots to the Kotlin layer, which owns a
//! framework MediaSession + a `mediaPlayback` foreground service (the piece
//! that keeps audio alive when the app is backgrounded). Transport taps come
//! back as `knox-media-key` / `knox-open-player` frontend events.
//! Desktop / iOS / browser: every command degrades — sync/clear ack, state
//! queries answer `unknown`, flows that need an OS page reject with human
//! guidance the UI shows instead. Playback NEVER depends on this bridge.

use serde_json::Value;
use tauri::{plugin::{Builder, TauriPlugin}, AppHandle, Manager, Runtime};

#[cfg(mobile)]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.knox.music.knoxmedia";

pub struct KnoxMedia<R: Runtime> {
    #[cfg(not(mobile))]
    _marker: std::marker::PhantomData<fn() -> R>,
    #[cfg(mobile)]
    mobile_plugin_handle: PluginHandle<R>,
}

impl<R: Runtime> KnoxMedia<R> {
    #[cfg(mobile)]
    fn forward(&self, method: &str, payload: Value) -> Result<Value, String> {
        self.mobile_plugin_handle
            .run_mobile_plugin(method, payload)
            .map_err(|e| e.to_string())
    }
}

/// Extension trait (mirrors `OpenerExt`): resolves the managed handle.
pub trait KnoxMediaExt<R: Runtime> {
    fn knox_media(&self) -> &KnoxMedia<R>;
}

impl<R: Runtime> KnoxMediaExt<R> for AppHandle<R> {
    fn knox_media(&self) -> &KnoxMedia<R> {
        self.state::<KnoxMedia<R>>().inner()
    }
}

/// Push now-playing state to the native layer. Fire-and-forget from the
/// renderer's view — a native failure rejects THAT sync only.
#[tauri::command]
async fn sync<R: Runtime>(app: AppHandle<R>, snapshot: Value) -> Result<(), String> {
    #[cfg(mobile)]
    {
        app.knox_media().forward("sync", snapshot)?;
    }
    #[cfg(not(mobile))]
    {
        let _ = (&app, snapshot);
    }
    Ok(())
}

/// Native media health for the App-permissions diagnostic row: bridge
/// reachability, foreground-service state, sync freshness. Never throws —
/// an unreachable bridge resolves `{bridge:"unreachable"}` on mobile and
/// `{bridge:"unavailable"}` on desktop (never a fake healthy).
#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        match app.knox_media().forward("status", Value::Null) {
            Ok(v) => Ok(v),
            Err(_) => Ok(serde_json::json!({ "bridge": "unreachable" })),
        }
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(serde_json::json!({ "bridge": "unavailable" }))
    }
}

/// Clear any native now-playing state (boot + error paths).
#[tauri::command]
async fn clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(mobile)]
    {
        app.knox_media().forward("clear", Value::Null)?;
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
    }
    Ok(())
}

/// Real POST_NOTIFICATIONS state on Android; `{state:"unknown"}` elsewhere.
#[tauri::command]
async fn notification_state<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        app.knox_media().forward("notification_state", Value::Null)
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(serde_json::json!({ "state": "unknown" }))
    }
}

/// Fire the OS POST_NOTIFICATIONS runtime dialog (Android 13+; resolves the
/// state observed right after on Android, `unknown` elsewhere).
#[tauri::command]
async fn request_notification_permission<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        app.knox_media()
            .forward("request_notification_permission", Value::Null)
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Ok(serde_json::json!({ "state": "unknown" }))
    }
}

/// Open this app's OS settings page. Resolves true when the OS page
/// launched; rejects with human guidance the UI shows instead.
#[tauri::command]
async fn open_app_settings<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    #[cfg(mobile)]
    {
        let v = app.knox_media().forward("open_app_settings", Value::Null)?;
        Ok(v.get("value").and_then(|b| b.as_bool()).unwrap_or(true))
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err("Open Settings → Apps → KNOX Music to change permissions.".to_string())
    }
}

/// Android-only background-playback battery-exemption flow. Resolves true
/// when the OS dialog/flow launched; rejects with human guidance otherwise.
#[tauri::command]
async fn request_battery_exemption<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    #[cfg(mobile)]
    {
        let v = app
            .knox_media()
            .forward("request_battery_exemption", Value::Null)?;
        Ok(v.get("value").and_then(|b| b.as_bool()).unwrap_or(false))
    }
    #[cfg(not(mobile))]
    {
        let _ = app;
        Err("Open Settings → Apps → KNOX Music → Battery → Unrestricted to allow background playback.".to_string())
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("knox-media")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "KnoxMediaPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = &api;

            app.manage(KnoxMedia {
                #[cfg(not(mobile))]
                _marker: std::marker::PhantomData::<fn() -> R>,
                #[cfg(mobile)]
                mobile_plugin_handle: {
                    #[cfg(target_os = "android")]
                    {
                        handle
                    }
                    // iOS is not a KNOX target; this arm never compiles in
                    // practice (kept so the crate stays total on mobile).
                    #[cfg(not(target_os = "android"))]
                    {
                        unreachable!("knox-media ships no iOS binding")
                    }
                },
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sync,
            clear,
            status,
            notification_state,
            request_notification_permission,
            open_app_settings,
            request_battery_exemption,
        ])
        .build()
}
