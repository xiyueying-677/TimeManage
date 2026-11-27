import { invoke, listen } from "./tauri.js";

export const timer = {
  state: () => invoke("timer_state"),
  start: (categoryId, eventId, mode, countdownMinutes) =>
    invoke("start_timer", { categoryId, eventId, mode, countdownMinutes }),
  pause: () => invoke("pause_timer"),
  resume: () => invoke("resume_timer"),
  extendStudy: () => invoke("extend_study"),
  extendBreak: () => invoke("extend_break"),
  endEarly: () => invoke("end_phase_early"),
  startBreak: () => invoke("start_break"),
  nextStudy: () => invoke("next_study"),
  stop: () => invoke("stop_timer"),
};

export function onTick(handler) {
  const un = [];
  listen("timer:tick", (e) => handler(e.payload)).then((u) => un.push(u));
  return () => un.forEach((u) => u());
}

export function onFinished(handler) {
  const un = [];
  listen("timer:finished", (e) => handler(e.payload)).then((u) => un.push(u));
  return () => un.forEach((u) => u());
}

export function onCountdownDue(handler) {
  const un = [];
  listen("countdown:due", (e) => handler(e.payload)).then((u) => un.push(u));
  return () => un.forEach((u) => u());
}

export function onFloatChanged(handler) {
  const un = [];
  listen("float:changed", (e) => handler(e.payload)).then((u) => un.push(u));
  return () => un.forEach((u) => u());
}
