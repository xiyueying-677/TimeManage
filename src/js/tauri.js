const T = window.__TAURI__;

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isAndroid = /Android/i.test(ua);
export const isDesktop = !isAndroid;

export function hasTauri() {
  return !!T;
}

export function invoke(cmd, args) {
  if (!T) return Promise.reject(new Error("Tauri API 不可用"));
  return T.core.invoke(cmd, args);
}

export function listen(event, handler) {
  if (!T) return Promise.resolve(() => {});
  return T.event.listen(event, handler);
}

export function emit(event, payload) {
  if (!T) return Promise.resolve();
  return T.event.emit(event, payload);
}

export function currentWindow() {
  return T.window.getCurrentWindow();
}

export async function setWindowSize(width, height) {
  if (!T) return;
  const win = T.window.getCurrentWindow();
  const size = new T.dpi.LogicalSize(width, height);
  await win.setSize(size);
}

export async function startResizeDragging(direction) {
  if (!T) return;
  await T.window.getCurrentWindow().startResizeDragging(direction);
}
