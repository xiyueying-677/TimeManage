import * as store from "./store.js";
import { timer, onTick, onFinished, onFloatChanged } from "./timerClient.js";
import { invoke, setWindowSize } from "./tauri.js";
import { createFloatShell } from "./floatShell.js";
import { formatClock } from "./utils.js";

const SIZE_COLLAPSED = [272, 190];
const SIZE_EXPANDED = [320, 560];

const card = document.getElementById("card");
const dot = document.getElementById("dot");
const titleEl = document.getElementById("title");
const timeEl = document.getElementById("time");
const barEl = document.getElementById("bar");
const subEl = document.getElementById("sub");
const actionsEl = document.getElementById("actions");
const panel = document.getElementById("panel");
const gear = document.getElementById("gear");
const catWrap = document.getElementById("fpCategories");
const evWrap = document.getElementById("fpEvents");

let state = null;
let visible = false;
let promptMode = null;
let expanded = false;
let manageEvents = false;
let lastActionSig = "";
let shell = null;

function settings() {
  return store.getData()?.settings || {};
}

function selection() {
  const p = store.getData()?.ui?.pomodoro || {};
  return {
    categoryId: p.categoryId || null,
    eventId: p.eventId || null,
    mode: p.mode || "pomodoro",
    countdownMinutes: p.countdownMinutes || 25,
  };
}

function setSelection(patch) {
  const next = { ...selection(), ...patch };
  store.actions.setSelection(
    next.categoryId,
    next.eventId,
    next.mode,
    next.countdownMinutes,
  );
}

function phaseClass(s) {
  if (!s || s.phase === "idle") return "idle";
  if (s.paused) return "paused";
  return s.phase;
}

const START_LABELS = { pomodoro: "开始学习", countup: "开始正计时", countdown: "开始倒计时" };

function actionsFor(s) {
  const sel = selection();
  const eff = store.effectiveSettings(sel.categoryId, sel.eventId);
  const extStudy = eff.extendStudyMinutes || 5;
  const extBreak = eff.extendBreakMinutes || 1;
  const m = s?.mode || sel.mode;
  if (promptMode === "study") {
    if (m === "countdown") {
      return [
        { label: "知道了", variant: "soft-green", act: "stop" },
        { label: `延长 +${extStudy}分`, variant: "warn", act: "extendStudy" },
      ];
    }
    return [
      { label: "开始休息", variant: "soft-green", act: "startBreak" },
      { label: `延长 +${extStudy}分`, variant: "warn", act: "extendStudy" },
    ];
  }
  if (promptMode === "break") {
    return [
      { label: "下一轮", variant: "soft-green", act: "nextStudy" },
      { label: `延长 +${extBreak}分`, variant: "warn", act: "extendBreak" },
      { label: "结束", variant: "ghost", act: "stop" },
    ];
  }
  if (!s || s.phase === "idle") {
    return [{ label: START_LABELS[m] || "开始学习", variant: "", act: "start" }];
  }
  if (m === "countup") {
    return [
      s.paused
        ? { label: "继续", variant: "soft", act: "resume" }
        : { label: "暂停", variant: "ghost", act: "pause" },
      { label: "结束", variant: "ghost", act: "stop" },
    ];
  }
  if (s.phase === "study") {
    return [
      s.paused
        ? { label: "继续", variant: "soft", act: "resume" }
        : { label: "暂停", variant: "ghost", act: "pause" },
      { label: "延长", variant: "warn", act: "extendStudy" },
      { label: "结束", variant: "ghost", act: "endEarly" },
    ];
  }
  return [
    s.paused
      ? { label: "继续", variant: "soft", act: "resume" }
      : { label: "暂停", variant: "ghost", act: "pause" },
    { label: "延长", variant: "warn", act: "extendBreak" },
    { label: "结束", variant: "ghost", act: "endEarly" },
  ];
}

