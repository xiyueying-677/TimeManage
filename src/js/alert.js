import * as store from "./store.js";
import { timer, onFinished } from "./timerClient.js";
import { invoke, currentWindow } from "./tauri.js";
import { playChime } from "./audio.js";

const emojiEl = document.getElementById("emoji");
const titleEl = document.getElementById("title");
const msgEl = document.getElementById("msg");
const actionsEl = document.getElementById("actions");
let lastKey = "";

function settings() {
  return store.getData()?.settings || {};
}

function hide() {
  invoke("hide_alert").catch(() => {});
}

function showSelf() {
  const win = currentWindow();
  win.show().catch(() => {});
  win.setFocus().catch(() => {});
}

async function run(act) {
  try {
    if (act === "startBreak") await timer.startBreak();
    else if (act === "nextStudy") await timer.nextStudy();
    else if (act === "extendStudy") await timer.extendStudy();
    else if (act === "stop") await timer.stop();
  } catch {
    /* ignore */
  }
  hide();
}

function render(state) {
  if (!state || !state.pending) {
    hide();
    return;
  }
  const key = `${state.mode}|${state.phase}`;
  if (key !== lastKey) {
    lastKey = key;
    const s = settings();
    if (s.soundEnabled !== false) {
      playChime(state.phase === "study" ? "study" : "break", s.soundVolume ?? 0.5);
    }
  }
  showSelf();

  const isStudy = state.phase === "study";
  const isCountdown = state.mode === "countdown";
  emojiEl.textContent = isStudy ? (isCountdown ? "⏰" : "🍅") : "☕";
  titleEl.textContent = isStudy
    ? isCountdown
      ? "倒计时结束"
      : "学习时间到啦！"
    : "休息结束～";
  msgEl.textContent = isStudy
    ? isCountdown
      ? "时间到，休息一下吧～"
      : "辛苦啦，起来活动一下，喝口水吧～"
    : "准备好开始下一轮了吗？";

  const extMin = settings().extendStudyMinutes || 5;
  const acts = isStudy
    ? isCountdown
      ? [
          { label: "知道了", act: "stop", variant: "soft-green" },
          { label: `延长 +${extMin} 分`, act: "extendStudy", variant: "warn" },
        ]
      : [
          { label: "开始休息", act: "startBreak", variant: "soft-green" },
          { label: `延长学习 +${extMin} 分`, act: "extendStudy", variant: "warn" },
        ]
    : [
        { label: "开始下一轮", act: "nextStudy", variant: "" },
        { label: "结束", act: "stop", variant: "ghost" },
      ];

  actionsEl.innerHTML = "";
  for (const a of acts) {
    const b = document.createElement("button");
    b.className = `btn ${a.variant || ""}`.trim();
    b.textContent = a.label;
    b.addEventListener("click", () => run(a.act));
    actionsEl.appendChild(b);
  }
}

async function boot() {
  await store.loadDataWithRetry();
  store.initDataSync();
  onFinished(async () => {
    try {
      render(await timer.state());
    } catch {
      /* ignore */
    }
  });
  try {
    render(await timer.state());
  } catch {
    /* ignore */
  }
}

boot();
