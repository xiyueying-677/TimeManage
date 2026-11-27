import { timer } from "./timerClient.js";
import { isAndroid } from "./tauri.js";

// Android 通知栏动作 → JS 事件 → 调 Rust 计时命令；Rust 更新状态后再刷新通知。
export async function initTimerNotificationActions(onState) {
  if (!isAndroid) return null;
  const core = window.__TAURI__?.core;
  if (!core?.addPluginListener) return null;
  try {
    return await core.addPluginListener("timer-notification", "timer-action", async (payload) => {
      const action = payload?.action || payload?.payload?.action;
      if (action !== "pause" && action !== "resume" && action !== "stop") return;
      try {
        let state;
        if (action === "pause") state = await timer.pause();
        else if (action === "resume") state = await timer.resume();
        else state = await timer.stop();
        if (state) onState?.(state);
      } catch (err) {
        console.warn("timer notification action failed", err);
      }
    });
  } catch (err) {
    console.warn("timer notification listener failed", err);
    return null;
  }
}
