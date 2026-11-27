export function parseDateKey(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function toKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function safeDate(year, month, day) {
  const d = new Date(year, month, day);
  if (d.getMonth() !== month) return new Date(year, month, 28);
  return d;
}

export function daysBetween(a, b) {
  const A = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const B = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((B - A) / 86400000);
}

export function nextOccurrence(countdown, today = new Date()) {
  const target = parseDateKey(countdown.date);
  if (countdown.recurring === "yearly") {
    let d = safeDate(today.getFullYear(), target.getMonth(), target.getDate());
    if (daysBetween(today, d) < 0) {
      d = safeDate(today.getFullYear() + 1, target.getMonth(), target.getDate());
    }
    return d;
  }
  return target;
}

export function daysUntil(countdown, today = new Date()) {
  return daysBetween(today, nextOccurrence(countdown, today));
}

export function occursOn(countdown, date) {
  const target = parseDateKey(countdown.date);
  if (countdown.recurring === "yearly") {
    return date.getMonth() === target.getMonth() && date.getDate() === target.getDate();
  }
  return (
    date.getFullYear() === target.getFullYear() &&
    date.getMonth() === target.getMonth() &&
    date.getDate() === target.getDate()
  );
}

export function monthMatrix(year, month, weekStartsMonday = true) {
  const first = new Date(year, month, 1);
  const offset = weekStartsMonday ? (first.getDay() + 6) % 7 : first.getDay();
  const start = new Date(year, month, 1 - offset);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      week.push({ date, inMonth: date.getMonth() === month });
    }
    weeks.push(week);
  }
  return weeks;
}

export function sortUpcoming(countdowns, today = new Date()) {
  return [...(countdowns || [])]
    .map((c) => ({ countdown: c, days: daysUntil(c, today), next: nextOccurrence(c, today) }))
    .sort((a, b) => a.days - b.days);
}
