import { config } from "./config.ts";
import { type CameraInfo, scan, type TapoEvent, type TapoIndex } from "./scan.ts";

let index: TapoIndex | null = null;
let inFlight: Promise<TapoIndex> | null = null;

export async function reindex(): Promise<TapoIndex> {
  // Collapse concurrent rescans so a burst of requests triggers one walk.
  inFlight ??= scan().finally(() => {
    inFlight = null;
  });
  index = await inFlight;
  return index;
}

export function current(): TapoIndex {
  if (!index) throw new Error("index not built yet");
  return index;
}

export function startBackgroundRescan(): number {
  return setInterval(() => {
    reindex().catch((err) => console.error("rescan failed:", err));
  }, config.rescanIntervalS * 1000);
}

export interface EventQuery {
  cameras?: Set<string>;
  from?: number;
  to?: number;
  limit: number;
  cursor?: string;
}

/** Keyset cursor over the (start desc, camera asc) ordering. */
function parseCursor(cursor: string): { start: number; camera: string } | null {
  const at = cursor.indexOf(":");
  if (at === -1) return null;
  const start = Number(cursor.slice(0, at));
  if (!Number.isFinite(start)) return null;
  return { start, camera: cursor.slice(at + 1) };
}

function isAfterCursor(event: TapoEvent, cursor: { start: number; camera: string }): boolean {
  if (event.start !== cursor.start) return event.start < cursor.start;
  return event.camera > cursor.camera;
}

function matches(event: TapoEvent, query: EventQuery): boolean {
  if (query.cameras && !query.cameras.has(event.camera)) return false;
  if (query.from !== undefined && event.start < query.from) return false;
  if (query.to !== undefined && event.start > query.to) return false;
  return true;
}

export function queryEvents(query: EventQuery, events: TapoEvent[] = current().events) {
  const cursor = query.cursor ? parseCursor(query.cursor) : null;

  const page: TapoEvent[] = [];
  let total = 0;
  let passedCursor = cursor === null;

  for (const event of events) {
    if (!matches(event, query)) continue;
    total++;
    if (!passedCursor) {
      if (isAfterCursor(event, cursor!)) passedCursor = true;
      else continue;
    }
    if (page.length < query.limit) page.push(event);
  }

  const last = page.at(-1);
  const hasMore = page.length === query.limit && last !== undefined;
  return {
    events: page,
    total,
    nextCursor: hasMore ? `${last.start}:${last.camera}` : null,
  };
}

export interface HistogramBucket {
  key: string;
  /** Bucket start, as true-UTC epoch seconds. */
  start: number;
  counts: Record<string, number>;
  total: number;
}

/**
 * Event counts per local day or local hour, per camera — the data behind the
 * timeline swimlanes. Only buckets that contain events are emitted; the client
 * fills the gaps, which keeps a multi-year range cheap to transfer.
 */
export function histogram(
  bucket: "day" | "hour",
  cameras?: Set<string>,
  from?: number,
  to?: number,
  events: TapoEvent[] = current().events,
): { buckets: HistogramBucket[]; cameras: string[] } {
  const byKey = new Map<string, HistogramBucket>();

  for (const event of events) {
    if (cameras && !cameras.has(event.camera)) continue;
    if (from !== undefined && event.start < from) continue;
    if (to !== undefined && event.start > to) continue;
    const key = bucket === "day"
      ? event.day
      : `${event.day}T${String(Math.floor(event.secondsOfDay / 3600)).padStart(2, "0")}`;
    let entry = byKey.get(key);
    if (!entry) {
      // Snap to the start of the bucket in local time.
      const snap = bucket === "day"
        ? event.start - event.secondsOfDay
        : event.start - (event.secondsOfDay % 3600);
      entry = { key, start: snap, counts: {}, total: 0 };
      byKey.set(key, entry);
    }
    entry.counts[event.camera] = (entry.counts[event.camera] ?? 0) + 1;
    entry.total++;
  }

  const buckets = [...byKey.values()].sort((a, b) => a.start - b.start);
  const present = new Set(buckets.flatMap((b) => Object.keys(b.counts)));
  return { buckets, cameras: [...present].sort() };
}

export function listCameras(): CameraInfo[] {
  return current().cameras;
}

export function getEvent(id: string): TapoEvent | undefined {
  return current().byId.get(id);
}
