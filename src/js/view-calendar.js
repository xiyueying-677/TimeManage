import * as store from "./store.js";
import { invoke } from "./tauri.js";
import { showToast, confirmDialog } from "./modal.js";
import { escapeHtml, uid } from "./utils.js";
import { toKey, occursOn, daysUntil, sortUpcoming, monthMatrix } from "./calendar.js";

const PALETTE = ["#ff9fb2", "#9fc7ff", "#9fe0c0", "#ffdfa3", "#c9b6ff", "#ffb38a"];

let root = null;
let built = false;
let view = new Date();
let floatVisible = false;

export function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h2>倒计时日历</h2>
        <div class="desc">把重要的日子放在眼前</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost small desktop-only" id="calFloatBtn">悬挂到桌面</button>
        <button class="btn small" id="calAddBtn">＋ 添加倒计时</button>
      </div>
    </div>
    <div class="cal-layout">
      <div class="card">
        <div class="cal-head">
          <button class="btn ghost small" id="calPrev">‹</button>
          <div class="month" id="calMonth"></div>
          <button class="btn ghost small" id="calNext">›</button>
        </div>
        <div class="cal-grid" id="calDow"></div>
        <div class="cal-grid" id="calGrid" style="margin-top:6px"></div>
      </div>
      <div class="card">
        <div class="view-head" style="margin-bottom:10px">
          <h3 style="margin:0;font-size:15px">临近事件</h3>
          <span class="pill" id="calCount"></span>
        </div>
        <div id="calList"></div>
      </div>
    </div>
  `;
  root.querySelector("#calPrev").addEventListener("click", () => {
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    render();
  });
  root.querySelector("#calNext").addEventListener("click", () => {
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    render();
  });
  root.querySelector("#calAddBtn").addEventListener("click", () => openForm(null));
  root.querySelector("#calFloatBtn").addEventListener("click", async () => {
    await invoke("toggle_float", { label: "countdown-float" });
  });
  renderDow();
  built = true;
  render();
}

function renderDow() {
  const wrap = root.querySelector("#calDow");
  wrap.innerHTML = "";
  for (const d of ["一", "二", "三", "四", "五", "六", "日"]) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    wrap.appendChild(el);
  }
}

export function setFloatVisible(v) {
  floatVisible = v;
  const btn = root?.querySelector("#calFloatBtn");
  if (btn) btn.textContent = v ? "取消悬挂" : "悬挂到桌面";
}

export function refresh() {
  if (built) render();
}

function render() {
  if (!built) return;
  const data = store.getData();
  if (!data) return;
  const countdowns = data.countdowns || [];
  const today = new Date();

  root.querySelector("#calMonth").textContent = `${view.getFullYear()} 年 ${view.getMonth() + 1} 月`;

  const grid = root.querySelector("#calGrid");
  grid.innerHTML = "";
  const weeks = monthMatrix(view.getFullYear(), view.getMonth());
  for (const week of weeks) {
    for (const { date, inMonth } of week) {
      const cell = document.createElement("div");
      cell.className = "cal-cell" + (inMonth ? "" : " out");
      if (toKey(date) === toKey(today)) cell.classList.add("today");
      const day = document.createElement("div");
      day.className = "day";
      day.textContent = date.getDate();
      cell.appendChild(day);
      for (const c of countdowns) {
        if (occursOn(c, date)) {
          const badge = document.createElement("div");
          badge.className = "cal-ev";
          const days = daysUntil(c, today);
          badge.textContent = c.title;
          badge.title = `${c.title}（剩余 ${days} 天）`;
          badge.style.background = (c.color || PALETTE[0]) + "33";
          badge.style.color = c.color || PALETTE[0];
          badge.addEventListener("click", () => openForm(c));
          cell.appendChild(badge);
        }
      }
      grid.appendChild(cell);
    }
  }

  const upcoming = sortUpcoming(countdowns, today);
  root.querySelector("#calCount").textContent = `${upcoming.length} 个`;
  const list = root.querySelector("#calList");
  list.innerHTML = "";
  if (!upcoming.length) {
    list.innerHTML = `<div class="empty"><span class="emoji">📅</span>还没有倒计时事件<br/>点击右上角添加吧</div>`;
    return;
  }
  for (const { countdown, days, next } of upcoming) {
    const item = document.createElement("div");
    item.className = "cal-list-item";
    const dayText = days === 0 ? "今天" : days > 0 ? days : "已过";
    item.innerHTML = `
      <div class="days" style="background:${(countdown.color || PALETTE[0]) + "22"};color:${countdown.color || PALETTE[0]}">
        ${days >= 0 ? dayText : Math.abs(days)}<small>${days === 0 ? "" : days > 0 ? "天" : "天前"}</small>
      </div>
      <div class="info">
        <div class="title">${escapeHtml(countdown.title)}</div>
        <div class="meta">${toKey(next)}${countdown.recurring === "yearly" ? " · 每年" : ""}${countdown.note ? " · " + escapeHtml(countdown.note) : ""}</div>
      </div>
      <div class="acts">
        <button class="btn ghost small" data-act="edit">编辑</button>
        <button class="btn ghost small" data-act="del">删除</button>
      </div>
    `;
    item.querySelector('[data-act="edit"]').addEventListener("click", () => openForm(countdown));
    item.querySelector('[data-act="del"]').addEventListener("click", async () => {
      const ok = await confirmDialog("删除倒计时", `确定删除「${countdown.title}」吗？`, "删除");
      if (!ok) return;
      await store.actions.deleteCountdown(countdown.id);
      showToast("已删除");
    });
    list.appendChild(item);
  }
}

function openForm(existing) {
  const isEdit = !!existing;
  const c = existing || {
    id: uid("cd"),
    title: "",
    date: toKey(new Date()),
    recurring: "none",
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
    note: "",
    remindDaysBefore: 0,
    lastNotifiedOn: null,
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.textAlign = "left";
  box.style.minWidth = "360px";
  box.innerHTML = `
    <h3 class="modal-title" style="text-align:center">${isEdit ? "编辑倒计时" : "添加倒计时"}</h3>
    <div class="form-col" style="margin-top:14px">
      <div class="field">
        <label>事件名称</label>
        <input type="text" id="fTitle" placeholder="例如：考试、生日" value="${escapeHtml(c.title)}" />
      </div>
      <div class="field">
        <label>日期</label>
        <input type="date" id="fDate" value="${c.date}" />
      </div>
      <div class="form-row" style="border:none;padding:0">
        <div>
          <label style="font-size:12.5px;font-weight:600;color:var(--text-soft)">每年重复</label>
          <div class="desc">生日、纪念日等适合开启</div>
        </div>
        <div class="switch ${c.recurring === "yearly" ? "on" : ""}" id="fRecurring"></div>
      </div>
      <div class="field">
        <label>提前提醒（天）</label>
        <input type="number" id="fRemind" min="0" max="365" value="${c.remindDaysBefore ?? 0}" />
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <input type="text" id="fNote" placeholder="写点什么…" value="${escapeHtml(c.note || "")}" />
      </div>
      <div class="field">
        <label>颜色</label>
        <div class="chips" id="fColors"></div>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn ghost" id="fCancel">取消</button>
      <button class="btn" id="fSave">保存</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  let recurring = c.recurring === "yearly";
  let color = c.color || PALETTE[0];

  const switchEl = box.querySelector("#fRecurring");
  switchEl.addEventListener("click", () => {
    recurring = !recurring;
    switchEl.classList.toggle("on", recurring);
  });

  const colorsEl = box.querySelector("#fColors");
  PALETTE.forEach((p) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.style.background = p + "33";
    b.style.color = p;
    b.style.borderColor = p === color ? p : "transparent";
    b.textContent = "●";
    b.addEventListener("click", () => {
      color = p;
      [...colorsEl.children].forEach((ch) => (ch.style.borderColor = "transparent"));
      b.style.borderColor = p;
    });
    colorsEl.appendChild(b);
  });

  const close = () => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 180);
  };
  box.querySelector("#fCancel").addEventListener("click", close);
  box.querySelector("#fSave").addEventListener("click", () => {
    const title = box.querySelector("#fTitle").value.trim();
    const date = box.querySelector("#fDate").value;
    if (!title) {
      showToast("请填写事件名称");
      return;
    }
    if (!date) {
      showToast("请选择日期");
      return;
    }
    const remind = Math.max(0, Number(box.querySelector("#fRemind").value) || 0);
    const note = box.querySelector("#fNote").value.trim();
    const payload = {
      id: c.id,
      title,
      date,
      recurring: recurring ? "yearly" : "none",
      color,
      note,
      remindDaysBefore: remind,
      lastNotifiedOn: c.lastNotifiedOn || null,
    };
    store.actions.saveCountdown(payload);
    showToast(isEdit ? "已保存" : "已添加");
    close();
  });

  box.querySelector("#fTitle").focus();
}
