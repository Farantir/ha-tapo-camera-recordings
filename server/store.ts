import { config } from "./config.ts";
import { type CameraInfo, scan, type TapoEvent, type TapoIndex } from "./scan.ts";
import { loadTags, ROOT_TAGS, UNTAGGED } from "./tags.ts";

let index: TapoIndex | null = null;
let inFlight: Promise<TapoIndex> | null = null;

export async function reindex(): Promise<TapoIndex> {
  // Collapse concurrent rescans so a burst of requests triggers one walk. The
  // sidecar is re-read as part of it, so a tagger run shows up on the next
  // rescan without restarting the server.
  inFlight ??= loadTags()
    .then(() => scan())
    .finally(() => {
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
  /**
   * Matched against the event's flattened taxonomy chain, so `animal` selects
   * every species below it and `domestic cat` selects just that one. Several
   * tags are OR-ed, matching how the camera chips already behave. The reserved
   * value `untagged` selects events the tagger has not reached.
   */
  tags?: Set<string>;
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

function matchesTags(event: TapoEvent, tags: Set<string>): boolean {
  if (tags.has(UNTAGGED) && event.tags.length === 0) return true;
  return event.tags.some((tag) => tags.has(tag));
}

function matches(event: TapoEvent, query: EventQuery): boolean {
  if (query.cameras && !query.cameras.has(event.camera)) return false;
  if (query.tags && !matchesTags(event, query.tags)) return false;
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
  tags?: Set<string>,
): { buckets: HistogramBucket[]; cameras: string[] } {
  const byKey = new Map<string, HistogramBucket>();

  for (const event of events) {
    if (cameras && !cameras.has(event.camera)) continue;
    if (tags && !matchesTags(event, tags)) continue;
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

export interface TagCount {
  tag: string;
  count: number;
}

export interface TagVocabulary {
  /** The four kinds plus `untagged`, in a fixed order the UI can rely on. */
  buckets: TagCount[];
  /**
   * The deepest node each event actually resolved to, most frequent first —
   * "domestic cat", "western european hedgehog", or a rolled-up "cat family"
   * when the classifier would only commit that far.
   */
  labels: TagCount[];
}

/**
 * The filter vocabulary, derived entirely from what the tagger produced — no
 * species list is configured anywhere. Because every event carries its full
 * ancestor chain, a root like `animal` counts every descendant exactly once,
 * while the labels row stays specific.
 */
export function tagVocabulary(events: TapoEvent[] = current().events): TagVocabulary {
  const inChain = new Map<string, number>();
  const asLabel = new Map<string, number>();
  let untagged = 0;

  for (const event of events) {
    if (event.tags.length === 0) {
      untagged++;
      continue;
    }
    for (const tag of event.tags) inChain.set(tag, (inChain.get(tag) ?? 0) + 1);
    if (event.label) asLabel.set(event.label, (asLabel.get(event.label) ?? 0) + 1);
  }

  const buckets: TagCount[] = [];
  for (const tag of ROOT_TAGS) {
    const count = inChain.get(tag) ?? 0;
    if (count > 0) buckets.push({ tag, count });
  }
  if (untagged > 0) buckets.push({ tag: UNTAGGED, count: untagged });

  // A root is its own label when nothing below it was confident enough; that
  // would just duplicate the bucket chip, so it is left out of this row.
  const roots = new Set<string>(ROOT_TAGS);
  const labels = [...asLabel.entries()]
    .filter(([tag]) => !roots.has(tag))
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return { buckets, labels };
}

export function listCameras(): CameraInfo[] {
  return current().cameras;
}

export function getEvent(id: string): TapoEvent | undefined {
  return current().byId.get(id);
}