function renderActions() {
  const acts = actionsFor(state);
  const sig = acts.map((a) => a.label + a.act).join("|");
  if (sig === lastActionSig) return;
  lastActionSig = sig;
  actionsEl.innerHTML = "";
  for (const a of acts) {
    const btn = document.createElement("button");
    btn.className = `btn ${a.variant}`.trim();
    btn.textContent = a.label;
    btn.addEventListener("click", () => run(a.act));
    actionsEl.appendChild(btn);
  }
}

function render() {
  const s = state;
  const idle = !s || s.phase === "idle";
  const sel = selection();
  const m = idle ? sel.mode : s.mode || sel.mode;
  dot.className = "dot-phase " + phaseClass(s);

  const eff = store.effectiveSettings(sel.categoryId, sel.eventId);
  const studySecs = (eff.studyMinutes || 25) * 60;
  const cdSecs = (sel.countdownMinutes || 25) * 60;
  let total;
  let remaining;
  if (idle) {
    if (m === "countdown") {
      total = cdSecs;
      remaining = cdSecs;
    } else if (m === "countup") {
      total = 3600;
      remaining = 0;
    } else {
      total = studySecs;
      remaining = studySecs;
    }
  } else {
    total = s.totalSeconds || studySecs;
    remaining = s.remaining;
  }
  const frac = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 1;
  timeEl.textContent = formatClock(remaining);
  barEl.style.width = (frac * 100).toFixed(1) + "%";
  barEl.className =
    "float-bar-fill" + (s?.phase === "break" ? " break" : "") + (s?.paused ? " paused" : "");

  if (promptMode === "study") {
    titleEl.textContent = "学习完成";
    subEl.textContent = "休息一下吧～";
  } else if (promptMode === "break") {
    titleEl.textContent = "休息结束";
    subEl.textContent = "继续下一轮？";
  } else if (!s || s.phase === "idle") {
    titleEl.textContent = "番茄钟";
    subEl.textContent = "准备开始";
  } else {
    const m = s.mode || "pomodoro";
    titleEl.textContent =
      m === "countup"
        ? "正计时"
        : m === "countdown"
          ? "倒计时"
          : s.phase === "study"
            ? "专注学习"
            : "休息一下";
    if (s.paused) {
      subEl.textContent = "已暂停";
    } else if (m === "pomodoro") {
      const round = Math.min((s.cycleIndex || 0) + 1, s.cycles || 1);
      subEl.textContent = `${s.phase === "study" ? "学习" : "休息"} · 第 ${round}/${s.cycles || 1} 轮`;
    } else {
      const ev = store.eventLabel(s.categoryId, s.eventId);
      subEl.textContent = `${store.categoryLabel(s.categoryId)}${ev ? " · " + ev : ""}`;
    }
  }
  renderActions();
}

async function run(act) {
  if (act === "start") {
    const sel = selection();
    if (!sel.categoryId) {
      await invoke("show_main").catch(() => {});
      return;
    }
    state = await timer.start(sel.categoryId, sel.eventId, sel.mode, sel.countdownMinutes);
  } else if (act === "pause") state = await timer.pause();
  else if (act === "resume") state = await timer.resume();
  else if (act === "endEarly") state = (await timer.endEarly()).state;
  else if (act === "startBreak") {
    state = await timer.startBreak();
    promptMode = null;
  } else if (act === "nextStudy") {
    state = await timer.nextStudy();
    promptMode = null;
  } else if (act === "stop") {
    state = await timer.stop();
    promptMode = null;
  } else if (act === "extendStudy") {
    state = (await timer.extendStudy()).state;
    promptMode = null;
  } else if (act === "extendBreak") {
    state = await timer.extendBreak();
    promptMode = null;
  }
  if (state?.pending) promptMode = state.phase;
  lastActionSig = "";
  render();
}

function onFinishedHandler(p) {
  if (!p || p.autoNext) return;
  promptMode = p.kind === "study" ? "study" : "break";
  lastActionSig = "";
  render();
}

