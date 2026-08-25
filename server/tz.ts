import { config } from "./config.ts";

const formatters = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Offset of `tz` at `ts`, in seconds.
 *
 * Memoised per timezone per UTC hour: Intl is comparatively slow and we call
 * this once per event on every rescan. Europe/Berlin switches on the hour, so
 * an hour-keyed cache never straddles a DST transition.
 */
const offsetCache = new Map<string, number>();

export function tzOffsetSeconds(ts: number, tz: string = config.displayTz): number {
  const cacheKey = `${tz}|${Math.floor(ts / 3600)}`;
  const cached = offsetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const parts = getFormatter(tz).formatToParts(new Date(ts * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  ) / 1000;

  const offset = asIfUtc - ts;
  offsetCache.set(cacheKey, offset);
  return offset;
}

export interface LocalParts {
  /** "2026-07-01" in the display timezone. */
  dayKey: string;
  /** "2026-07-01T14" in the display timezone. */
  hourKey: string;
  /** Seconds since local midnight — the x coordinate for a day timeline. */
  secondsOfDay: number;
}

export function localParts(ts: number, tz: string = config.displayTz): LocalParts {
  const shifted = new Date((ts + tzOffsetSeconds(ts, tz)) * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const dayKey = `${y}-${m}-${d}`;
  return {
    dayKey,
    hourKey: `${dayKey}T${h}`,
    secondsOfDay: shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 +
      shifted.getUTCSeconds(),
  };
}
