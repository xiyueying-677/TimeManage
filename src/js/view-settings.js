import * as store from "./store.js";
import { invoke, isAndroid } from "./tauri.js";
import { showToast, confirmDialog, showModal } from "./modal.js";
import { playChime } from "./audio.js";

let root = null;
let built = false;
let dataDir = "";
let syncInfo = null;
let syncBusy = false;

export async function mount(el) {
  root = el;
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h2>设置</h2>
        <div class="desc">按你的节奏来调整</div>
      </div>
    </div>
    <div class="settings-grid">
      <div class="card">
        <h3>⏱ 计时</h3>
        <div class="form-row">
          <div>学习时长<div class="desc">一轮专注的分钟数</div></div>
          <input type="number" id="sStudy" min="1" max="180" />
        </div>
        <div class="form-row">
          <div>休息时长<div class="desc">一轮休息的分钟数</div></div>
          <input type="number" id="sBreak" min="1" max="120" />
        </div>
        <div class="form-row">
          <div>循环次数<div class="desc">每天计划完成的轮数</div></div>
          <input type="number" id="sCycles" min="1" max="24" />
        </div>
        <div class="form-row">
          <div>自动进入下一阶段<div class="desc">结束后自动开始休息 / 下一轮</div></div>
          <div class="switch" id="sAuto"></div>
        </div>
        <div class="desc" style="font-size:12px;color:var(--text-faint);margin-top:10px">
          这里是全局默认值。可在「番茄钟」页为每个大类下的每个事件单独设置并记住。
        </div>
      </div>

      <div class="card">
        <h3>🎯 事件自定义</h3>
        <div class="form-col" id="eventConfigList"></div>
      </div>

      <div class="card">
        <h3>➕ 延长</h3>
        <div class="form-row">
          <div>学习延长<div class="desc">每次延长的分钟数</div></div>
          <input type="number" id="sExtStudy" min="1" max="60" />
        </div>
        <div class="form-row">
          <div>休息延长<div class="desc">每次延长的分钟数</div></div>
          <input type="number" id="sExtBreak" min="1" max="60" />
        </div>
      </div>

      <div class="card">
        <h3>🔔 提醒</h3>
        <div class="form-row">
          <div>提示音<div class="desc">结束时播放温和提示音</div></div>
          <div class="switch" id="sSound"></div>
        </div>
        <div class="form-row">
          <div>音量</div>
          <input type="range" id="sVolume" min="0" max="100" style="width:150px" />
        </div>
        <div class="form-row">
          <div></div>
          <button class="btn ghost small" id="sTestSound">试听</button>
        </div>
      </div>

      <div class="card">
        <h3>💾 数据</h3>
        <div class="form-col">
          <div class="field" id="sDataDirRow">
            <label>数据文件夹</label>
            <div class="data-path" id="sDataDir">读取中…</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap" id="sFileActions">
            <button class="btn ghost small" id="sOpenDir">打开文件夹</button>
            <button class="btn soft small" id="sExport">导出数据</button>
            <button class="btn soft small" id="sImport">导入数据</button>
          </div>
          <div class="desc" style="font-size:12px;color:var(--text-faint)" id="sDataHint">
            导出的 JSON 文件可在桌面版与手机版之间互相导入；重复导入只增不删。
          </div>
        </div>
      </div>

      <div class="card">
        <h3>🔄 局域网同步</h3>
        <div class="form-col">
          <div class="form-row">
            <div>同步方式<div class="desc" id="sSyncDesc">关闭后不使用网络</div></div>
            <select id="sSyncMode" class="sync-select">
              <option value="off">关闭</option>
              <option value="host">本机作为主机</option>
              <option value="guest">连接另一台设备</option>
            </select>
          </div>

          <div id="sSyncHostBox" style="display:none">
            <div class="form-row">
              <div>监听端口</div>
              <input type="number" id="sSyncPortHost" min="1024" max="65535" class="sync-port" />
            </div>
            <div class="field">
              <label>本机局域网地址</label>
              <div class="data-path sync-addresses" id="sSyncAddresses">检测中…</div>
            </div>
            <div class="form-row">
              <div>配对码<div class="desc">把地址、端口和这 6 位数字填到另一台设备</div></div>
              <input type="text" id="sSyncTokenHost" maxlength="6" inputmode="numeric" class="sync-token" />
            </div>
            <div><button class="btn ghost small" id="sSyncRegen">重新生成配对码</button></div>
          </div>

          <div id="sSyncGuestBox" style="display:none">
            <div class="form-row">
              <div>主机地址<div class="desc">对方手机或电脑的局域网 IP</div></div>
              <input type="text" id="sSyncHost" placeholder="192.168.1.10" class="sync-host" />
            </div>
            <div class="form-row">
              <div>端口</div>
              <input type="number" id="sSyncPortGuest" min="1024" max="65535" class="sync-port" />
            </div>
            <div class="form-row">
              <div>配对码</div>
              <input type="text" id="sSyncTokenGuest" maxlength="6" inputmode="numeric" class="sync-token" />
            </div>
            <div class="form-row">
              <div>打开应用时自动同步<div class="desc">应用启动后自动拉取一次</div></div>
              <div class="switch" id="sSyncAuto"></div>
            </div>
          </div>

          <div class="desc" id="sSyncStatus" style="font-size:12px">未开启</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn soft small" id="sSyncApply">保存并应用</button>
            <button class="btn ghost small" id="sSyncNow">立即同步</button>
          </div>
          <div class="desc" style="font-size:12px;color:var(--text-faint)">
            同一 Wi-Fi 或手机热点下使用；同步只增不删，不会覆盖任何一端独有的记录。同步期间请保持应用打开。
          </div>
        </div>
      </div>

      <div class="card">
        <h3>🍅 关于</h3>
        <div class="form-col">
          <div>时间管理 · 番茄钟 + 倒计时日历</div>
          <div class="desc" style="font-size:12px;color:var(--text-faint)" id="sAboutData">
            数据保存在本机；局域网同步仅在手动开启后使用本地网络。
          </div>
          <div><span class="badge-soon">v0.1.0</span></div>
        </div>
      </div>
    </div>
  `;
  bind();
  applyPlatformLayout();
  built = true;
  try {
    dataDir = await invoke("get_data_dir");
  } catch {
    dataDir = "未知";
  }
  refresh();
}

function applyPlatformLayout() {
  if (!isAndroid) return;
  // 手机端没有可浏览的程序目录；导入/导出走系统文件选择器
  const pathRow = root.querySelector("#sDataDirRow");
  if (pathRow) pathRow.style.display = "none";
  const openDir = root.querySelector("#sOpenDir");
  if (openDir) openDir.style.display = "none";
  const hint = root.querySelector("#sDataHint");
  if (hint) hint.textContent = "导出的 JSON 可在手机与电脑之间迁移；重复导入只增不删。";
  const about = root.querySelector("#sAboutData");
  if (about) about.textContent = "数据保存在本机；局域网同步仅在手动开启后使用本地网络。";
}

function syncMode() {
  return root.querySelector("#sSyncMode").value;
}

function toggleSyncFields() {
  const mode = syncMode();
  root.querySelector("#sSyncHostBox").style.display = mode === "host" ? "" : "none";
  root.querySelector("#sSyncGuestBox").style.display = mode === "guest" ? "" : "none";
  const desc = root.querySelector("#sSyncDesc");
  if (desc) {
    desc.textContent =
      mode === "host"
        ? "等待另一台设备连接本机"
        : mode === "guest"
          ? "连接另一台设备的主机服务"
          : "关闭后不使用网络";
  }
}

function formatSyncTime(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setSyncField(selector, value) {
  const field = root.querySelector(selector);
  if (!field) return;
  if (document.activeElement === field) return;
  field.value = value ?? "";
}

function applySyncInfoToForm(info) {
  if (!info) return;
  syncInfo = info;
  const config = info.config || {};
  const mode = config.mode || "off";
  setSyncField("#sSyncMode", mode);
  setSyncField("#sSyncPortHost", config.port ?? 18923);
  setSyncField("#sSyncPortGuest", config.port ?? 18923);
  setSyncField("#sSyncTokenHost", config.token || "");
  setSyncField("#sSyncTokenGuest", config.token || "");
  setSyncField("#sSyncHost", config.host || "");
  root.querySelector("#sSyncAuto").classList.toggle("on", !!config.autoSync);
  toggleSyncFields();

  const port = config.port ?? 18923;
  const addresses = info.addresses || [];
  root.querySelector("#sSyncAddresses").textContent = addresses.length
    ? addresses.map((address) => `${address}:${port}`).join("\n")
    : "未检测到局域网地址；请确认已连接 Wi-Fi 或手机热点";

  let status = "同步已关闭";
  if (mode === "host") {
    status = info.running
      ? `主机运行中 · 端口 ${port} · 等待对方连接`
      : `主机未运行${config.lastError ? "：" + config.lastError : ""}`;
  } else if (mode === "guest") {
    status = `目标 ${config.host || "未填写"}:${port}`;
    status += config.lastSyncAt
      ? ` · 上次同步 ${formatSyncTime(config.lastSyncAt)}`
      : " · 尚未同步";
    if (config.lastError) status += ` · 失败：${config.lastError}`;
  }
  root.querySelector("#sSyncStatus").textContent = status;
  root.querySelector("#sSyncNow").disabled = syncBusy || mode !== "guest";
  root.querySelector("#sSyncRegen").disabled = syncBusy || mode !== "host";
  root.querySelector("#sSyncApply").disabled = syncBusy;
}

async function refreshSync() {
  if (!built) return;
  try {
    const info = await invoke("sync_info");
    applySyncInfoToForm(info);
  } catch (err) {
    const status = root.querySelector("#sSyncStatus");
    if (status) status.textContent = "读取同步状态失败：" + String(err);
  }
}

function readSyncForm() {
  const mode = syncMode();
  const port = Number(
    mode === "guest"
      ? root.querySelector("#sSyncPortGuest").value
      : root.querySelector("#sSyncPortHost").value,
  );
  const host = mode === "guest" ? root.querySelector("#sSyncHost").value.trim() : "";
  const token =
    mode === "guest"
      ? root.querySelector("#sSyncTokenGuest").value.trim()
      : mode === "host"
        ? root.querySelector("#sSyncTokenHost").value.trim()
        : syncInfo?.config?.token || "";
  const autoSync = mode === "guest" && root.querySelector("#sSyncAuto").classList.contains("on");
  if (mode !== "off" && !/^\d{6}$/.test(token)) {
    throw new Error("配对码必须是 6 位数字");
  }
  if (mode === "guest" && !host) {
    throw new Error("请填写主机地址，例如 192.168.1.10");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("端口必须在 1024 到 65535 之间");
  }
  return { mode, port, host, token, autoSync };
}

async function applySyncConfig() {
  if (syncBusy) return;
  let config;
  try {
    config = readSyncForm();
  } catch (err) {
    showToast(String(err.message || err));
    return;
  }
  syncBusy = true;
  try {
    const info = await invoke("sync_apply", { config });
    applySyncInfoToForm(info);
    showToast(
      config.mode === "host"
        ? "同步主机已开启"
        : config.mode === "guest"
          ? "同步配置已保存"
          : "同步已关闭",
    );
  } catch (err) {
    showModal({ title: "同步设置失败", message: String(err), icon: "😢" });
    await refreshSync();
  } finally {
    syncBusy = false;
    await refreshSync();
  }
}

async function regenerateSyncToken() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    const info = await invoke("sync_regenerate_token");
    applySyncInfoToForm(info);
    showToast("配对码已更新");
  } catch (err) {
    showModal({ title: "更新配对码失败", message: String(err), icon: "😢" });
  } finally {
    syncBusy = false;
    await refreshSync();
  }
}

async function syncNow() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    const result = await invoke("sync_now");
    await store.loadData();
    refresh();
    const stats = result.stats || {};
    showToast(`同步完成：新增 ${stats.added || 0} 条，更新 ${stats.updated || 0} 条`);
  } catch (err) {
    showModal({ title: "同步失败", message: String(err), icon: "😢" });
  } finally {
    syncBusy = false;
    await refreshSync();
  }
}

function bind() {
  const num = (id, key, min, max) => {
    root.querySelector(id).addEventListener("change", (e) => {
      let v = Math.round(Number(e.target.value));
      if (!Number.isFinite(v)) v = min;
      v = Math.max(min, Math.min(max, v));
      store.actions.updateSettings({ [key]: v });
      e.target.value = v;
    });
  };
  num("#sStudy", "studyMinutes", 1, 180);
  num("#sBreak", "breakMinutes", 1, 120);
  num("#sCycles", "cycles", 1, 24);
  num("#sExtStudy", "extendStudyMinutes", 1, 60);
  num("#sExtBreak", "extendBreakMinutes", 1, 60);

  root.querySelector("#sAuto").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    store.actions.updateSettings({ autoStartNext: on });
  });
  root.querySelector("#sSound").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("on");
    e.currentTarget.classList.toggle("on", on);
    store.actions.updateSettings({ soundEnabled: on });
  });
  root.querySelector("#sVolume").addEventListener("input", (e) => {
    const v = Number(e.target.value) / 100;
    store.actions.updateSettings({ soundVolume: v });
  });
  root.querySelector("#sTestSound").addEventListener("click", () => {
    const s = store.getData()?.settings || {};
    playChime("study", s.soundVolume ?? 0.5);
  });

  root.querySelector("#sOpenDir").addEventListener("click", async () => {
    try {
      await invoke("open_data_dir");
    } catch (err) {
      showToast("打开失败：" + err);
    }
  });
  root.querySelector("#sExport").addEventListener("click", async () => {
    try {
      const path = await invoke("export_data");
      if (path) showToast(isAndroid ? "已导出" : "已导出到：" + path);
    } catch (err) {
      showToast("导出失败：" + err);
    }
  });
  root.querySelector("#sImport").addEventListener("click", async () => {
    const ok = await confirmDialog(
      "导入数据",
      "导入会把文件中的记录与当前数据按 id 合并（只增不删，同 id 取较新内容），任何一端独有的记录都会保留，确定继续吗？",
      "导入",
    );
    if (!ok) return;
    try {
      const next = await invoke("import_data");
      if (next) {
        await store.loadData();
        refresh();
        showToast("导入成功");
      }
    } catch (err) {
      showModal({ title: "导入失败", message: String(err), icon: "😢" });
    }
  });

  root.querySelector("#sSyncMode").addEventListener("change", toggleSyncFields);
  for (const selector of ["#sSyncTokenHost", "#sSyncTokenGuest"]) {
    root.querySelector(selector).addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
    });
  }
  root.querySelector("#sSyncAuto").addEventListener("click", (event) => {
    event.currentTarget.classList.toggle("on");
  });
  root.querySelector("#sSyncApply").addEventListener("click", applySyncConfig);
  root.querySelector("#sSyncRegen").addEventListener("click", regenerateSyncToken);
  root.querySelector("#sSyncNow").addEventListener("click", syncNow);
}

export function refresh() {
  if (!built) return;
  const s = store.getData()?.settings;
  if (!s) return;
  root.querySelector("#sStudy").value = s.studyMinutes ?? 25;
  root.querySelector("#sBreak").value = s.breakMinutes ?? 5;
  root.querySelector("#sCycles").value = s.cycles ?? 4;
  root.querySelector("#sExtStudy").value = s.extendStudyMinutes ?? 5;
  root.querySelector("#sExtBreak").value = s.extendBreakMinutes ?? 1;
  root.querySelector("#sAuto").classList.toggle("on", !!s.autoStartNext);
  root.querySelector("#sSound").classList.toggle("on", s.soundEnabled !== false);
  root.querySelector("#sVolume").value = Math.round((s.soundVolume ?? 0.5) * 100);
  root.querySelector("#sDataDir").textContent = dataDir || "读取中…";
  renderEventConfigList();
  refreshSync().catch(() => {});
}

function renderEventConfigList() {
  const wrap = root.querySelector("#eventConfigList");
  if (!wrap) return;
  const configs = store.getData()?.eventConfigs || {};
  const keys = Object.keys(configs);
  wrap.innerHTML = "";
  if (!keys.length) {
    wrap.innerHTML = `<div class="desc" style="font-size:12.5px;color:var(--text-faint)">还没有单独设置的事件，全部使用上面的全局默认。</div>`;
    return;
  }
  for (const key of keys) {
    const [catId, evId] = key.split("|");
    const cat = store.findCategory(catId);
    const ev = store.findEvent(catId, evId);
    const row = document.createElement("div");
    row.className = "form-row";
    const label = document.createElement("div");
    label.textContent = `${cat?.icon || ""} ${cat?.name || catId} · ${ev?.name || evId}`.trim();
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.textContent = "清除";
    btn.addEventListener("click", async () => {
      await store.actions.clearEventConfig(catId, evId);
      showToast("已清除");
    });
    row.appendChild(label);
    row.appendChild(btn);
    wrap.appendChild(row);
  }
}