async function setExpanded(value, opts = {}) {
  expanded = value;
  card.classList.toggle("expanded", expanded);
  gear.classList.toggle("active", expanded);
  shell?.setUi({ panel: expanded });
  if (opts.resize === false) return;
  const [w, h] = expanded ? SIZE_EXPANDED : SIZE_COLLAPSED;
  try {
    await setWindowSize(w, h);
  } catch {
    /* ignore */
  }
  shell?.noteSize(w, h);
}

function renderPanel() {
  const cats = store.getData()?.categories || [];
  const sel = selection();
  if (!sel.categoryId && cats.length) {
    setSelection({ categoryId: cats[0].id, eventId: cats[0].events?.[0]?.id || null });
    return;
  }

  const modesWrap = document.getElementById("fpModes");
  modesWrap.innerHTML = "";
  for (const mm of [
    { key: "pomodoro", label: "番茄钟" },
    { key: "countup", label: "正计时" },
    { key: "countdown", label: "倒计时" },
  ]) {
    const b = document.createElement("button");
    b.className = "chip" + (mm.key === sel.mode ? " active" : "");
    b.textContent = mm.label;
    b.addEventListener("click", () => setSelection({ mode: mm.key }));
    modesWrap.appendChild(b);
  }
  const cdRow = document.getElementById("fpCountdownRow");
  cdRow.style.display = sel.mode === "countdown" ? "flex" : "none";
  const cdInput = document.getElementById("fpCdMinutes");
  if (document.activeElement !== cdInput) cdInput.value = sel.countdownMinutes;

  catWrap.innerHTML = "";
  for (const cat of cats) {
    const b = document.createElement("button");
    b.className = "chip" + (cat.id === sel.categoryId ? " active" : "");
    b.textContent = `${cat.icon || ""} ${cat.name}`.trim();
    b.addEventListener("click", () => {
      setSelection({ categoryId: cat.id, eventId: cat.events?.[0]?.id || null });
    });
    catWrap.appendChild(b);
  }

  evWrap.innerHTML = "";
  const cat = store.findCategory(sel.categoryId);
  const events = cat?.events || [];
  for (const ev of events) {
    const b = document.createElement("button");
    b.className = "chip" + (ev.id === sel.eventId ? " active" : "");
    b.textContent = manageEvents ? `✕ ${ev.name}` : ev.name;
    if (manageEvents) b.style.color = "#e0567a";
    b.addEventListener("click", () => {
      if (manageEvents) {
        const remaining = (store.findCategory(cat.id)?.events || []).filter(
          (x) => x.id !== ev.id,
        );
        store.actions.deleteEvent(cat.id, ev.id);
        if (sel.eventId === ev.id) setSelection({ categoryId: cat.id, eventId: remaining[0]?.id || null });
      } else {
        setSelection({ categoryId: cat.id, eventId: ev.id });
      }
    });
    evWrap.appendChild(b);
  }
  if (!events.length) {
    const tip = document.createElement("span");
    tip.className = "fp-label";
    tip.textContent = "暂无事件";
    evWrap.appendChild(tip);
  }

  const eff = store.effectiveSettings(sel.categoryId, sel.eventId);
  setNum("#fpStudy", eff.studyMinutes ?? 25);
  setNum("#fpBreak", eff.breakMinutes ?? 5);
  setNum("#fpCycles", eff.cycles ?? 4);
  setNum("#fpExtStudy", eff.extendStudyMinutes ?? 5);
  setNum("#fpExtBreak", eff.extendBreakMinutes ?? 1);
  document.getElementById("fpAuto").classList.toggle("on", !!eff.autoStartNext);
  const s = settings();
  document.getElementById("fpSound").classList.toggle("on", s.soundEnabled !== false);
  document.getElementById("fpVolume").value = Math.round((s.soundVolume ?? 0.5) * 100);
}

function setNum(sel, value) {
  const el = document.querySelector(sel);
  if (el && document.activeElement !== el) el.value = value;
}

