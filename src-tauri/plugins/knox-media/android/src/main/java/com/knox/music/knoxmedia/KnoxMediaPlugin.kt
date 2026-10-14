package com.knox.music.knoxmedia

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SyncArgs {
  var trackId: String = ""
  var title: String = ""
  var artist: String = ""
  var album: String = ""
  var artwork: String? = null
  var durationSec: Double? = null
  var positionSec: Double? = null
  var rate: Double? = null
  var playing: Boolean = false
  var live: Boolean = false
  var canNext: Boolean = false
  var canPrev: Boolean = false
}

@TauriPlugin
class KnoxMediaPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile
    var webView: WebView? = null

    fun dispatchMediaKey(action: String) {
      val wv = webView ?: return
      wv.post {
        try {
          wv.onResume()
          wv.resumeTimers()
          val js = """
            (function() {
              try {
                if (typeof window.__knoxMediaKey === 'function') {
                  window.__knoxMediaKey('$action');
                } else {
                  window.dispatchEvent(new CustomEvent('knox-media-key', { detail: { action: '$action' } }));
                }
              } catch (e) {
                console.error('Failed to dispatch knox-media-key', e);
              }
            })();
          """.trimIndent()
          wv.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
      }
    }
  }

  override fun load(webView: WebView) {
    Companion.webView = webView
    try {
      webView.settings.mediaPlaybackRequiresUserGesture = false
    } catch (_: Exception) {
    }
  }

  init {
    MusicPlaybackService.transportListener = { action ->
      try {
        dispatchMediaKey(action)
      } catch (_: Exception) {
      }
    }
  }

  @Command
  fun sync(invoke: Invoke) {
    try {
      val args = try {
        invoke.parseArgs(SyncArgs::class.java)
      } catch (_: Exception) {
        val json = invoke.getArgs()
        SyncArgs().apply {
          trackId = json.optString("trackId", "")
          title = json.optString("title", "")
          artist = json.optString("artist", "")
          album = json.optString("album", "")
          artwork = if (json.has("artwork") && !json.isNull("artwork")) json.getString("artwork") else null
          durationSec = if (json.has("durationSec") && !json.isNull("durationSec")) json.getDouble("durationSec") else null
          positionSec = if (json.has("positionSec") && !json.isNull("positionSec")) json.getDouble("positionSec") else null
          rate = if (json.has("rate") && !json.isNull("rate")) json.getDouble("rate") else null
          playing = json.optBoolean("playing", false)
          live = json.optBoolean("live", false)
          canNext = json.optBoolean("canNext", false)
          canPrev = json.optBoolean("canPrev", false)
        }
      }
      MusicPlaybackService.sync(activity, args)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun status(invoke: Invoke) {
    try {
      val ret = JSObject()
      ret.put("bridge", "ok")
      ret.put("serviceRunning", MusicPlaybackService.serviceRunning)
      ret.put("syncCount", MusicPlaybackService.syncCount)
      val last = MusicPlaybackService.lastSyncAt
      ret.put("lastSyncAgoMs", if (last == 0L) -1 else System.currentTimeMillis() - last)
      ret.put("lastError", MusicPlaybackService.lastError)
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun clear(invoke: Invoke) {
    try {
      MusicPlaybackService.clear(activity)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun notification_state(invoke: Invoke) {
    try {
      val ret = JSObject()
      ret.put("state", if (MusicPlaybackService.notificationsEnabled(activity)) "granted" else "denied")
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun request_notification_permission(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1001)
      }
      // The dialog is async; the UI re-queries state on resume.
      val ret = JSObject()
      ret.put("state", "unknown")
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun open_app_settings(invoke: Invoke) {
    try {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      intent.data = Uri.parse("package:${activity.packageName}")
      intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
      activity.startActivity(intent)
      val ret = JSObject()
      ret.put("value", true)
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  @Command
  fun request_battery_exemption(invoke: Invoke) {
    try {
      val pm = activity.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
      if (pm.isIgnoringBatteryOptimizations(activity.packageName)) {
        val ret = JSObject()
        ret.put("value", true)
        invoke.resolve(ret)
        return
      }
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
      intent.data = Uri.parse("package:${activity.packageName}")
      intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK
      activity.startActivity(intent)
      val ret = JSObject()
      ret.put("value", true)
      invoke.resolve(ret)
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
