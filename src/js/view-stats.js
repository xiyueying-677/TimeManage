import * as store from "./store.js";
import { formatDuration, formatHours, uid, escapeHtml } from "./utils.js";
import { showToast, confirmDialog } from "./modal.js";
import {
  RANGES,
  RANGE_LABELS,
  rangeBounds,
  rangeLabel,
  shiftRef,
  breakdown,
  seriesByGroup,
  filterByRange,
  aggregate,
} from "./stats.js";

const CAT_PALETTE = ["#6fa8ff", "#ffd166", "#7fd6a8", "#b6a8ff", "#ff9f8a", "#63c7d8"];
const EVENT_PALETTE = [
  "#6fa8ff", "#ffd166", "#7fd6a8", "#b6a8ff", "#ff9f8a", "#63c7d8",
  "#f48fb1", "#a5d6a7", "#ffcc80", "#90caf9", "#ce93d8", "#80cbc4",
];
const RECORD_PAGE_SIZE = 10;

let root = null;
let built = false;
let range = "day";
let ref = new Date();
let showEvents = false;
let recordGroup = "day";
let recordPage = 1;
const selectedIds = new Set();

export function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h2>统计</h2>
        <div class="desc">记录每一份专注与休息</div>
      </div>
      <div class="stat-filters" id="rangeChips"></div>
    </div>
    <div class="stat-filters" style="margin-bottom:16px">
      <button class="btn ghost small" id="prevRange">‹</button>
      <div class="pill" id="rangeLabel"></div>
      <button class="btn ghost small" id="nextRange">›</button>
      <button class="btn ghost small" id="todayRange">回到今天</button>
      <label class="date-jump">跳到日期
        <input type="date" id="pickDate" />
      </label>
    </div>
    <div class="stat-grid" id="statCards"></div>
    <div class="chart">
      <div class="chart-head">
        <h3>趋势</h3>
        <div class="chart-legend" id="chartLegend"></div>
      </div>
      <div class="chart-body" id="chartBody"></div>
      <div class="chart-labels" id="chartLabels"></div>
    </div>
    <div class="session-head" style="margin-top:0">
      <h3>分类统计</h3>
      <div class="stat-filters" id="modeChips"></div>
    </div>
    <div class="table-wrap">
      <table class="stats">
        <thead>
          <tr>
            <th>分类 / 事件</th>
            <th class="num">时长</th>
            <th class="num">次数</th>
            <th class="num">延长时长</th>
            <th class="num">延长次数</th>
          </tr>
        </thead>
        <tbody id="statRows"></tbody>
      </table>
    </div>
    <div class="session-head">
      <h3>记录明细</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="pill" id="selCount">已选 0 条</span>
        <button class="btn ghost small" id="batchEdit" disabled>批量修改</button>
        <button class="btn ghost small" id="batchDelete" disabled>批量删除</button>
        <button class="btn ghost small" id="addSession">＋ 补录一条</button>
      </div>
    </div>
    <div class="stat-filters" id="recordGroupChips" style="margin-bottom:10px"></div>
    <div class="table-wrap">
      <table class="stats">
        <thead>
          <tr>
            <th style="width:36px"><input type="checkbox" id="sessionSelectAll" /></th>
            <th>时间</th>
            <th>类型</th>
            <th>分类 / 事件</th>
            <th class="num">时长</th>
            <th class="num">延长</th>
            <th style="width:120px">操作</th>
          </tr>
        </thead>
        <tbody id="sessionRows"></tbody>
      </table>
    </div>
    <div class="pager" id="recordPager"></div>
  `;
  root.querySelector("#prevRange").addEventListener("click", () => move(-1));
  root.querySelector("#nextRange").addEventListener("click", () => move(1));
  root.querySelector("#todayRange").addEventListener("click", () => {
    ref = new Date();
    refresh();
  });
  root.querySelector("#pickDate").addEventListener("change", (e) => {
    const parts = (e.target.value || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return;
    ref = new Date(parts[0], parts[1] - 1, parts[2]);
    if (range === "total") {
      range = "day";
      renderRangeChips();
    }
    refresh();
  });
  root.querySelector("#addSession").addEventListener("click", () => openSessionForm(null));
  root.querySelector("#sessionSelectAll").addEventListener("change", (e) => {
    if (e.target.checked) {
      root.querySelectorAll("#sessionRows input[type=checkbox][data-id]").forEach((cb) => {
        selectedIds.add(cb.dataset.id);
      });
    } else {
      selectedIds.clear();
    }
    refresh();
  });
  root.querySelector("#batchDelete").addEventListener("click", batchDelete);
  root.querySelector("#batchEdit").addEventListener("click", batchEdit);
  renderRangeChips();
  renderModeChips();
  renderRecordGroupChips();
  built = true;
  refresh();
}

function renderRecordGroupChips() {
  const wrap = root.querySelector("#recordGroupChips");
  wrap.innerHTML = "";
  const modes = [
    { key: "day", label: "按日" },
    { key: "month", label: "按月" },
    { key: "year", label: "按年" },
  ];
  for (const m of modes) {
    const b = document.createElement("button");
    b.className = "chip" + (m.key === recordGroup ? " active" : "");
    b.textContent = m.label;
    b.addEventListener("click", () => {
      recordGroup = m.key;
      recordPage = 1;
      renderRecordGroupChips();
      refresh();
    });
    wrap.appendChild(b);
  }
}

function renderModeChips() {
  const wrap = root.querySelector("#modeChips");
  wrap.innerHTML = "";
  const modes = [
    { key: false, label: "大分类" },
    { key: true, label: "小分类" },
  ];
  for (const m of modes) {
    const b = document.createElement("button");
    b.className = "chip" + (m.key === showEvents ? " active" : "");
    b.textContent = m.label;
    b.addEventListener("click", () => {
      showEvents = m.key;
      renderModeChips();
      refresh();
    });
    wrap.appendChild(b);
  }
}

function move(delta) {
  ref = shiftRef(range, ref, delta);
  refresh();
}

function renderRangeChips() {
  const wrap = root.querySelector("#rangeChips");
  wrap.innerHTML = "";
  for (const r of RANGES) {
    const b = document.createElement("button");
    b.className = "chip" + (r === range ? " active" : "");
    b.textContent = RANGE_LABELS[r];
    b.addEventListener("click", () => {
      range = r;
      ref = new Date();
      renderRangeChips();
      refresh();
    });
    wrap.appendChild(b);
  }
}

function catCard(icon, name, agg, color) {
  const ext = agg.extendSeconds
    ? `<span class="sub-ext">延长 ${formatHours(agg.extendSeconds)}h · ${agg.extendCount} 次</span>`
    : "";
  return `<div class="stat-card cat" style="border-left-color:${color}">
    <div class="label">${icon || ""} ${escapeHtml(name)}</div>
    <div class="value">${formatHours(agg.seconds)}<span class="unit">小时</span></div>
    <div class="sub">${agg.count} 次${ext}</div>
  </div>`;
}

export function refresh() {
  if (!built) return;
  const data = store.getData();
  if (!data) return;
  const bounds = rangeBounds(range, ref);
  root.querySelector("#rangeLabel").textContent = rangeLabel(range, ref);
  const pick = root.querySelector("#pickDate");
  if (pick && document.activeElement !== pick) pick.value = toDateInput(ref);

  const sessions = data.sessions || [];
  const inRangeStudy = filterByRange(sessions, bounds).filter((x) => x.kind === "study");
  const cats = data.categories || [];
  const known = new Set(cats.map((c) => c.id));
  const cards = cats.map((cat, i) =>
    catCard(
      cat.icon,
      cat.name,
      aggregate(inRangeStudy.filter((x) => x.categoryId === cat.id)),
      CAT_PALETTE[i % CAT_PALETTE.length],
    ),
  );
  const otherAgg = aggregate(
    inRangeStudy.filter((x) => !x.categoryId || !known.has(x.categoryId)),
  );
  if (otherAgg.count) cards.push(catCard("", "未分类", otherAgg, "#b8c2d0"));
  root.querySelector("#statCards").innerHTML = cards.join("");

  const groups = buildGroups(data, showEvents);
  renderChart(seriesByGroup(sessions, range, ref, groups), groups);

  const { rows } = breakdown(sessions, bounds, data.categories || [], {
    includeEvents: showEvents,
    includeEmpty: true,
  });
  const tbody = root.querySelector("#statRows");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty"><span class="emoji">🌱</span>这个时间段还没有记录</div></td></tr>`;
  } else {
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.type === "category") tr.className = "cat-row";
      tr.innerHTML = `
        <td>${r.type === "event" ? "　└ " : ""}${escapeHtml(r.name)}</td>
        <td class="num">${formatDuration(r.seconds)}</td>
        <td class="num">${r.count}</td>
        <td class="num">${r.extendSeconds ? formatDuration(r.extendSeconds) : "—"}</td>
        <td class="num">${r.extendCount || "—"}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  renderSessions(filterByRange(sessions, bounds));
}

function buildGroups(data, showEvents) {
  const cats = data.categories || [];
  const groups = [];
  let evIndex = 0;
  cats.forEach((cat, i) => {
    const color = CAT_PALETTE[i % CAT_PALETTE.length];
    if (showEvents) {
      for (const ev of cat.events || []) {
        groups.push({
          key: `${cat.id}:${ev.id}`,
          label: ev.name,
          color: EVENT_PALETTE[evIndex++ % EVENT_PALETTE.length],
          match: (s) =>
            s.kind === "study" && s.categoryId === cat.id && s.eventId === ev.id,
        });
      }
    } else {
      groups.push({
        key: cat.id,
        label: `${cat.icon || ""} ${cat.name}`.trim(),
        color,
        match: (s) => s.kind === "study" && s.categoryId === cat.id,
      });
    }
  });
  groups.push({
    key: "__other__",
    label: "未分类",
    color: "#b8c2d0",
    match: (s) => s.kind === "study" && !cats.some((c) => c.id === s.categoryId),
  });
  return groups;
}

function renderChart(buckets, groups) {
  const body = root.querySelector("#chartBody");
  const labels = root.querySelector("#chartLabels");
  body.innerHTML = "";
  labels.innerHTML = "";
  const max = Math.max(
    1,
    ...buckets.map((b) => b.values.reduce((a, v) => a + v, 0)),
  );
  const step = Math.max(1, Math.ceil(buckets.length / 14));

  const legend = root.querySelector("#chartLegend");
  legend.innerHTML = groups
    .map(
      (g) =>
        `<span><i class="dot" style="background:${g.color}"></i>${escapeHtml(g.label)}</span>`,
    )
    .join("");

  buckets.forEach((b, i) => {
    const col = document.createElement("div");
    col.className = "chart-col";
    const total = b.values.reduce((a, v) => a + v, 0);
    const parts = groups
      .map((g, gi) =>
        b.values[gi] > 0
          ? `${g.label} ${formatDuration(b.values[gi])}`
          : null,
      )
      .filter(Boolean);
    col.title = `${b.label}${parts.length ? "　" + parts.join("　") : "　无记录"}`;
    const stack = document.createElement("div");
    stack.className = "chart-stack";
    if (total > 0) {
      groups.forEach((g, gi) => {
        const v = b.values[gi];
        if (v <= 0) return;
        const seg = document.createElement("div");
        seg.className = "chart-seg";
        seg.style.height = ((v / max) * 100).toFixed(2) + "%";
        seg.style.background = g.color;
        stack.appendChild(seg);
      });
    }
    col.appendChild(stack);
    body.appendChild(col);

    const lab = document.createElement("div");
    lab.className = "chart-label";
    lab.textContent = i % step === 0 ? b.label : "";
    labels.appendChild(lab);
  });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toDateInput(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function recordGroupKey(ts, mode) {
  const d = new Date(ts || 0);
  if (mode === "year") return `${d.getFullYear()}`;
  if (mode === "month") return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function recordGroupLabel(key, mode) {
  const parts = key.split("-");
  if (mode === "year") return `${parts[0]} 年`;
  if (mode === "month") return `${parts[0]} 年 ${Number(parts[1])} 月`;
  return `${parts[0]} 年 ${Number(parts[1])} 月 ${Number(parts[2])} 日`;
}

function renderSessions(allSessions) {
  const tbody = root.querySelector("#sessionRows");
  const pager = root.querySelector("#recordPager");
  tbody.innerHTML = "";
  const rows = [...(allSessions || [])].sort(
    (a, b) => (b.startedAt || 0) - (a.startedAt || 0),
  );
  const existingIds = new Set(rows.map((s) => s.id));
  for (const id of [...selectedIds]) {
    if (!existingIds.has(id)) selectedIds.delete(id);
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><span class="emoji">📝</span>暂无记录，点右上角可补录</div></td></tr>`;
    if (pager) pager.innerHTML = "";
    updateBatchUi();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / RECORD_PAGE_SIZE));
  if (recordPage > totalPages) recordPage = totalPages;
  if (recordPage < 1) recordPage = 1;
  const start = (recordPage - 1) * RECORD_PAGE_SIZE;
  const pageRows = rows.slice(start, start + RECORD_PAGE_SIZE);

  let lastGroup = null;
  for (const s of pageRows) {
    const key = recordGroupKey(s.startedAt, recordGroup);
    if (key !== lastGroup) {
      lastGroup = key;
      const groupRows = rows.filter(
        (x) => recordGroupKey(x.startedAt, recordGroup) === key,
      );
      const gAgg = aggregate(groupRows);
      const gtr = document.createElement("tr");
      gtr.className = "group-row";
      gtr.innerHTML = `
        <td colspan="7">
          <span class="group-name">${recordGroupLabel(key, recordGroup)}</span>
          <span class="group-meta">${groupRows.length} 条 · ${formatDuration(gAgg.seconds)}</span>
        </td>
      `;
      tbody.appendChild(gtr);
    }
    const tr = document.createElement("tr");
    const isStudy = s.kind === "study";
    const typeName = isStudy ? store.categoryLabel(s.categoryId) : "休息";
    const typeClass = isStudy ? s.categoryId || "study" : "break";
    const evName = isStudy ? store.eventLabel(s.categoryId, s.eventId) || "—" : "休息";
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${s.id}" ${selectedIds.has(s.id) ? "checked" : ""} /></td>
      <td>${fmtDateTime(s.startedAt)}</td>
      <td><span class="session-kind ${typeClass}">${escapeHtml(typeName)}</span></td>
      <td>${escapeHtml(evName)}</td>
      <td class="num">${formatDuration(s.focusedSeconds)}</td>
      <td class="num">${s.extendedSeconds ? formatDuration(s.extendedSeconds) : "—"}</td>
      <td>
        <button class="mini-btn" data-act="edit">编辑</button>
        <button class="mini-btn danger" data-act="del">删除</button>
      </td>
    `;
    tr.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
      if (e.target.checked) selectedIds.add(s.id);
      else selectedIds.delete(s.id);
      updateBatchUi();
    });
    tr.querySelector('[data-act="edit"]').addEventListener("click", () => openSessionForm(s));
    tr.querySelector('[data-act="del"]').addEventListener("click", async () => {
      const ok = await confirmDialog("删除记录", "确定删除这条记录吗？", "删除");
      if (!ok) return;
      selectedIds.delete(s.id);
      await store.actions.deleteSession(s.id);
      showToast("已删除");
    });
    tbody.appendChild(tr);
  }

  renderPager(rows.length, totalPages, start, pageRows.length);
  updateBatchUi();
}

function pageNumbers(current, total) {
  const pages = new Set([1, total]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push("...");
    out.push(p);
    prev = p;
  }
  return out;
}

function renderPager(total, totalPages, start, count) {
  const pager = root.querySelector("#recordPager");
  if (!pager) return;
  pager.innerHTML = "";
  if (totalPages <= 1) {
    pager.innerHTML = `<span class="pager-info">共 ${total} 条</span>`;
    return;
  }
  const info = document.createElement("span");
  info.className = "pager-info";
  info.textContent = `共 ${total} 条 · 第 ${start + 1}-${start + count} 条`;
  pager.appendChild(info);

  const mkBtn = (label, page, disabled, active) => {
    const b = document.createElement("button");
    b.className = "pager-btn" + (active ? " active" : "");
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener("click", () => {
      recordPage = page;
      refresh();
    });
    return b;
  };

  pager.appendChild(mkBtn("‹", recordPage - 1, recordPage <= 1, false));
  for (const p of pageNumbers(recordPage, totalPages)) {
    if (p === "...") {
      const sp = document.createElement("span");
      sp.className = "pager-ellipsis";
      sp.textContent = "…";
      pager.appendChild(sp);
    } else {
      pager.appendChild(mkBtn(String(p), p, false, p === recordPage));
    }
  }
  pager.appendChild(mkBtn("›", recordPage + 1, recordPage >= totalPages, false));
}

function updateBatchUi() {
  const count = selectedIds.size;
  const boxes = [...root.querySelectorAll("#sessionRows input[type=checkbox][data-id]")];
  const pageIds = boxes.map((cb) => cb.dataset.id);
  const pageSelected = pageIds.filter((id) => selectedIds.has(id)).length;
  const countEl = root.querySelector("#selCount");
  if (countEl) countEl.textContent = `已选 ${count} 条`;
  const editBtn = root.querySelector("#batchEdit");
  const delBtn = root.querySelector("#batchDelete");
  if (editBtn) editBtn.disabled = count === 0;
  if (delBtn) delBtn.disabled = count === 0;
  const all = root.querySelector("#sessionSelectAll");
  if (all) {
    all.checked = pageIds.length > 0 && pageSelected === pageIds.length;
    all.indeterminate = pageSelected > 0 && pageSelected < pageIds.length;
  }
}

async function batchDelete() {
  if (!selectedIds.size) return;
  const ok = await confirmDialog(
    "批量删除",
    `确定删除选中的 ${selectedIds.size} 条记录吗？`,
    "删除",
  );
  if (!ok) return;
  await store.actions.deleteSessions([...selectedIds]);
  selectedIds.clear();
  showToast("已删除");
}

async function batchEdit() {
  if (!selectedIds.size) return;
  const cats = store.getData()?.categories || [];
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.textAlign = "left";
  box.style.minWidth = "360px";
  box.innerHTML = `
    <h3 class="modal-title" style="text-align:center">批量修改 ${selectedIds.size} 条记录</h3>
    <div class="form-col" style="margin-top:14px">
      <div class="field">
        <label>类型</label>
        <select id="bKind"><option value="">保持不变</option></select>
      </div>
      <div class="field">
        <label>事件</label>
        <select id="bEvent"><option value="">保持不变</option></select>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn ghost" id="bCancel">取消</button>
      <button class="btn" id="bSave">应用</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  const kindSel = box.querySelector("#bKind");
  const evSel = box.querySelector("#bEvent");
  const breakOpt = document.createElement("option");
  breakOpt.value = "__break__";
  breakOpt.textContent = "☕ 休息";
  kindSel.appendChild(breakOpt);
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.icon || ""} ${c.name}`.trim();
    kindSel.appendChild(o);
  }
  const fillEvents = () => {
    evSel.innerHTML = `<option value="">保持不变</option>`;
    if (kindSel.value && kindSel.value !== "__break__") {
      const cat = store.findCategory(kindSel.value);
      for (const ev of cat?.events || []) {
        const o = document.createElement("option");
        o.value = ev.id;
        o.textContent = ev.name;
        evSel.appendChild(o);
      }
    }
  };
  kindSel.addEventListener("change", fillEvents);

  const close = () => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 180);
  };
  box.querySelector("#bCancel").addEventListener("click", close);
  box.querySelector("#bSave").addEventListener("click", async () => {
    const type = kindSel.value;
    const evId = evSel.value;
    const sessions = (store.getData()?.sessions || [])
      .filter((s) => selectedIds.has(s.id))
      .map((s) => {
        const next = { ...s };
        if (type === "__break__") {
          next.kind = "break";
          next.categoryId = null;
          next.eventId = null;
        } else if (type) {
          next.kind = "study";
          next.categoryId = type;
          if (evId) next.eventId = evId;
          else if (next.eventId && !store.findEvent(type, next.eventId)) next.eventId = null;
        }
        return next;
      });
    await store.actions.saveSessions(sessions);
    showToast("已修改");
    close();
  });
}

function openSessionForm(existing) {
  const data = store.getData();
  const cats = data?.categories || [];
  const s = existing || {
    id: uid("s"),
    kind: "study",
    categoryId: cats[0]?.id || null,
    eventId: cats[0]?.events?.[0]?.id || null,
    startedAt: Date.now(),
    focusedSeconds: 25 * 60,
    extendedSeconds: 0,
    extendedCount: 0,
    pausedSeconds: 0,
    completed: true,
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  box.style.textAlign = "left";
  box.style.minWidth = "380px";
  box.innerHTML = `
    <h3 class="modal-title" style="text-align:center">${existing ? "编辑记录" : "补录记录"}</h3>
    <div class="form-col" style="margin-top:14px">
      <div class="field">
        <label>类型</label>
        <select id="sKind"></select>
      </div>
      <div id="sStudyFields">
        <div class="field">
          <label>事件</label>
          <select id="sEvent"></select>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>开始时间</label>
        <input type="datetime-local" id="sTime" value="${toLocalInput(s.startedAt)}" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
        <div class="field"><label>时长（分钟）</label><input type="number" id="sDur" min="0" max="1440" value="${Math.round((s.focusedSeconds || 0) / 60)}" /></div>
        <div class="field"><label>暂停（分钟）</label><input type="number" id="sPause" min="0" max="1440" value="${Math.round((s.pausedSeconds || 0) / 60)}" /></div>
        <div class="field"><label>延长（分钟）</label><input type="number" id="sExt" min="0" max="1440" value="${Math.round((s.extendedSeconds || 0) / 60)}" /></div>
        <div class="field"><label>延长次数</label><input type="number" id="sExtCount" min="0" max="99" value="${s.extendedCount || 0}" /></div>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn ghost" id="sCancel">取消</button>
      <button class="btn" id="sSave">保存</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  const kindSel = box.querySelector("#sKind");
  const evSel = box.querySelector("#sEvent");
  const studyFields = box.querySelector("#sStudyFields");

  const breakOpt = document.createElement("option");
  breakOpt.value = "__break__";
  breakOpt.textContent = "☕ 休息";
  kindSel.appendChild(breakOpt);
  for (const c of cats) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.icon || ""} ${c.name}`.trim();
    kindSel.appendChild(o);
  }
  kindSel.value = s.kind === "study" ? s.categoryId || cats[0]?.id || "" : "__break__";

  const fillEvents = () => {
    evSel.innerHTML = "";
    if (kindSel.value && kindSel.value !== "__break__") {
      const cat = store.findCategory(kindSel.value);
      for (const ev of cat?.events || []) {
        const o = document.createElement("option");
        o.value = ev.id;
        o.textContent = ev.name;
        evSel.appendChild(o);
      }
      if (s.eventId && cat?.events?.some((e) => e.id === s.eventId)) evSel.value = s.eventId;
    }
  };
  const syncKind = () => {
    const isStudy = kindSel.value !== "__break__";
    studyFields.style.display = isStudy ? "" : "none";
    if (isStudy) fillEvents();
  };
  kindSel.addEventListener("change", syncKind);
  syncKind();

  const close = () => {
    overlay.classList.remove("show");
    setTimeout(() => overlay.remove(), 180);
  };
  box.querySelector("#sCancel").addEventListener("click", close);
  box.querySelector("#sSave").addEventListener("click", async () => {
    const type = kindSel.value;
    const isStudy = type !== "__break__";
    const duration = Math.max(0, Math.round(Number(box.querySelector("#sDur").value) * 60));
    const paused = Math.max(0, Math.round(Number(box.querySelector("#sPause").value) * 60));
    const ext = Math.max(0, Math.round(Number(box.querySelector("#sExt").value) * 60));
    const extCount = Math.max(0, Math.round(Number(box.querySelector("#sExtCount").value) || 0));
    const startedAt = new Date(box.querySelector("#sTime").value).getTime() || Date.now();
    const session = {
      id: s.id,
      kind: isStudy ? "study" : "break",
      categoryId: isStudy ? type || null : null,
      eventId: isStudy ? evSel.value || null : null,
      startedAt,
      endedAt: startedAt + (duration + paused) * 1000,
      plannedSeconds: Math.max(0, duration - ext),
      focusedSeconds: duration,
      pausedSeconds: paused,
      extendedSeconds: ext,
      extendedCount: extCount,
      completed: existing?.completed ?? true,
    };
    await store.actions.saveSession(session);
    showToast(existing ? "已保存" : "已补录");
    close();
  });
}
