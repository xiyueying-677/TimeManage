package com.timemanage.notification

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

class TimerService : Service() {
  companion object {
    const val CHANNEL_ONGOING = "timemanage_timer_ongoing"
    const val CHANNEL_END = "timemanage_timer_end"
    const val NOTIF_ONGOING = 7401
    const val NOTIF_END = 7402

    const val ACTION_PAUSE = "com.timemanage.notification.PAUSE"
    const val ACTION_RESUME = "com.timemanage.notification.RESUME"
    const val ACTION_STOP = "com.timemanage.notification.STOP"
    const val ACTION_END = "com.timemanage.notification.END"

    private const val PREFS = "timemanage_timer_notification"
    private const val KEY_TITLE = "title"
    private const val KEY_TEXT = "text"
    private const val KEY_SOUND = "sound"
    private const val KEY_LAST_FINISHED = "last_finished_at"

    // Service extras
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_TEXT = "text"
    private const val EXTRA_MODE = "mode"
    private const val EXTRA_END_AT = "endAt"
    private const val EXTRA_ELAPSED = "elapsedSeconds"
    private const val EXTRA_PAUSED = "paused"
    private const val EXTRA_REMAINING = "remainingSeconds"
    private const val EXTRA_SOUND = "soundEnabled"

    @Volatile
    var isRunning = false

    fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return

      val ongoing = NotificationChannel(
        CHANNEL_ONGOING,
        "计时进行中",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "番茄钟/倒计时进行中的常驻通知"
        setShowBadge(false)
      }
      val end = NotificationChannel(
        CHANNEL_END,
        "计时结束提醒",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "计时结束时的响铃与震动提醒"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 220, 120, 220)
        setShowBadge(true)
      }
      manager.createNotificationChannel(ongoing)
      manager.createNotificationChannel(end)
    }

    fun start(context: Context, args: TimerArgs) = deliver(context, args)

    fun update(context: Context, args: TimerArgs) = deliver(context, args)

    private fun deliver(context: Context, args: TimerArgs) {
      ensureChannels(context)
      val intent = Intent(context, TimerService::class.java).apply {
        putExtra(EXTRA_TITLE, args.title ?: "计时中")
        putExtra(EXTRA_TEXT, args.text ?: "")
        putExtra(EXTRA_MODE, args.mode ?: "countdown")
        putExtra(EXTRA_END_AT, args.endAt)
        putExtra(EXTRA_ELAPSED, args.elapsedSeconds)
        putExtra(EXTRA_PAUSED, args.paused)
        putExtra(EXTRA_REMAINING, args.remainingSeconds)
        putExtra(EXTRA_SOUND, args.soundEnabled)
      }
      try {
        if (isRunning) {
          context.startService(intent)
        } else {
          ContextCompat.startForegroundService(context, intent)
        }
      } catch (ex: Exception) {
        // Android 12+ 不允许后台启动前台服务时静默失败，Rust 侧仍有计时状态与快照。
        android.util.Log.w("TimerService", "failed to start/update foreground service", ex)
      }
    }

    fun stop(context: Context) {
      cancelAlarm(context)
      NotificationManagerCompat.from(context).cancel(NOTIF_ONGOING)
      context.stopService(Intent(context, TimerService::class.java))
      isRunning = false
    }

    fun showFinished(
      context: Context,
      title: String,
      text: String,
      soundEnabled: Boolean,
      fromAlarm: Boolean,
    ) {
      ensureChannels(context)
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (fromAlarm) {
        val last = prefs.getLong(KEY_LAST_FINISHED, 0L)
        if (System.currentTimeMillis() - last < 3000L) {
          context.stopService(Intent(context, TimerService::class.java))
          return
        }
      }
      prefs.edit()
        .putLong(KEY_LAST_FINISHED, System.currentTimeMillis())
        .putString(KEY_TITLE, title)
        .putString(KEY_TEXT, text)
        .putBoolean(KEY_SOUND, soundEnabled)
        .apply()

      val builder = NotificationCompat.Builder(context, CHANNEL_END)
        .setSmallIcon(R.drawable.ic_stat_timer)
        .setContentTitle(title)
        .setContentText(text)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setContentIntent(openAppIntent(context))

      if (soundEnabled) {
        builder.setDefaults(
          NotificationCompat.DEFAULT_SOUND or
            NotificationCompat.DEFAULT_VIBRATE or
            NotificationCompat.DEFAULT_LIGHTS,
        )
      } else {
        builder.setSilent(true)
      }

      NotificationManagerCompat.from(context).notify(NOTIF_END, builder.build())
      cancelAlarm(context)
      NotificationManagerCompat.from(context).cancel(NOTIF_ONGOING)
      context.stopService(Intent(context, TimerService::class.java))
      isRunning = false
    }

    fun showFinishedFromAlarm(context: Context) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val title = prefs.getString(KEY_TITLE, "时间到啦") ?: "时间到啦"
      val text = prefs.getString(KEY_TEXT, "") ?: ""
      val sound = prefs.getBoolean(KEY_SOUND, true)
      showFinished(context, title, text, sound, fromAlarm = true)
    }

    private fun openAppIntent(context: Context): PendingIntent? {
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      launch.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      return PendingIntent.getActivity(
        context,
        0,
        launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun actionIntent(context: Context, action: String, requestCode: Int): PendingIntent {
      val intent = Intent(context, TimerActionReceiver::class.java).setAction(action)
      return PendingIntent.getBroadcast(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun scheduleEnd(context: Context, args: TimerArgs) {
      if (args.paused || args.mode != "countdown" || args.endAt <= System.currentTimeMillis()) {
        cancelAlarm(context)
        return
      }
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      prefs.edit()
        .putString(KEY_TITLE, args.title ?: "时间到啦")
        .putString(KEY_TEXT, args.text ?: "")
        .putBoolean(KEY_SOUND, args.soundEnabled)
        .apply()

      val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
      val pending = PendingIntent.getBroadcast(
        context,
        7403,
        Intent(context, TimerActionReceiver::class.java).setAction(ACTION_END),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      try {
        alarmManager.setAndAllowWhileIdle(
          AlarmManager.RTC_WAKEUP,
          args.endAt,
          pending,
        )
      } catch (ex: Exception) {
        android.util.Log.w("TimerService", "failed to schedule end alarm", ex)
      }
    }

    private fun cancelAlarm(context: Context) {
      val alarmManager = context.getSystemService(AlarmManager::class.java) ?: return
      val pending = PendingIntent.getBroadcast(
        context,
        7403,
        Intent(context, TimerActionReceiver::class.java).setAction(ACTION_END),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      alarmManager.cancel(pending)
    }

    private fun formatSeconds(total: Long): String {
      val seconds = if (total < 0) 0 else total
      val h = seconds / 3600
      val m = (seconds % 3600) / 60
      val s = seconds % 60
      return if (h > 0) {
        String.format("%d:%02d:%02d", h, m, s)
      } else {
        String.format("%02d:%02d", m, s)
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private var currentArgs: TimerArgs? = null
  private var countupBaseMs: Long = 0L
  private val handler = Handler(Looper.getMainLooper())

  private val ticker = object : Runnable {
    override fun run() {
      val args = currentArgs ?: return
      if (args.paused) return
      NotificationManagerCompat.from(this@TimerService).notify(
        NOTIF_ONGOING,
        buildOngoingNotification(args, dynamicText(args)),
      )
      handler.postDelayed(this, 1000)
    }
  }

  private fun stopTicker() {
    handler.removeCallbacks(ticker)
  }

  private fun startTicker() {
    stopTicker()
    handler.post(ticker)
  }

  private fun formatRemainingText(args: TimerArgs): String {
    return if (args.mode == "countup") {
      val elapsed = ((System.currentTimeMillis() - countupBaseMs) / 1000).coerceAtLeast(0)
      "已计时 ${formatSeconds(elapsed)}"
    } else {
      val remaining = ((args.endAt - System.currentTimeMillis() + 999) / 1000).coerceAtLeast(0)
      "剩余 ${formatSeconds(remaining)}"
    }
  }

  private fun dynamicText(args: TimerArgs): String {
    if (args.paused) {
      return if (args.mode == "countup") {
        "已暂停 · 已计时 ${formatSeconds(args.remainingSeconds)}"
      } else {
        "已暂停 · 剩余 ${formatSeconds(args.remainingSeconds)}"
      }
    }
    val detail = formatRemainingText(args)
    val prefix = args.text?.takeIf { it.isNotBlank() }
    return if (prefix == null) detail else "$prefix · $detail"
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      stopSelf()
      return START_NOT_STICKY
    }

    val args = TimerArgs().apply {
      title = intent.getStringExtra(EXTRA_TITLE) ?: "计时中"
      text = intent.getStringExtra(EXTRA_TEXT) ?: ""
      mode = intent.getStringExtra(EXTRA_MODE) ?: "countdown"
      endAt = intent.getLongExtra(EXTRA_END_AT, 0L)
      elapsedSeconds = intent.getLongExtra(EXTRA_ELAPSED, 0L)
      paused = intent.getBooleanExtra(EXTRA_PAUSED, false)
      remainingSeconds = intent.getLongExtra(EXTRA_REMAINING, 0L)
      soundEnabled = intent.getBooleanExtra(EXTRA_SOUND, true)
    }
    currentArgs = args
    countupBaseMs = System.currentTimeMillis() - args.elapsedSeconds.coerceAtLeast(0L) * 1000L

    ensureChannels(this)
    val notification = buildOngoingNotification(args, dynamicText(args))

    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(
        NOTIF_ONGOING,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
    } else {
      startForeground(NOTIF_ONGOING, notification)
    }
    isRunning = true

    if (!args.paused && args.mode == "countdown") {
      scheduleEnd(this, args)
    } else {
      cancelAlarm(this)
    }

    if (args.paused) {
      stopTicker()
    } else {
      startTicker()
    }

    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopTicker()
    currentArgs = null
    isRunning = false
    super.onDestroy()
  }

  private fun buildOngoingNotification(
    args: TimerArgs,
    displayText: String? = null,
  ): Notification {
    val contentTitle = args.title?.takeIf { it.isNotBlank() } ?: "计时中"
    val contentText = displayText ?: dynamicText(args)

    val builder = NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setSmallIcon(R.drawable.ic_stat_timer)
      .setContentTitle(contentTitle)
      .setContentText(contentText)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(Notification.CATEGORY_STOPWATCH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setSilent(true)
      .setContentIntent(openAppIntent(this))

    if (args.paused) {
      builder.addAction(
        0,
        "继续",
        actionIntent(this, ACTION_RESUME, 7404),
      )
    } else {
      builder.addAction(
        0,
        "暂停",
        actionIntent(this, ACTION_PAUSE, 7405),
      )
    }
    builder.addAction(
      0,
      "停止",
      actionIntent(this, ACTION_STOP, 7406),
    )

    return builder.build()
  }

  private fun formatSeconds(total: Long): String {
    val seconds = if (total < 0) 0 else total
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) {
      String.format("%d:%02d:%02d", h, m, s)
    } else {
      String.format("%02d:%02d", m, s)
    }
  }
}
