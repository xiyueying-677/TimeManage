import * as store from "./store.js";
import { timer, onTick, onFinished, onCountdownDue, onFloatChanged } from "./timerClient.js";
import * as pomodoro from "./view-pomodoro.js";
import * as stats from "./view-stats.js";
import * as calendar from "./view-calendar.js";
import * as settings from "./view-settings.js";
import { showModal } from "./modal.js";
import { playChime } from "./audio.js";
import { invoke, isAndroid } from "./tauri.js";
import { initTimerNotificationActions } from "./notifications.js";

const views = { pomodoro, stats, calendar, settings };
let activeView = "pomodoro";
let floatVisible = { "pomodoro-float": false, "countdown-float": false };

function switchView(name) {
  activeView = name;
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${name}`);
  });
  views[name]?.refresh?.();
}

function readFloatVisibility() {
  const ui = store.getData()?.ui || {};
  floatVisible["pomodoro-float"] = !!ui.pomodoroFloat?.visible;
  floatVisible["countdown-float"] = !!ui.countdownFloat?.visible;
  updateFloatButtons();
}

function updateFloatButtons() {
  const pb = document.getElementById("floatPomodoroBtn");
  const cb = document.getElementById("floatCountdownBtn");
  if (pb) pb.textContent = floatVisible["pomodoro-float"] ? "收起番茄钟" : "悬挂番茄钟";
  if (cb) cb.textContent = floatVisible["countdown-float"] ? "收起倒计时" : "悬挂倒计时";
  calendar.setFloatVisible?.(floatVisible["countdown-float"]);
}

async function alertMain() {
  try {
    await invoke("set_main_on_top", { on: true });
    await invoke("show_main");
  } catch {
    /* ignore */
  }
}

async function unalertMain() {
  try {
    await invoke("set_main_on_top", { on: false });
  } catch {
    /* ignore */
  }
}

async function loadInitialData() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await store.loadData();
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) console.warn("首次数据加载失败，正在重试", err);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

async function boot() {
  await loadInitialData();

  pomodoro.mount(document.getElementById("view-pomodoro"));
  stats.mount(document.getElementById("view-stats"));
  calendar.mount(document.getElementById("view-calendar"));
  await settings.mount(document.getElementById("view-settings"));

  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });
  document.getElementById("floatPomodoroBtn").addEventListener("click", () => {
    invoke("toggle_float", { label: "pomodoro-float" }).catch(() => {});
  });
  document.getElementById("floatCountdownBtn").addEventListener("click", () => {
    invoke("toggle_float", { label: "countdown-float" }).catch(() => {});
  });

  store.subscribe(() => {
    readFloatVisibility();
    if (activeView !== "settings") views[activeView]?.refresh?.();
  });
  await store.initDataSync();
  readFloatVisibility();

  if (isAndroid) {
    initTimerNotificationActions((state) => pomodoro.applyState(state));
  }

  onTick((state) => pomodoro.applyState(state));
  onFinished((payload) => {
    if (!payload || payload.autoNext || payload.mode === "countup") return;
    if (isAndroid) {
      // 手机端没有 alert 窗口，直接在应用内弹窗（步骤3 会再补系统通知）
      pomodoro.onFinished(payload);
      return;
    }
    invoke("show_alert").catch(() => {});
  });
  onCountdownDue(async (list) => {
    if (isAndroid) {
      await handleCountdownDue(list);
      return;
    }
    await alertMain();
    try {
      await handleCountdownDue(list);
    } finally {
      await unalertMain();
    }
  });
  onFloatChanged(({ label, visible, x, y }) => {
    floatVisible[label] = !!visible;
    const ui = store.getData()?.ui;
    const key = label === "pomodoro-float" ? "pomodoroFloat" : "countdownFloat";
    if (ui && ui[key]) {
      ui[key].visible = !!visible;
      if (x !== null && x !== undefined) ui[key].x = x;
      if (y !== null && y !== undefined) ui[key].y = y;
    }
    updateFloatButtons();
  });

  try {
    pomodoro.applyState(await timer.state());
  } catch {
    /* ignore */
  }

  const pendingFloat = store.getData()?.ui;
  if (!isAndroid) {
    if (pendingFloat?.pomodoroFloat?.visible) {
      invoke("set_float_visible", { label: "pomodoro-float", visible: true }).catch(() => {});
    }
    if (pendingFloat?.countdownFloat?.visible) {
      invoke("set_float_visible", { label: "countdown-float", visible: true }).catch(() => {});
    }
  }
}

async function handleCountdownDue(list) {
  if (!list || !list.length) return;
  const s = store.getData()?.settings || {};
  if (s.soundEnabled !== false) playChime("countdown", s.soundVolume ?? 0.5);
  const lines = list.map((c) => `「${c.title}」`).join("、");
  await showModal({
    title: "倒计时提醒",
    message: `${lines} 快到啦，记得提前准备哦～`,
    icon: "🔔",
    actions: [{ label: "知道啦", value: true }],
  });
}

function showBootError(err) {
  console.error("BOOT_FAILED", err);
  const content = document.querySelector(".content");
  if (!content) return;
  const card = document.createElement("div");
  card.className = "card";
  card.style.cssText = "margin:24px;padding:24px;max-width:720px";
  const title = document.createElement("h3");
  title.textContent = "应用启动失败";
  const detail = document.createElement("pre");
  detail.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:12px";
  detail.textContent = String(err?.stack || err?.message || err);
  card.append(title, detail);
  content.replaceChildren(card);
}

boot().catch(showBootError);
