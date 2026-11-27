export const RANGES = ["day", "week", "month", "year", "total"];

export const RANGE_LABELS = {
  day: "日",
  week: "周",
  month: "月",
  year: "年",
  total: "总计",
};

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function addYears(d, n) {
  const x = new Date(d);
  x.setFullYear(x.getFullYear() + n);
  return x;
}

export function startOfWeekDate(d) {
  const day = (d.getDay() + 6) % 7;
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - day);
  return s;
}

export function rangeBounds(range, ref = new Date()) {
  const d = ref instanceof Date ? ref : new Date(ref);
  if (range === "day") {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return { start: s.getTime(), end: addDays(s, 1).getTime() };
  }
  if (range === "week") {
    const s = startOfWeekDate(d);
    return { start: s.getTime(), end: addDays(s, 7).getTime() };
  }
  if (range === "month") {
    const s = new Date(d.getFullYear(), d.getMonth(), 1);
    return { start: s.getTime(), end: addMonths(s, 1).getTime() };
  }
  if (range === "year") {
    const s = new Date(d.getFullYear(), 0, 1);
    return { start: s.getTime(), end: addYears(s, 1).getTime() };
  }
  return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
}

export function rangeLabel(range, ref = new Date()) {
  const d = ref instanceof Date ? ref : new Date(ref);
  const p = (n) => String(n).padStart(2, "0");
  if (range === "day") return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (range === "week") {
    const b = rangeBounds("week", d);
    const s = new Date(b.start);
    const e = new Date(b.end - 1);
    return `${s.getMonth() + 1}/${s.getDate()} - ${e.getMonth() + 1}/${e.getDate()}`;
  }
  if (range === "month") return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
  if (range === "year") return `${d.getFullYear()} 年`;
  return "全部时间";
}

export function shiftRef(range, ref, delta) {
  const d = new Date(ref);
  if (range === "day") return addDays(d, delta);
  if (range === "week") return addDays(d, delta * 7);
  if (range === "month") return addMonths(d, delta);
  if (range === "year") return addYears(d, delta);
  return d;
}

export function filterByRange(sessions, bounds) {
  return (sessions || []).filter(
    (s) => (s.startedAt ?? 0) >= bounds.start && (s.startedAt ?? 0) < bounds.end,
  );
}

function emptyBucket() {
  return { seconds: 0, count: 0, extendSeconds: 0, extendCount: 0, pausedSeconds: 0 };
}

export function aggregate(sessions) {
  const bucket = emptyBucket();
  for (const s of sessions || []) {
    bucket.seconds += s.focusedSeconds || 0;
    bucket.count += 1;
    bucket.extendSeconds += s.extendedSeconds || 0;
    bucket.extendCount += s.extendedCount || 0;
    bucket.pausedSeconds += s.pausedSeconds || 0;
  }
  return bucket;
}

export function summarize(sessions, bounds) {
  const inRange = filterByRange(sessions, bounds);
  const studySessions = inRange.filter((s) => s.kind === "study");
  const breakSessions = inRange.filter((s) => s.kind !== "study");
  return {
    study: aggregate(studySessions),
    break: aggregate(breakSessions),
    totalCount: inRange.length,
  };
}

export function seriesByGroup(sessions, range, ref = new Date(), groups = []) {
  const d = ref instanceof Date ? ref : new Date(ref);
  const list = sessions || [];
  const buckets = [];

  const push = (startMs, endMs, label) => {
    const values = groups.map(() => 0);
    for (const s of list) {
      const t = s.startedAt ?? 0;
      if (t < startMs || t >= endMs) continue;
      for (let i = 0; i < groups.length; i++) {
        if (groups[i].match(s)) {
          values[i] += s.focusedSeconds || 0;
          break;
        }
      }
    }
    buckets.push({ label, values });
  };

  if (range === "day") {
    for (let h = 0; h < 24; h++) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
      push(start, start + 3600000, String(h));
    }
    return buckets;
  }
  if (range === "week") {
    const start0 = startOfWeekDate(d);
    const names = ["一", "二", "三", "四", "五", "六", "日"];
    for (let i = 0; i < 7; i++) {
      const start = new Date(
        start0.getFullYear(),
        start0.getMonth(),
        start0.getDate() + i,
      ).getTime();
      push(start, start + 86400000, names[i]);
    }
    return buckets;
  }
  if (range === "month") {
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const start = new Date(d.getFullYear(), d.getMonth(), day).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), day + 1).getTime();
      push(start, end, String(day));
    }
    return buckets;
  }
  if (range === "year") {
    for (let m = 0; m < 12; m++) {
      const start = new Date(d.getFullYear(), m, 1).getTime();
      const end = new Date(d.getFullYear(), m + 1, 1).getTime();
      push(start, end, `${m + 1}`);
    }
    return buckets;
  }
  for (let i = 11; i >= 0; i--) {
    const start = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const end = new Date(d.getFullYear(), d.getMonth() - i + 1, 1);
    push(start.getTime(), end.getTime(), `${start.getMonth() + 1}月`);
  }
  return buckets;
}

export function breakdown(sessions, bounds, categories, opts = {}) {
  const includeEvents = opts.includeEvents !== false;
  const includeEmpty = opts.includeEmpty === true;
  const inRange = filterByRange(sessions, bounds).filter((s) => s.kind === "study");
  const cats = categories || [];
  const rows = [];

  for (const cat of cats) {
    const catSessions = inRange.filter((s) => s.categoryId === cat.id);
    if (!catSessions.length && !includeEmpty) continue;
    rows.push({
      type: "category",
      id: cat.id,
      name: `${cat.icon || ""} ${cat.name}`.trim(),
      ...aggregate(catSessions),
    });
    if (!includeEvents) continue;
    for (const ev of cat.events || []) {
      const evSessions = catSessions.filter((s) => s.eventId === ev.id);
      if (!evSessions.length && !includeEmpty) continue;
      rows.push({
        type: "event",
        id: ev.id,
        parentId: cat.id,
        name: ev.name,
        ...aggregate(evSessions),
      });
    }
  }

  const known = new Set(cats.map((c) => c.id));
  const otherSessions = inRange.filter((s) => !s.categoryId || !known.has(s.categoryId));
  if (otherSessions.length) {
    rows.push({ type: "category", id: "__other__", name: "未分类", ...aggregate(otherSessions) });
  }

  const breaks = (sessions || []).filter(
    (s) =>
      s.kind !== "study" &&
      (s.startedAt ?? 0) >= bounds.start &&
      (s.startedAt ?? 0) < bounds.end,
  );
  const breakAgg = aggregate(breaks);

  return { rows, breakAgg };
}
