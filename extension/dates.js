// SNAP Agent - School Nutrition AI Purchasing Agent
// dates.js - Local-time date helpers.
//
// PrimeroEdge renders dates as m/d/yyyy with no timezone. Handing those to
// `new Date(str)` parses them as UTC, which shifts the serving day for anyone
// west of Greenwich, so every conversion here is explicit and local.

// The delivery date plus the next five school days.
export const COVERAGE_SCHOOL_DAYS = 6;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseMdy(text) {
  const match = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text || "");
  if (!match) return null;
  const [, month, day, year] = match.map(Number);
  const parsed = new Date(year, month - 1, day);
  const roundTrips =
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
  return roundTrips ? parsed : null;
}

export function toIso(value) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function fromIso(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function isWeekend(iso) {
  const day = fromIso(iso).getDay();
  return day === 0 || day === 6;
}

export function weekdayName(iso) {
  return WEEKDAY_NAMES[fromIso(iso).getDay()];
}

export function formatShort(iso) {
  const value = fromIso(iso);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

// The first `days` school days falling on or after the delivery date. Weekends
// are skipped rather than consuming a slot, so a Thursday delivery still covers
// six school days instead of running out on Saturday.
export function coverageWindow(deliveryIso, days = COVERAGE_SCHOOL_DAYS) {
  if (!deliveryIso) return [];
  const dates = [];
  const cursor = fromIso(deliveryIso);
  // Guard against an unparseable date producing an endless loop.
  for (let step = 0; step < days * 3 && dates.length < days; step++) {
    const iso = toIso(cursor);
    if (!isWeekend(iso)) dates.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}
