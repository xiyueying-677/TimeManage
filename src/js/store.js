import { invoke, listen } from "./tauri.js";

let data = null;
const listeners = new Set();

export async function loadData() {
  data = await invoke("load_data");
  notify();
  return data;
}

// 托盘/悬浮窗等辅助窗口可能在 Tauri 的 AppState manage 之前就开始加载；
// 首次 load_data 会瞬态失败，需要重试才能拿到数据并完成渲染。
export async function loadDataWithRetry(attempts = 30, delayMs = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await loadData();
    } catch (err) {
      lastError = err;
      if (attempt < 3) console.warn("首次数据加载失败，正在重试", err);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function getData() {
  return data;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of [...listeners]) fn(data);
}

let syncStarted = false;
export async function initDataSync() {
  if (syncStarted) return;
  syncStarted = true;
  await listen("data:changed", () => {
    loadData().catch(() => {});
  });
}

export const actions = {
  setSelection: (categoryId, eventId, mode, countdownMinutes) =>
    invoke("set_selection", { categoryId, eventId, mode, countdownMinutes }),
  addEvent: (categoryId, name) => invoke("add_event", { categoryId, name }),
  deleteEvent: (categoryId, eventId) =>
    invoke("delete_event", { categoryId, eventId }),
  saveCountdown: (countdown) => invoke("save_countdown", { countdown }),
  deleteCountdown: (id) => invoke("delete_countdown", { id }),
  saveSession: (session) => invoke("save_session", { session }),
  deleteSession: (id) => invoke("delete_session", { id }),
  saveSessions: (sessions) => invoke("save_sessions", { sessions }),
  deleteSessions: (ids) => invoke("delete_sessions", { ids }),
  setFloatUi: (label, patch) => invoke("set_float_ui", { label, patch }),
  setEventConfig: (categoryId, eventId, patch) =>
    invoke("set_event_config", { categoryId, eventId, patch }),
  clearEventConfig: (categoryId, eventId) =>
    invoke("clear_event_config", { categoryId, eventId }),
  updateSettings: (settings) => invoke("update_settings", { settings }),
};

export function findCategory(id) {
  return data?.categories?.find((c) => c.id === id) || null;
}

export function findEvent(catId, evId) {
  return findCategory(catId)?.events?.find((e) => e.id === evId) || null;
}

export function categoryLabel(id) {
  return findCategory(id)?.name || "未分类";
}

export function eventLabel(catId, evId) {
  return findEvent(catId, evId)?.name || "";
}

export function defaultSettings() {
  return {
    studyMinutes: 25,
    breakMinutes: 5,
    cycles: 4,
    extendStudyMinutes: 5,
    extendBreakMinutes: 1,
    autoStartNext: false,
    soundEnabled: true,
    soundVolume: 0.5,
    theme: "sweet",
  };
}

export function effectiveSettings(categoryId, eventId) {
  const base = { ...defaultSettings(), ...(data?.settings || {}) };
  if (categoryId && eventId) {
    const cfg = data?.eventConfigs?.[`${categoryId}|${eventId}`];
    if (cfg) Object.assign(base, cfg);
  }
  return base;
}

export function hasEventConfig(categoryId, eventId) {
  if (!categoryId || !eventId) return false;
  return !!data?.eventConfigs?.[`${categoryId}|${eventId}`];
}
