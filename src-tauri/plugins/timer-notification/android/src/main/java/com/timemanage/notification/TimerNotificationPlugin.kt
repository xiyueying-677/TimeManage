package com.timemanage.notification

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class TimerArgs {
  var title: String? = null
  var text: String? = null
  var mode: String? = null
  var endAt: Long = 0
  var elapsedSeconds: Long = 0
  var paused: Boolean = false
  var remainingSeconds: Long = 0
  var soundEnabled: Boolean = true
}

@InvokeArg
class FinishedArgs {
  var title: String? = null
  var text: String? = null
  var soundEnabled: Boolean = true
}

@TauriPlugin
class TimerNotificationPlugin(private val appActivity: Activity) : Plugin(appActivity) {
  companion object {
    @Volatile
    var instance: TimerNotificationPlugin? = null

    private const val NOTIFICATION_PERMISSION_REQUEST = 7401
  }

  init {
    instance = this
    TimerService.ensureChannels(appActivity)
  }

  override fun load(webView: WebView) {
    instance = this
    TimerService.ensureChannels(appActivity)
  }

  @Command
  fun start(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TimerArgs::class.java)
      requestNotificationPermission()
      TimerService.start(appActivity, args)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to start timer notification")
    }
  }

  @Command
  fun update(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TimerArgs::class.java)
      TimerService.update(appActivity, args)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to update timer notification")
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    try {
      TimerService.stop(appActivity)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to stop timer notification")
    }
  }

  @Command
  fun finished(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(FinishedArgs::class.java)
      TimerService.showFinished(
        appActivity,
        args.title ?: "时间到啦",
        args.text ?: "",
        args.soundEnabled,
        fromAlarm = false,
      )
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "failed to show finish notification")
    }
  }

  @Command
  fun requestPermission(invoke: Invoke) {
    requestNotificationPermission()
    invoke.resolve()
  }

  private fun requestNotificationPermission() {
    if (android.os.Build.VERSION.SDK_INT < 33) return
    val granted = ContextCompat.checkSelfPermission(
      appActivity,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) return
    appActivity.runOnUiThread {
      appActivity.requestPermissions(
        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
        NOTIFICATION_PERMISSION_REQUEST,
      )
    }
  }

  /** Called by [TimerActionReceiver] when one of the notification buttons is tapped. */
  fun onTimerAction(action: String) {
    val payload = JSObject()
    payload.put("action", action)
    trigger("timer-action", payload)
  }
}
