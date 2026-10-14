package com.knox.music

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var knoxWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    knoxWebView = webView
    try {
      webView.settings.mediaPlaybackRequiresUserGesture = false
    } catch (_: Exception) {
    }
  }

  override fun onResume() {
    super.onResume()
    try {
      knoxWebView?.onResume()
      knoxWebView?.resumeTimers()
      knoxWebView?.evaluateJavascript(
        "(function(){try{window.dispatchEvent(new CustomEvent('knox:activity-resumed'));}catch(e){}})();",
        null
      )
    } catch (_: Exception) {
    }
  }

  override fun onPause() {
    super.onPause()
    try {
      knoxWebView?.onResume()
      knoxWebView?.resumeTimers()
    } catch (_: Exception) {
    }
  }

  override fun onStop() {
    super.onStop()
    try {
      knoxWebView?.onResume()
      knoxWebView?.resumeTimers()
    } catch (_: Exception) {
    }
  }

  override fun onDestroy() {
    knoxWebView = null
    super.onDestroy()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    try {
      knoxWebView?.onResume()
      knoxWebView?.resumeTimers()
    } catch (_: Exception) {
    }
  }

  override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
    if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP ||
        keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN ||
        keyCode == android.view.KeyEvent.KEYCODE_VOLUME_MUTE) {
      return super.onKeyDown(keyCode, event)
    }
    return super.onKeyDown(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: android.view.KeyEvent?): Boolean {
    if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP ||
        keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN ||
        keyCode == android.view.KeyEvent.KEYCODE_VOLUME_MUTE) {
      return super.onKeyUp(keyCode, event)
    }
    return super.onKeyUp(keyCode, event)
  }
}
