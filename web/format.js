// All times arriving from the API are already corrected true-UTC epoch seconds;
// the only job here is rendering them in the display timezone.

// en-GB keeps the 24-hour clock the recordings are timestamped in.
const LOCALE = "en-GB";

let tz = "Europe/Berlin";
export function setTimezone(value) {
  if (value) tz = value;
}

const memo = new Map();
function fmt(options) {
  const key = JSON.stringify(options);
  let f = memo.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, ...options });
    memo.set(key, f);
  }
  return f;
}

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

export const clock = (ts) =>
  fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ts * 1000);

export const hourMinute = (ts) => fmt({ hour: "2-digit", minute: "2-digit" }).format(ts * 1000);

export const longDate = (ts) =>
  fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ts * 1000);

export const shortDate = (ts) =>
  fmt({ day: "2-digit", month: "2-digit", year: "2-digit" }).format(ts * 1000);

export const dayMonth = (ts) => fmt({ day: "numeric", month: "short" }).format(ts * 1000);

/**
 * `YYYY-MM-DD` in the display timezone — the shape the API uses for `day`.
 * Assembled from parts rather than parsed out of a formatted string, so it does
 * not depend on how the locale happens to order or separate the fields.
 */
function dayKeyOf(ts) {
  const parts = fmt({ year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(ts * 1000);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Day header: "Today" / "Yesterday" / "Friday 3 July 2026". */
export function dayHeading(ts, dayKey) {
  const now = Date.now() / 1000;
  if (dayKeyOf(now) === dayKey) return "Today";
  if (dayKeyOf(now - 86400) === dayKey) return "Yesterday";
  return longDate(ts);
}

/** Compact day label for narrow columns: "Today" / "Fri, 03/08/26". */
export function dayLabelShort(ts, dayKey) {
  const heading = dayHeading(ts, dayKey);
  if (heading === "Today" || heading === "Yesterday") return heading;
  return `${fmt({ weekday: "short" }).format(ts * 1000)}, ${shortDate(ts)}`;
}

/** Event length as m:ss, or h:mm:ss past an hour. */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const hh = Math.floor(s / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

export function relativeAge(ts) {
  const diff = ts - Date.now() / 1000;
  const abs = Math.abs(diff);
  const units = [
    ["year", 31557600],
    ["month", 2629800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (abs >= size) return relative.format(Math.round(diff / size), unit);
  }
  return relative.format(Math.round(diff), "second");
}

/** Interpolation guard for the hand-built SVG and tooltip markup. */
export function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
