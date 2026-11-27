import * as store from "./store.js";
import { timer } from "./timerClient.js";
import { isAndroid } from "./tauri.js";
import { showModal, showToast } from "./modal.js";
import { playChime, unlockAudio } from "./audio.js";
import { formatClock, formatDuration, escapeHtml } from "./utils.js";

const CIRC = 2 * Math.PI * 104;

let root = null;
let state = null;
let selected = { categoryId: null, eventId: null };
let mode = "pomodoro";
let countdownMinutes = 25;
let built = false;

function settings() {
  return store.getData()?.settings || {};
}

function ensureSelection() {
  const cats = store.getData()?.categories || [];
  if (!selected.categoryId || !cats.find((c) => c.id === selected.categoryId)) {
    selected.categoryId = cats[0]?.id || null;
    selected.eventId = cats[0]?.events?.[0]?.id || null;
  }
  const cat = cats.find((c) => c.id === selected.categoryId);
  if (cat && selected.eventId && !cat.events?.find((e) => e.id === selected.eventId)) {
    selected.eventId = cat.events?.[0]?.id || null;
  }
}

function persistSelection() {
  store.actions.setSelection(selected.categoryId, selected.eventId, mode, countdownMinutes);
}

export function mount(el) {
  root = el;
  const saved = store.getData()?.ui?.pomodoro;
  if (saved) {
    selected = { categoryId: saved.categoryId, eventId: saved.eventId };
    if (saved.mode) mode = saved.mode;
    if (saved.countdownMinutes) countdownMinutes = saved.countdownMinutes;
  }
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h2>番茄钟</h2>
        <div class="desc">专注学习，温柔休息</div>
      </div>
    </div>
    <div class="pomo-layout">
      <div class="pomo-side">
        <div class="card">
          <div class="block-title">选择大类</div>
          <div class="chips" id="categoryChips"></div>
        </div>
        <div class="card">
          <div class="block-title">选择事件</div>
          <div class="chips" id="eventChips"></div>
          <button class="btn ghost small" id="manageEvents" style="margin-top:12px">管理事件</button>
        </div>
        <div class="card">
          <div class="block-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>该事件计时</span>
            <button class="btn ghost small" id="resetEventConfig" style="padding:3px 9px;font-size:11.5px">恢复默认</button>
          </div>
          <div class="form-row"><span>学习</span><span><input type="number" id="ecStudy" min="1" max="180" style="width:62px" /> 分</span></div>
          <div class="form-row"><span>休息</span><span><input type="number" id="ecBreak" min="1" max="120" style="width:62px" /> 分</span></div>
          <div class="form-row"><span>循环</span><span><input type="number" id="ecCycles" min="1" max="24" style="width:62px" /> 次</span></div>
          <div class="form-row"><span>延长学习</span><span><input type="number" id="ecExtStudy" min="1" max="60" style="width:62px" /> 分</span></div>
          <div class="form-row"><span>延长休息</span><span><input type="number" id="ecExtBreak" min="1" max="60" style="width:62px" /> 分</span></div>
          <div class="form-row"><span>自动下一阶段</span><div class="switch small" id="ecAuto"></div></div>
          <div class="desc" id="ecHint" style="font-size:11.5px;color:var(--text-faint);margin-top:8px"></div>
        </div>
      </div>
      <div class="card pomo-main">
        <div class="pomo-modes" id="modeChips"></div>
        <div class="pomo-countdown" id="countdownRow" style="display:none">
          <span>倒计时</span>
          <input type="number" id="cdMinutes" min="1" max="600" style="width:72px" />
          <span>分钟</span>
        </div>
        <div class="ring-wrap" id="ringWrap">
          <svg class="ring" viewBox="0 0 240 240">
            <circle class="track" cx="120" cy="120" r="104"></circle>
            <circle class="progress" id="ringProgress" cx="120" cy="120" r="104"
              stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"></circle>
          </svg>
          <div class="ring-label">
            <div class="phase-name" id="phaseName">准备开始</div>
            <div class="time-text" id="timeText">25:00</div>
            <div class="cycle-text" id="cycleText"></div>
            <div class="dots" id="cycleDots"></div>
          </div>
        </div>
        <div class="pomo-actions" id="pomoActions"></div>
        <div class="pomo-hint" id="pomoHint"></div>
      </div>
    </div>
  `;
  root.querySelector("#manageEvents").addEventListener("click", openEventManager);
  bindEventConfig();
  renderModeChips();
  root.querySelector("#cdMinutes").addEventListener("change", (e) => {
    let v = Math.round(Number(e.target.value));
    if (!Number.isFinite(v)) v = 25;
    countdownMinutes = Math.max(1, Math.min(600, v));
    e.target.value = countdownMinutes;
    persistSelection();
  });
  built = true;
  refresh();
  if (state) renderTimer();
}

function renderModeChips() {
  const wrap = root.querySelector("#modeChips");
  wrap.innerHTML = "";
  const modes = [
    { key: "pomodoro", label: "番茄钟" },
    { key: "countup", label: "正计时" },
    { key: "countdown", label: "倒计时" },
  ];
  for (const m of modes) {
    const b = document.createElement("button");
    b.className = "chip" + (m.key === mode ? " active" : "");
    b.textContent = m.label;
    b.addEventListener("click", () => {
      mode = m.key;
      renderModeChips();
      persistSelection();
      renderTimer();
    });
    wrap.appendChild(b);
  }
  const row = root.querySelector("#countdownRow");
  if (row) row.style.display = mode === "countdown" ? "" : "none";
  const cd = root.querySelector("#cdMinutes");
  if (cd && document.activeElement !== cd) cd.value = countdownMinutes;
}

function bindEventConfig() {
  const num = (sel, key, min, max) => {
    root.querySelector(sel).addEventListener("change", (e) => {
      if (!selected.categoryId || !selected.eventId) return;
      let v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      store.actions.setEventConfig(selected.categoryId, selected.eventId, { [key]: v });
      e.target.value = v;
    });
  };
  num("#ecStudy", "studyMinutes", 1, 180);
  num("#ecBreak", "breakMinutes", 1, 120);
  num("#ecCycles", "cycles", 1, 24);
  num("#ecExtStudy", "extendStudyMinutes", 1, 60);
  num("#ecExtBreak", "extendBreakMinutes", 1, 60);
  root.querySelector("#ecAuto").addEventListener("click", (e) => {
    if (!selected.categoryId || !selected.eventId) return;
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    store.actions.setEventConfig(selected.categoryId, selected.eventId, { autoStartNext: on });
  });
  root.querySelector("#resetEventConfig").addEventListener("click", async () => {
    if (!selected.categoryId || !selected.eventId) return;
    await store.actions.clearEventConfig(selected.categoryId, selected.eventId);
    showToast("已恢复全局默认");
  });
}

function setInput(sel, value) {
  const el = root.querySelector(sel);
  if (el && document.activeElement !== el) el.value = value;
}

function renderEventConfig() {
  const eff = store.effectiveSettings(selected.categoryId, selected.eventId);
  setInput("#ecStudy", eff.studyMinutes ?? 25);
  setInput("#ecBreak", eff.breakMinutes ?? 5);
  setInput("#ecCycles", eff.cycles ?? 4);
  setInput("#ecExtStudy", eff.extendStudyMinutes ?? 5);
  setInput("#ecExtBreak", eff.extendBreakMinutes ?? 1);
  root.querySelector("#ecAuto").classList.toggle("on", !!eff.autoStartNext);
  const overridden = store.hasEventConfig(selected.categoryId, selected.eventId);
  root.querySelector("#ecHint").textContent = overridden
    ? "已为该事件单独保存，切换事件会各自记住"
    : "未自定义，使用「设置」里的全局默认";
}

export function refresh() {
  if (!built) return;
  ensureSelection();
  renderCategoryChips();
  renderEventChips();
  renderEventConfig();
  if (state) renderTimer();
}

function renderCategoryChips() {
  const wrap = root.querySelector("#categoryChips");
  wrap.innerHTML = "";
  for (const cat of store.getData()?.categories || []) {
    const b = document.createElement("button");
    b.className = "chip" + (cat.id === selected.categoryId ? " active" : "");
    b.textContent = `${cat.icon || ""} ${cat.name}`.trim();
    b.addEventListener("click", () => {
      selected.categoryId = cat.id;
      selected.eventId = cat.events?.[0]?.id || null;
      persistSelection();
      renderCategoryChips();
      renderEventChips();
    });
    wrap.appendChild(b);
  }
}

function renderEventChips() {
  const wrap = root.querySelector("#eventChips");
  wrap.innerHTML = "";
  const cat = store.findCategory(selected.categoryId);
  const events = cat?.events || [];
  if (!events.length) {
    const tip = document.createElement("div");
    tip.className = "empty";
    tip.style.padding = "12px 0";
    tip.textContent = "还没有事件，点击下方“管理事件”添加吧";
    wrap.appendChild(tip);
    return;
  }
  for (const ev of events) {
    const b = document.createElement("button");
    b.className = "chip" + (ev.id === selected.eventId ? " active" : "");
    b.textContent = ev.name;
    b.addEventListener("click", () => {
      selected.eventId = ev.id;
      persistSelection();
      renderEventChips();
    });
    wrap.appendChild(b);
  }
}

function extendMinutes(kind) {
  const eff = store.effectiveSettings(selected.categoryId, selected.eventId);
  return kind === "study" ? eff.extendStudyMinutes || 5 : eff.extendBreakMinutes || 1;
}

const START_LABELS = { pomodoro: "开始学习", countup: "开始正计时", countdown: "开始倒计时" };

function actionsFor(s) {
  if (!s || s.phase === "idle") {
    return [{ label: START_LABELS[mode] || "开始学习", variant: "", act: "start" }];
  }
  const m = s.mode || "pomodoro";
  if (m === "countup") {
    return [
      s.paused
        ? { label: "继续", variant: "soft", act: "resume" }
        : { label: "暂停", variant: "ghost", act: "pause" },
      { label: "结束", variant: "ghost", act: "stop" },
    ];
  }
  if (s.phase === "study") {
    if (s.pending) {
      if (m === "countdown") {
        return [
          { label: "知道了", variant: "soft-green", act: "stop" },
          { label: `延长 +${extendMinutes("study")} 分`, variant: "warn", act: "extendStudy" },
        ];
      }
      return [
        { label: "开始休息", variant: "soft-green", act: "startBreak" },
        { label: `延长学习 +${extendMinutes("study")} 分`, variant: "warn", act: "extendStudy" },
      ];
    }
    return [
      s.paused
        ? { label: "继续", variant: "soft", act: "resume" }
        : { label: "暂停", variant: "ghost", act: "pause" },
      { label: "提前结束", variant: "ghost", act: "endEarly" },
      { label: `延长 +${extendMinutes("study")} 分`, variant: "warn", act: "extendStudy" },
    ];
  }
  if (s.pending) {
    return [
      { label: "开始下一轮", variant: "soft-green", act: "nextStudy" },
      { label: `延长休息 +${extendMinutes("break")} 分`, variant: "warn", act: "extendBreak" },
      { label: "结束", variant: "ghost", act: "stop" },
    ];
  }
  return [
    s.paused
      ? { label: "继续", variant: "soft", act: "resume" }
      : { label: "暂停", variant: "ghost", act: "pause" },
    { label: "提前结束", variant: "ghost", act: "endEarly" },
    { label: `延长 +${extendMinutes("break")} 分`, variant: "warn", act: "extendBreak" },
  ];
}

function renderActions() {
  const wrap = root.querySelector("#pomoActions");
  wrap.innerHTML = "";
  for (const a of actionsFor(state)) {
    const btn = document.createElement("button");
    btn.className = `btn ${a.variant}`.trim();
    btn.textContent = a.label;
    btn.addEventListener("click", () => runAction(a.act));
    wrap.appendChild(btn);
  }
}

function renderDots() {
  const wrap = root.querySelector("#cycleDots");
  wrap.innerHTML = "";
  const idle = !state || state.phase === "idle";
  const m = idle ? mode : state.mode || mode;
  if (m !== "pomodoro") return;
  const eff = store.effectiveSettings(selected.categoryId, selected.eventId);
  const cycles = idle
    ? eff.cycles || 4
    : state.cycles || eff.cycles || 4;
  const idx = state?.cycleIndex || 0;
  for (let i = 0; i < cycles; i++) {
    const d = document.createElement("div");
    d.className = "dot";
    if (!idle) {
      if (i < idx) d.classList.add("done");
      else if (i === idx && state.phase === "study") d.classList.add("current");
    }
    wrap.appendChild(d);
  }
}

function renderTimer() {
  if (!built) return;
  const s = state;
  const idle = !s || s.phase === "idle";
  const m = idle ? mode : s.mode || mode;
  const wrap = root.querySelector("#ringWrap");
  wrap.classList.toggle("break", !idle && s.phase === "break");
  wrap.classList.toggle("paused", !idle && !!s.paused);

  const eff = store.effectiveSettings(selected.categoryId, selected.eventId);
  const studySecs = (eff.studyMinutes || 25) * 60;
  const cdSecs = (countdownMinutes || 25) * 60;

  let total;
  if (m === "countup") {
    total = Math.max(3600, s?.elapsedSeconds || 0);
  } else if (m === "countdown") {
    total = idle ? cdSecs : (s?.totalSeconds || cdSecs) || 1;
  } else {
    total = idle ? studySecs : s?.totalSeconds || studySecs;
  }
  const remaining = idle
    ? m === "countdown"
      ? cdSecs
      : m === "countup"
        ? 0
        : total
    : s.remaining;
  const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
  const prog = root.querySelector("#ringProgress");
  prog.setAttribute("stroke-dashoffset", (CIRC * (1 - frac)).toFixed(2));

  root.querySelector("#timeText").textContent = formatClock(remaining);

  const phaseName = root.querySelector("#phaseName");
  if (idle) phaseName.textContent = "准备开始";
  else if (m === "countup") phaseName.textContent = "正计时中";
  else if (m === "countdown") phaseName.textContent = s.pending ? "倒计时完成" : "倒计时中";
  else if (s.phase === "study") phaseName.textContent = s.pending ? "学习完成" : "专注学习";
  else phaseName.textContent = s.pending ? "休息完成" : "休息一下";

  const catId = idle ? selected.categoryId : s.categoryId;
  const evId = idle ? selected.eventId : s.eventId;
  const cat = store.categoryLabel(catId);
  const ev = store.eventLabel(catId, evId);
  const cycleText = root.querySelector("#cycleText");
  if (!idle && m === "pomodoro") {
    const round = Math.min((s.cycleIndex || 0) + 1, s.cycles || 1);
    cycleText.textContent = `${cat}${ev ? " · " + ev : ""} ｜ 第 ${round}/${s.cycles || 1} 轮`;
  } else {
    const cycles = (idle ? eff.cycles : s?.cycles) || eff.cycles || 4;
    const tail = m === "pomodoro" ? ` ｜ 共 ${cycles} 轮` : "";
    cycleText.textContent = `${cat}${ev ? " · " + ev : ""}${tail}`;
  }

  renderDots();
  renderActions();

  const hint = root.querySelector("#pomoHint");
  const parts = [];
  if (s?.paused) parts.push("已暂停，暂停时间不计入统计");
  if (s?.extended > 0) {
    parts.push(`本次已延长 ${formatDuration(s.extended)}（${s.extendedCount} 次）`);
  }
  if (s?.pausedSeconds > 0) parts.push(`累计暂停 ${formatDuration(s.pausedSeconds)}`);
  hint.textContent = parts.join("　·　");
}

async function runAction(act) {
  unlockAudio();
  if (act === "start") {
    if (!selected.categoryId) {
      showToast("请先选择一个大类");
      return;
    }
    applyState(await timer.start(selected.categoryId, selected.eventId, mode, countdownMinutes));
  } else if (act === "pause") {
    applyState(await timer.pause());
  } else if (act === "resume") {
    applyState(await timer.resume());
  } else if (act === "endEarly") {
    const res = await timer.endEarly();
    applyState(res.state);
  } else if (act === "startBreak") {
    applyState(await timer.startBreak());
  } else if (act === "nextStudy") {
    applyState(await timer.nextStudy());
  } else if (act === "stop") {
    applyState(await timer.stop());
  } else if (act === "extendStudy") {
    const res = await timer.extendStudy();
    applyState(res.state);
    if (res.warn) await warnTooMuch();
  } else if (act === "extendBreak") {
    applyState(await timer.extendBreak());
  }
}

async function warnTooMuch() {
  const choice = await showModal({
    title: "应该休息了",
    message: "你已经延长了不少时间啦，记得让眼睛和身体休息一下～ 也可以继续延长。",
    icon: "😴",
    actions: [
      { label: "开始休息", value: "break", variant: "soft-green" },
      { label: "继续延长", value: "more", variant: "warn" },
    ],
  });
  if (choice === "break") applyState(await timer.startBreak());
}

export function applyState(s) {
  state = s;
  if (built) renderTimer();
}

export async function onFinished(p) {
  if (!p || p.autoNext) return;
  const st = settings();
  // Android 的结束声音由系统通知负责，避免应用内提示音与通知声音叠加
  if (st.soundEnabled && !isAndroid) playChime(p.kind === "study" ? "study" : "break", st.soundVolume);
  if (p.kind === "study") {
    const choice = await showModal({
      title: "学习时间到啦！",
      message: "辛苦啦，起来活动一下，喝口水吧～",
      icon: "🍅",
      actions: [
        { label: "开始休息", value: "break", variant: "soft-green" },
        { label: "延长学习", value: "extend", variant: "warn" },
      ],
    });
    if (choice === "break") applyState(await timer.startBreak());
    else applyState((await timer.extendStudy()).state);
  } else {
    const choice = await showModal({
      title: "休息结束～",
      message: "准备好开始下一轮了吗？",
      icon: "☕",
      actions: [
        { label: "开始下一轮", value: "next", variant: "soft-green" },
        { label: `延长休息 +${extendMinutes("break")} 分`, value: "extendBreak", variant: "warn" },
        { label: "结束", value: "stop", variant: "ghost" },
      ],
    });
    if (choice === "next") applyState(await timer.nextStudy());
    else if (choice === "extendBreak") applyState(await timer.extendBreak());
    else applyState(await timer.stop());
  }
}

function openEventManager() {
  const cat = store.findCategory(selected.categoryId);
  if (!cat) return;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.textAlign = "left";
  box.style.minWidth = "340px";
  box.innerHTML = `
    <h3 class="modal-title" style="text-align:center">管理「${escapeHtml(cat.name)}」事件</h3>
    <div id="evList" style="max-height:260px;overflow:auto;margin:12px 0"></div>
    <div style="display:flex;gap:8px">
      <input type="text" id="evInput" placeholder="新事件名称" style="flex:1" />
      <button class="btn" id="evAdd">添加</button>
    </div>
    <div class="modal-actions" style="margin-top:16px">
      <button class="btn ghost" id="evClose">完成</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  const listEl = box.querySelector("#evList");
  const input = box.querySelector("#evInput");

  const renderList = () => {
    listEl.innerHTML = "";
    const current = store.findCategory(cat.id)?.events || [];
    if (!current.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "暂无事件";
      listEl.appendChild(e);
      return;
    }
    current.forEach((ev) => {
      const row = document.createElement("div");
      row.className = "form-row";
      const name = document.createElement("div");
      name.textContent = ev.name;
      const del = document.createElement("button");
      del.className = "btn ghost small";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        const remaining = (store.findCategory(cat.id)?.events || []).filter(
          (x) => x.id !== ev.id,
        );
        await store.actions.deleteEvent(cat.id, ev.id);
        await store.loadData();
        if (selected.eventId === ev.id) {
          selected.eventId = remaining[0]?.id || null;
          persistSelection();
        }
        renderList();
      });
      row.appendChild(name);
      row.appendChild(del);
      listEl.appendChild(row);
    });
  };

  const addEvent = async () => {
    const name = input.value.trim();
    if (!name) return;
    const id = await store.actions.addEvent(cat.id, name);
    await store.loadData();
    if (!selected.eventId) {
      selected.eventId = id;
      persistSelection();
    }
    input.value = "";
    renderList();
  };

  box.querySelector("#evAdd").addEventListener("click", addEvent);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addEvent();
  });
  box.querySelector("#evClose").addEventListener("click", () => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 180);
    refresh();
  });

  renderList();
  input.focus();
}
