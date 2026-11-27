import test from "node:test";
import assert from "node:assert/strict";

import {
  rangeBounds,
  summarize,
  aggregate,
  breakdown,
  filterByRange,
  shiftRef,
  seriesByGroup,
} from "./stats.js";

function at(y, m, d, h = 12) {
  return new Date(y, m - 1, d, h, 0, 0).getTime();
}

const sessions = [
  { kind: "study", categoryId: "study", eventId: "e_java", startedAt: at(2026, 3, 2), focusedSeconds: 1500, extendedSeconds: 300, extendedCount: 1, pausedSeconds: 60 },
  { kind: "study", categoryId: "study", eventId: "e_java", startedAt: at(2026, 3, 2, 15), focusedSeconds: 1200, extendedSeconds: 0, extendedCount: 0, pausedSeconds: 0 },
  { kind: "study", categoryId: "study", eventId: "e_python", startedAt: at(2026, 3, 3), focusedSeconds: 1800, extendedSeconds: 0, extendedCount: 0, pausedSeconds: 0 },
  { kind: "break", startedAt: at(2026, 3, 2, 13), focusedSeconds: 300, extendedSeconds: 0, extendedCount: 0, pausedSeconds: 0 },
  { kind: "study", categoryId: "life", eventId: "e_cook", startedAt: at(2026, 4, 10), focusedSeconds: 600, extendedSeconds: 120, extendedCount: 2, pausedSeconds: 0 },
];

const categories = [
  { id: "study", name: "学习", icon: "📚", events: [{ id: "e_java", name: "Java" }, { id: "e_python", name: "Python" }] },
  { id: "life", name: "生活", icon: "🏠", events: [{ id: "e_cook", name: "做饭" }] },
];

test("rangeBounds day covers only that day", () => {
  const b = rangeBounds("day", new Date(2026, 2, 2));
  const inRange = filterByRange(sessions, b);
  assert.equal(inRange.length, 3);
});

test("rangeBounds week starts on Monday", () => {
  const b = rangeBounds("week", new Date(2026, 2, 4));
  const s = new Date(b.start);
  assert.equal(s.getDay(), 1);
});

test("shiftRef moves month across year boundary", () => {
  const r = shiftRef("month", new Date(2026, 11, 15), 1);
  assert.equal(r.getFullYear(), 2027);
  assert.equal(r.getMonth(), 0);
});

test("summarize splits study and break", () => {
  const b = rangeBounds("month", new Date(2026, 2, 1));
  const r = summarize(sessions, b);
  assert.equal(r.study.count, 3);
  assert.equal(r.study.seconds, 1500 + 1200 + 1800);
  assert.equal(r.break.count, 1);
  assert.equal(r.break.seconds, 300);
  assert.equal(r.study.extendSeconds, 300);
  assert.equal(r.study.extendCount, 1);
});

test("aggregate sums extension stats", () => {
  const agg = aggregate([sessions[4]]);
  assert.equal(agg.seconds, 600);
  assert.equal(agg.extendSeconds, 120);
  assert.equal(agg.extendCount, 2);
});

test("breakdown groups by category and event", () => {
  const b = rangeBounds("year", new Date(2026, 5, 1));
  const { rows, breakAgg } = breakdown(sessions, b, categories);
  const studyRow = rows.find((r) => r.type === "category" && r.id === "study");
  assert.equal(studyRow.count, 3);
  assert.equal(studyRow.seconds, 4500);
  const javaRow = rows.find((r) => r.type === "event" && r.id === "e_java");
  assert.equal(javaRow.count, 2);
  assert.equal(javaRow.seconds, 2700);
  assert.equal(breakAgg.count, 1);
});

test("breakdown ignores categories with no sessions", () => {
  const b = rangeBounds("day", new Date(2026, 2, 3));
  const { rows } = breakdown(sessions, b, categories);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes("study"));
  assert.ok(!ids.includes("life"));
});

const groups = [
  { key: "study", match: (s) => s.kind === "study" },
  { key: "break", match: (s) => s.kind !== "study" },
];

test("seriesByGroup buckets by hour for a day", () => {
  const s = seriesByGroup(sessions, "day", new Date(2026, 2, 2), groups);
  assert.equal(s.length, 24);
  assert.equal(s[12].values[0], 1500);
  assert.equal(s[15].values[0], 1200);
  assert.equal(s[13].values[1], 300);
  assert.equal(s[0].values[0], 0);
});

test("seriesByGroup buckets by weekday for a week", () => {
  const s = seriesByGroup(sessions, "week", new Date(2026, 2, 2), groups);
  assert.equal(s.length, 7);
  assert.equal(s[0].label, "一");
  assert.equal(s[0].values[0], 1500 + 1200);
  assert.equal(s[1].values[0], 1800);
});

test("seriesByGroup buckets by month for a year", () => {
  const s = seriesByGroup(sessions, "year", new Date(2026, 5, 1), groups);
  assert.equal(s.length, 12);
  assert.equal(s[2].values[0], 1500 + 1200 + 1800);
  assert.equal(s[3].values[0], 600);
});

test("seriesByGroup total spans 12 months", () => {
  const s = seriesByGroup(sessions, "total", new Date(2026, 5, 1), groups);
  assert.equal(s.length, 12);
  const total = s.reduce((acc, b) => acc + b.values[0], 0);
  assert.equal(total, 1500 + 1200 + 1800 + 600);
});

test("seriesByGroup splits by custom groups", () => {
  const g = [
    { key: "java", match: (s) => s.eventId === "e_java" },
    { key: "other", match: () => true },
  ];
  const s = seriesByGroup(sessions, "day", new Date(2026, 2, 2), g);
  assert.equal(s[12].values[0], 1500);
  assert.equal(s[15].values[0], 1200);
  assert.equal(s[13].values[1], 300);
});
