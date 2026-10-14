package com.knox.music.knoxmedia

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/**
 * Foreground playback service — the piece that keeps audio alive when the
 * app leaves the foreground.
 *
 * The renderer (WebView audio element) owns decoding and the queue; this
 * service only (a) holds process priority via startForeground with
 * `mediaPlayback` type, (b) holds a partial wake lock so the CPU never naps
 * mid-track, and (c) publishes a framework MediaSession + MediaStyle
 * notification so lock-screen / headset / notification taps pause, resume,
 * and skip. Transport taps are forwarded to [transportListener] (the Tauri
 * plugin emits them as `knox-media-key` frontend events); the renderer then
 * pushes a fresh snapshot back here. No audio bytes ever pass through this
 * service and no state here is authoritative.
 */
class MusicPlaybackService : Service() {
  companion object {
    private const val CHANNEL_ID = "knox_playback"
    private const val NOTIF_ID = 1001
    private const val EXTRA_KIND = "kind"
    private const val KIND_SYNC = "sync"
    private const val KIND_CLEAR = "clear"
    const val ACTION_TOGGLE = "com.knox.music.knoxmedia.TOGGLE"
    const val ACTION_PLAY = "com.knox.music.knoxmedia.PLAY"
    const val ACTION_PAUSE = "com.knox.music.knoxmedia.PAUSE"
    const val ACTION_NEXT = "com.knox.music.knoxmedia.NEXT"
    const val ACTION_PREV = "com.knox.music.knoxmedia.PREV"
    const val ACTION_STOP = "com.knox.music.knoxmedia.STOP"

    /** Transport tap sink (set by the plugin). Never load-bearing. */
    @Volatile
    var transportListener: ((String) -> Unit)? = null

    @Volatile
    var serviceRunning = false

    @Volatile
    var instance: MusicPlaybackService? = null

    @Volatile
    var syncCount = 0L

    @Volatile
    var lastSyncAt = 0L

    @Volatile
    var lastError: String? = null

    fun sync(ctx: Context, args: SyncArgs) {
      syncCount += 1
      lastSyncAt = System.currentTimeMillis()
      lastError = null

      val currentInstance = instance
      if (currentInstance != null && serviceRunning) {
        // Service is already running! Update directly in-memory without startForegroundService calls
        // from background which get refused on Android 12+ / 14+.
        currentInstance.postUpdate(args)
        return
      }

      // If nothing is playing and service is not running, don't start
      if (!args.playing) {
        return
      }

      val intent = Intent(ctx, MusicPlaybackService::class.java).apply {
        putExtra(EXTRA_KIND, KIND_SYNC)
        putExtra("title", args.title)
        putExtra("artist", args.artist)
        putExtra("album", args.album)
        putExtra("playing", args.playing)
        putExtra("live", args.live)
        putExtra("canNext", args.canNext)
        putExtra("canPrev", args.canPrev)
        putExtra("hasDuration", args.durationSec != null)
        putExtra("durationSec", (args.durationSec ?: 0.0).toFloat())
        putExtra("positionSec", (args.positionSec ?: 0.0).toFloat())
        putExtra("rate", (args.rate ?: 1.0).toFloat())
      }

      try {
        if (Build.VERSION.SDK_INT >= 26) {
          ctx.startForegroundService(intent)
        } else {
          ctx.startService(intent)
        }
      } catch (ex: Exception) {
        lastError = ex.message ?: "start refused"
      }
    }

    fun clear(ctx: Context) {
      try {
        instance?.let {
          it.stopForeground(true)
          it.stopSelf()
        }
        ctx.stopService(Intent(ctx, MusicPlaybackService::class.java))
      } catch (_: Exception) {
      }
    }

    fun notificationsEnabled(ctx: Context): Boolean {
      return try {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.areNotificationsEnabled()
      } catch (_: Exception) {
        true
      }
    }
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private var session: MediaSession? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    serviceRunning = true

    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KNOXMusic:playback")
      wakeLock?.setReferenceCounted(false)
      wakeLock?.acquire()
    } catch (_: Exception) {
    }

    ensureNotificationChannel()

