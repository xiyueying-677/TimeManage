package com.timemanage.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class TimerActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      TimerService.ACTION_PAUSE -> TimerNotificationPlugin.instance?.onTimerAction("pause")
      TimerService.ACTION_RESUME -> TimerNotificationPlugin.instance?.onTimerAction("resume")
      TimerService.ACTION_STOP -> TimerNotificationPlugin.instance?.onTimerAction("stop")
      TimerService.ACTION_END -> TimerService.showFinishedFromAlarm(context)
    }
  }
}
