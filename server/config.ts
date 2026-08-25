import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@1";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));

function num(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

export const config = {
  projectRoot,
  tapoRoot: resolve(Deno.env.get("TAPO_ROOT") ?? join(projectRoot, "tapo")),
  webRoot: join(projectRoot, "web"),
  port: num("PORT", 8000),
  /** Loopback locally; a container has to bind 0.0.0.0 to be reachable. */
  host: Deno.env.get("HOST") ?? "127.0.0.1",

  /**
   * The camera writes filename epochs against a fixed UTC+1 clock with DST
   * disabled, so a filename timestamp is one hour ahead of true UTC.
   *
   * Verified two ways: the burned-in OSD clock of three videos across two days
   * matches `ts - 3600` rendered in Europe/Berlin to the second, and file
   * mtimes land 101..415s after `end - 3600` across all 63 untouched files.
   * Without the correction every file would have been downloaded ~57 minutes
   * before its own event ended.
   *
   * Only data spanning a DST boundary can confirm the "no DST" part; revisit
   * when the full backup is restored.
   */
  tsOffsetSeconds: num("TS_OFFSET_SECONDS", -3600),

  displayTz: Deno.env.get("DISPLAY_TZ") ?? "Europe/Berlin",
  rescanIntervalS: num("RESCAN_INTERVAL_S", 1800),
};
