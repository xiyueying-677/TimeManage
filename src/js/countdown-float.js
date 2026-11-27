import * as store from "./store.js";
import { invoke, setWindowSize } from "./tauri.js";
import { createFloatShell } from "./floatShell.js";
import { onFloatChanged } from "./timerClient.js";
import { sortUpcoming, toKey } from "./calendar.js";
import { uid } from "./utils.js";

const SIZE_COLLAPSED = [272, 224];
const SIZE_EXPANDED = [300, 430];
const PALETTE = ["#6fa8ff", "#63c7d8", "#7fd6a8", "#ffd166", "#b6a8ff", "#ff9f8a"];

const card = document.getElementById("card");
const listEl = document.getElementById("list");
const footEl = document.getElementById("foot");
const form = document.getElementById("form");
const addBtn = document.getElementById("add");

let editingId = null;
let recurring = false;
let shell = null;

document.getElementById("close").addEventListener("click", () => {
  invoke("set_float_visible", { label: "countdown-float", visible: false }).catch(() => {});
});
document.getElementById("collapse").addEventListener("click", () => shell?.collapse());

function render() {
  const countdowns = store.getData()?.countdowns || [];
  const upcoming = sortUpcoming(countdowns, new Date());

  if (!upcoming.length) {
    listEl.innerHTML = `<div class="float-empty">还没有倒计时事件<br/>点右上角 ＋ 添加吧</div>`;
    footEl.textContent = "";
    return;
  }

  listEl.innerHTML = "";
  for (const { countdown, days, next } of upcoming) {
    const item = document.createElement("div");
    item.className = "float-item";

    const dayText = days === 0 ? "今天" : days > 0 ? days : Math.abs(days);
    const unit = days === 0 ? "" : days > 0 ? "天" : "天前";

    const daysEl = document.createElement("div");
    daysEl.className = "days" + (days <= 3 ? " soon" : "");
    if (countdown.color) daysEl.style.color = countdown.color;
    daysEl.innerHTML = `${dayText}<span style="font-size:10px;margin-left:2px">${unit}</span>`;

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `<div class="name"></div><div class="date"></div>`;
    info.querySelector(".name").textContent = countdown.title;
    info.querySelector(".date").textContent =
      `${toKey(next)}${countdown.recurring === "yearly" ? " · 每年" : ""}`;
    info.addEventListener("click", () => openForm(countdown));

    const del = document.createElement("button");
    del.className = "del";
    del.title = "删除";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      store.actions.deleteCountdown(countdown.id);
    });

    item.appendChild(daysEl);
    item.appendChild(info);
    item.appendChild(del);
    listEl.appendChild(item);
  }
  footEl.textContent = upcoming.length > 5 ? `共 ${upcoming.length} 个` : "";
}

function openForm(existing) {
  editingId = existing ? existing.id : null;
  const c = existing || {
    title: "",
    date: toKey(new Date()),
    recurring: "none",
    remindDaysBefore: 0,
    note: "",
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
  recurring = c.recurring === "yearly";
  document.getElementById("fTitle").value = c.title;
  document.getElementById("fDate").value = c.date;
  document.getElementById("fRemind").value = c.remindDaysBefore ?? 0;
  document.getElementById("fNote").value = c.note || "";
  document.getElementById("fRecurring").classList.toggle("on", recurring);

  card.classList.add("form-open");
  form.classList.add("show");
  addBtn.classList.add("active");
  setWindowSize(...SIZE_EXPANDED).catch(() => {});
  shell?.noteSize(...SIZE_EXPANDED);
  document.getElementById("fTitle").focus();
}

function closeForm() {
  editingId = null;
  card.classList.remove("form-open");
  form.classList.remove("show");
  addBtn.classList.remove("active");
  setWindowSize(...SIZE_COLLAPSED).catch(() => {});
  shell?.noteSize(...SIZE_COLLAPSED);
}

function save() {
  const title = document.getElementById("fTitle").value.trim();
  const date = document.getElementById("fDate").value;
  if (!title || !date) {
    document.getElementById("fTitle").style.borderColor = title ? "" : "#ef8f8a";
    document.getElementById("fDate").style.borderColor = date ? "" : "#ef8f8a";
    return;
  }
  const remind = Math.max(0, Number(document.getElementById("fRemind").value) || 0);
  const note = document.getElementById("fNote").value.trim();
  const id = editingId || uid("cd");
  const existing = (store.getData()?.countdowns || []).find((x) => x.id === id);
  const payload = {
    id,
    title,
    date,
    recurring: recurring ? "yearly" : "none",
    color: existing?.color || PALETTE[Math.floor(Math.random() * PALETTE.length)],
    note,
    remindDaysBefore: remind,
    lastNotifiedOn: existing?.lastNotifiedOn || null,
  };
  store.actions.saveCountdown(payload);
  closeForm();
}

addBtn.addEventListener("click", () => {
  if (form.classList.contains("show")) closeForm();
  else openForm(null);
});
document.getElementById("fSave").addEventListener("click", save);
document.getElementById("fCancel").addEventListener("click", closeForm);
document.getElementById("fRecurring").addEventListener("click", (e) => {
  recurring = !recurring;
  e.currentTarget.classList.toggle("on", recurring);
});

async function boot() {
  await store.loadDataWithRetry();
  const ui = store.getData()?.ui || {};
  shell = createFloatShell({ label: "countdown-float" });
  await shell.applyInitial(ui.countdownFloat);
  store.subscribe(() => render());
  await store.initDataSync();
  onFloatChanged(({ label, visible, x, y }) => {
    if (label !== "countdown-float") return;
    const ui = store.getData()?.ui;
    if (ui?.countdownFloat) {
      ui.countdownFloat.visible = !!visible;
      if (x !== null && x !== undefined) ui.countdownFloat.x = x;
      if (y !== null && y !== undefined) ui.countdownFloat.y = y;
    }
  });
  render();
  setInterval(render, 60000);
}

boot();