function bindSettings() {
  const num = (sel, key, min, max) => {
    document.querySelector(sel).addEventListener("change", (e) => {
      const cur = selection();
      if (!cur.categoryId || !cur.eventId) return;
      let v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      store.actions.setEventConfig(cur.categoryId, cur.eventId, { [key]: v });
      e.target.value = v;
    });
  };
  num("#fpStudy", "studyMinutes", 1, 180);
  num("#fpBreak", "breakMinutes", 1, 120);
  num("#fpCycles", "cycles", 1, 24);
  num("#fpExtStudy", "extendStudyMinutes", 1, 60);
  num("#fpExtBreak", "extendBreakMinutes", 1, 60);

  document.getElementById("fpAuto").addEventListener("click", (e) => {
    const cur = selection();
    if (!cur.categoryId || !cur.eventId) return;
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    store.actions.setEventConfig(cur.categoryId, cur.eventId, { autoStartNext: on });
  });
  document.getElementById("fpSound").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    store.actions.updateSettings({ soundEnabled: on });
  });
  document.getElementById("fpVolume").addEventListener("input", (e) => {
    const v = Number(e.target.value) / 100;
    store.actions.updateSettings({ soundVolume: v });
  });
  document.getElementById("fpCdMinutes").addEventListener("change", (e) => {
    let v = Math.round(Number(e.target.value));
    if (!Number.isFinite(v)) v = 25;
    v = Math.max(1, Math.min(600, v));
    e.target.value = v;
    setSelection({ countdownMinutes: v });
  });
  document.getElementById("fpOpenMain").addEventListener("click", () => {
    invoke("show_main").catch(() => {});
  });
}

function bindAddEvent() {
  const input = document.getElementById("fpNewEvent");
  const add = document.getElementById("fpAddEvent");
  const manage = document.getElementById("fpManageEvents");
  const doAdd = async () => {
    const name = input.value.trim();
    if (!name) return;
    const sel = selection();
    const id = await store.actions.addEvent(sel.categoryId, name);
    if (!sel.eventId) setSelection({ categoryId: sel.categoryId, eventId: id });
    input.value = "";
  };
  add.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });
  manage.addEventListener("click", () => {
    manageEvents = !manageEvents;
    manage.classList.toggle("active", manageEvents);
    manage.textContent = manageEvents ? "完成" : "管理";
    renderPanel();
  });
}

gear.addEventListener("click", () => setExpanded(!expanded));
document.getElementById("collapse").addEventListener("click", () => shell?.collapse());
document.getElementById("close").addEventListener("click", () => {
  invoke("set_float_visible", { label: "pomodoro-float", visible: false }).catch(() => {});
});

async function boot() {
  await store.loadDataWithRetry();
  const ui = store.getData()?.ui || {};
  visible = !!ui.pomodoroFloat?.visible;

  shell = createFloatShell({ label: "pomodoro-float" });
  await shell.applyInitial(ui.pomodoroFloat);
  if (ui.pomodoroFloat?.panel) await setExpanded(true, { resize: false });

  bindSettings();
  bindAddEvent();

  store.subscribe(() => {
    renderPanel();
    render();
  });
  await store.initDataSync();

  onTick((s) => {
    state = s;
    if (!s.pending) promptMode = null;
    else if (!promptMode) promptMode = s.phase;
    render();
  });
  onFinished(onFinishedHandler);
  onFloatChanged(({ label, visible: v, x, y }) => {
    if (label !== "pomodoro-float") return;
    visible = !!v;
    const ui = store.getData()?.ui;
    if (ui?.pomodoroFloat) {
      ui.pomodoroFloat.visible = !!v;
      if (x !== null && x !== undefined) ui.pomodoroFloat.x = x;
      if (y !== null && y !== undefined) ui.pomodoroFloat.y = y;
    }
  });

  try {
    state = await timer.state();
  } catch {
    state = null;
  }
  if (state?.pending) promptMode = state.phase;
  renderPanel();
  render();
}

boot();
