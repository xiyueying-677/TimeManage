import test from "node:test";
import assert from "node:assert/strict";

import {
  daysBetween,
  daysUntil,
  nextOccurrence,
  occursOn,
  monthMatrix,
  sortUpcoming,
  toKey,
} from "./calendar.js";

const today = new Date(2026, 2, 15);

test("daysBetween counts whole days", () => {
  assert.equal(daysBetween(today, new Date(2026, 2, 20)), 5);
  assert.equal(daysBetween(new Date(2026, 2, 20), today), -5);
  assert.equal(daysBetween(today, today), 0);
});

test("non-recurring countdown keeps fixed date", () => {
  const c = { date: "2026-06-07", recurring: "none" };
  assert.equal(daysUntil(c, today), daysBetween(today, new Date(2026, 5, 7)));
});

test("yearly countdown rolls to next year after passing", () => {
  const c = { date: "2026-01-01", recurring: "yearly" };
  const next = nextOccurrence(c, today);
  assert.equal(next.getFullYear(), 2027);
  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
});

test("yearly countdown stays this year when upcoming", () => {
  const c = { date: "2026-12-25", recurring: "yearly" };
  assert.equal(nextOccurrence(c, today).getFullYear(), 2026);
});

test("feb 29 yearly falls back to feb 28", () => {
  const c = { date: "2024-02-29", recurring: "yearly" };
  const next = nextOccurrence(c, new Date(2026, 0, 1));
  assert.equal(next.getMonth(), 1);
  assert.equal(next.getDate(), 28);
});

test("occursOn matches yearly month and day", () => {
  const c = { date: "2000-03-15", recurring: "yearly" };
  assert.ok(occursOn(c, new Date(2030, 2, 15)));
  assert.ok(!occursOn(c, new Date(2030, 2, 16)));
});

test("monthMatrix returns 6 weeks of 7 days", () => {
  const m = monthMatrix(2026, 2);
  assert.equal(m.length, 6);
  assert.equal(m[0].length, 7);
  assert.equal(toKey(m[0][0].date), "2026-02-23");
});

test("sortUpcoming orders by remaining days", () => {
  const list = [
    { id: "b", date: "2026-12-01", recurring: "none" },
    { id: "a", date: "2026-03-20", recurring: "none" },
  ];
  const sorted = sortUpcoming(list, today);
  assert.equal(sorted[0].countdown.id, "a");
  assert.equal(sorted[0].days, 5);
});