    try {
      val s = MediaSession(this, "KNOXMusic")
      s.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS)
      s.setCallback(object : MediaSession.Callback() {
        override fun onPlay() {
          emitTransport("play")
        }

        override fun onPause() {
          emitTransport("pause")
        }

        override fun onSkipToNext() {
          emitTransport("next")
        }

        override fun onSkipToPrevious() {
          emitTransport("prev")
        }

        override fun onStop() {
          emitTransport("stop")
        }

        override fun onSeekTo(pos: Long) {
          emitTransport("seek:${pos / 1000f}")
        }

        override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
          try {
            val keyEvent = if (Build.VERSION.SDK_INT >= 33) {
              mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, android.view.KeyEvent::class.java)
            } else {
              @Suppress("DEPRECATION")
              mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
            }
            if (keyEvent != null) {
              val code = keyEvent.keyCode
              if (code == android.view.KeyEvent.KEYCODE_VOLUME_UP ||
                  code == android.view.KeyEvent.KEYCODE_VOLUME_DOWN ||
                  code == android.view.KeyEvent.KEYCODE_VOLUME_MUTE) {
                // Ignore volume buttons completely so system handles volume and music never pauses
                return false
              }
            }
          } catch (_: Exception) {
          }
          return super.onMediaButtonEvent(mediaButtonIntent)
        }
      })
      s.isActive = true
      session = s
    } catch (_: Exception) {
      session = null
    }
  }

  private fun ensureNotificationChannel() {
    try {
      if (Build.VERSION.SDK_INT >= 26) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
          val channel = NotificationChannel(CHANNEL_ID, "Now playing", NotificationManager.IMPORTANCE_LOW).apply {
            description = "KNOX Music playback controls"
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
          }
          nm.createNotificationChannel(channel)
        }
      }
    } catch (_: Exception) {
    }
  }

  private fun emitTransport(action: String) {
    try {
      transportListener?.invoke(action)
    } catch (_: Exception) {
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      val kind = intent?.getStringExtra(EXTRA_KIND)
      if (kind == KIND_CLEAR) {
        stopForeground(true)
        stopSelf()
        return START_NOT_STICKY
      }
      when (intent?.action) {
        ACTION_PLAY -> {
          emitTransport("play")
          return START_STICKY
        }
        ACTION_PAUSE -> {
          emitTransport("pause")
          return START_STICKY
        }
        ACTION_TOGGLE -> {
          emitTransport("toggle")
          return START_STICKY
        }
        ACTION_NEXT -> {
          emitTransport("next")
          return START_STICKY
        }
        ACTION_PREV -> {
          emitTransport("prev")
          return START_STICKY
        }
        ACTION_STOP -> {
          emitTransport("stop")
          return START_STICKY
        }
      }
      if (kind == KIND_SYNC) {
        publishFromIntent(intent)
      }
    } catch (_: Exception) {
    }
    return START_STICKY
  }

  fun postUpdate(args: SyncArgs) {
    mainHandler.post {
      try {
        updateFromArgs(args)
      } catch (e: Exception) {
        lastError = "update failed: ${e.message}"
      }
    }
  }

  private fun updateFromArgs(args: SyncArgs) {
    updateSession(
      title = args.title,
      artist = args.artist,
      album = args.album,
      playing = args.playing,
      live = args.live,
      canNext = args.canNext,
      canPrev = args.canPrev,
      hasDuration = args.durationSec != null,
      durationSec = (args.durationSec ?: 0.0).toFloat(),
      positionSec = (args.positionSec ?: 0.0).toFloat(),
      rate = (args.rate ?: 1.0).toFloat(),
    )

    val notif = buildNotification(
      title = args.title,
      artist = args.artist,
      playing = args.playing,
      live = args.live,
      canNext = args.canNext,
      canPrev = args.canPrev,
    ) ?: return

    try {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      nm?.notify(NOTIF_ID, notif)
    } catch (e: Exception) {
      lastError = "notify failed: ${e.message}"
    }
  }

  private fun publishFromIntent(intent: Intent?) {
    val title = intent?.getStringExtra("title").orEmpty().ifEmpty { "KNOX Music" }
    val artist = intent?.getStringExtra("artist").orEmpty()
    val album = intent?.getStringExtra("album").orEmpty()
    val playing = intent?.getBooleanExtra("playing", false) ?: false
    val live = intent?.getBooleanExtra("live", false) ?: false
    val canNext = intent?.getBooleanExtra("canNext", false) ?: false
    val canPrev = intent?.getBooleanExtra("canPrev", false) ?: false
    val hasDuration = intent?.getBooleanExtra("hasDuration", false) ?: false
    val durationSec = intent?.getFloatExtra("durationSec", 0f) ?: 0f
    val positionSec = intent?.getFloatExtra("positionSec", 0f) ?: 0f
    val rate = intent?.getFloatExtra("rate", 1f)?.takeIf { it > 0f } ?: 1f

    updateSession(title, artist, album, playing, live, canNext, canPrev, hasDuration, durationSec, positionSec, rate)

    val notif = buildNotification(title, artist, playing, live, canNext, canPrev) ?: return

    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIF_ID, notif)
      }
    } catch (ex: Exception) {
      lastError = "startForeground failed: ${ex.message}"
      try {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        nm?.notify(NOTIF_ID, notif)
      } catch (_: Exception) {
      }
    }
  }

  private fun updateSession(
    title: String,
    artist: String,
    album: String,
    playing: Boolean,
    live: Boolean,
    canNext: Boolean,
    canPrev: Boolean,
    hasDuration: Boolean,
    durationSec: Float,
    positionSec: Float,
    rate: Float,
  ) {
    try {
      session?.setMetadata(
        MediaMetadata.Builder()
          .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifEmpty { "KNOX Music" })
          .putString(MediaMetadata.METADATA_KEY_ARTIST, if (live) "Live" else artist)
          .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
          .apply { if (hasDuration && durationSec > 0f) putLong(MediaMetadata.METADATA_KEY_DURATION, (durationSec * 1000).toLong()) }
          .build(),
      )
      val state = if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
      val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_STOP or
        (if (canNext) PlaybackState.ACTION_SKIP_TO_NEXT else 0L) or
        (if (canPrev) PlaybackState.ACTION_SKIP_TO_PREVIOUS else 0L) or
        (if (hasDuration && durationSec > 0f) PlaybackState.ACTION_SEEK_TO else 0L)
      val pb = PlaybackState.Builder()
        .setActions(actions)
        .setState(state, (positionSec * 1000).toLong(), if (rate > 0f) rate else 1f)
      session?.setPlaybackState(pb.build())
    } catch (_: Exception) {
    }
  }

  private fun buildNotification(
    title: String,
    artist: String,
    playing: Boolean,
    live: Boolean,
    canNext: Boolean,
    canPrev: Boolean,
  ): Notification? {
    ensureNotificationChannel()

    val actions = mutableListOf<Notification.Action>()
    if (canPrev) actions.add(action(ACTION_PREV, "Previous", android.R.drawable.ic_media_previous))
    actions.add(
      if (playing) action(ACTION_PAUSE, "Pause", android.R.drawable.ic_media_pause)
      else action(ACTION_PLAY, "Play", android.R.drawable.ic_media_play),
    )
    if (canNext) actions.add(action(ACTION_NEXT, "Next", android.R.drawable.ic_media_next))

    val contentIntent = try {
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    } catch (_: Exception) {
      null
    }

    val appIcon = applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.sym_def_app_icon

    val builder = if (Build.VERSION.SDK_INT >= 26) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    builder
      .setContentTitle(title.ifEmpty { "KNOX Music" })
      .setContentText(if (live) "Live" else artist)
      .setSmallIcon(appIcon)
      .setContentIntent(contentIntent)
      .setOngoing(playing)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setStyle(
        Notification.MediaStyle()
          .setMediaSession(session?.sessionToken)
          .setShowActionsInCompactView(*actions.indices.take(3).toIntArray()),
      )

    for (a in actions) builder.addAction(a)

    return try {
      builder.build()
    } catch (e: Exception) {
      lastError = "build error: ${e.message}"
      null
    }
  }

  private fun action(intentAction: String, label: String, iconRes: Int): Notification.Action {
    val intent = Intent(this, MusicPlaybackService::class.java).setAction(intentAction)
    val pi = PendingIntent.getService(this, intentAction.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    return if (Build.VERSION.SDK_INT >= 23) {
      val icon = android.graphics.drawable.Icon.createWithResource("android", iconRes)
      Notification.Action.Builder(icon, label, pi).build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Action.Builder(iconRes, label, pi).build()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    serviceRunning = false
    instance = null
    try {
      session?.isActive = false
      session?.release()
    } catch (_: Exception) {
    }
    session = null
    try {
      wakeLock?.let { if (it.isHeld) it.release() }
    } catch (_: Exception) {
    }
    wakeLock = null
    super.onDestroy()
  }
}
