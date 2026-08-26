import { join } from "jsr:@std/path@1";
import { config } from "./config.ts";
import { type TagLookup, tagsFor } from "./tags.ts";
import { localParts } from "./tz.ts";

/** On-disk stem: `<start>-<end>`, both 10-digit epochs. */
const STEM = /^(\d{10})-(\d{10})$/;

export interface TapoEvent {
  id: string;
  camera: string;
  /** Filename stem, reused to build media URLs. */
  key: string;
  /** Corrected true-UTC epoch seconds. */
  start: number;
  end: number;
  duration: number;
  hasThumb: boolean;
  hasVideo: boolean;
  /** Local day, precomputed so the client never does timezone maths. */
  day: string;
  /** Seconds since local midnight — the x coordinate for the day timeline. */
  secondsOfDay: number;
  /**
   * Flattened taxonomy chain from the tagger, deepest last — e.g.
   * `["animal", "mammalia", "carnivora", "felidae", "domestic cat"]`. Empty
   * means the tagger has not analysed this event yet.
   */
  tags: string[];
  /**
   * The deepest node the classifier was actually confident about, which is what
   * the UI shows on the row. Always one of `tags`, so filtering on it works.
   */
  label: string | null;
}

export interface CameraInfo {
  id: string;
  label: string;
  eventCount: number;
  firstEvent: number | null;
  lastEvent: number | null;
}

export interface TapoIndex {
  generation: number;
  scannedAt: number;
  cameras: CameraInfo[];
  /** Sorted by `start` desc, then `camera` asc — the pagination order. */
  events: TapoEvent[];
  byId: Map<string, TapoEvent>;
}

/** `garage_garten` -> `Garage Garten`. Umlauts are not guessed back. */
function prettyLabel(dir: string): string {
  return dir
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function readStems(dir: string, ext: string): Promise<Map<string, [number, number]>> {
  const stems = new Map<string, [number, number]>();
  try {
    // Deno.readDir() does not touch the filesystem until iteration starts, so
    // a missing directory only throws once `for await` begins — not here at
    // the call itself. The whole loop has to sit inside the try.
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(ext)) continue;
      const stem = entry.name.slice(0, -ext.length);
      const match = STEM.exec(stem);
      if (!match) continue;
      stems.set(stem, [Number(match[1]), Number(match[2])]);
    }
  } catch (err) {
    // A camera folder may legitimately lack thumbs/ or videos/.
    if (err instanceof Deno.errors.NotFound) return stems;
    throw err;
  }
  return stems;
}

/**
 * In a container the root is a bind mount, so a failure here is a host-side
 * mistake rather than a bug — a bare errno sends people looking in the wrong
 * place. Name the cause instead.
 */
function rootError(root: string, err: unknown): Error {
  if (err instanceof Deno.errors.NotFound) {
    return new Error(`TAPO_ROOT ${root} does not exist — is the folder mounted?`);
  }
  if (err instanceof Deno.errors.PermissionDenied) {
    return new Error(
      `TAPO_ROOT ${root} is not readable by the user the process runs as — ` +
        `a bind mount keeps its ownership from the host. Either make the footage ` +
        `readable for that user, or run the container as the uid that owns it ` +
        `(PUID/PGID in docker-compose.yml).`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

let generation = 0;

export async function scan(
  root: string = config.tapoRoot,
  lookupTags: TagLookup = tagsFor,
): Promise<TapoIndex> {
  const cameras: CameraInfo[] = [];
  const events: TapoEvent[] = [];

  const dirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) dirs.push(entry.name);
    }
  } catch (err) {
    throw rootError(root, err);
  }
  dirs.sort();

  for (const camera of dirs) {
    const cameraDir = join(root, camera);
    const [thumbs, videos] = await Promise.all([
      readStems(join(cameraDir, "thumbs"), ".jpg"),
      readStems(join(cameraDir, "videos"), ".mp4"),
    ]);

    // An event is one recording; in a complete backup it has both files. This
    // dataset is partial, so take the union and let the UI note what is absent
    // rather than dropping the event.
    const stems = new Set([...thumbs.keys(), ...videos.keys()]);
    let first: number | null = null;
    let last: number | null = null;

    for (const stem of stems) {
      const span = thumbs.get(stem) ?? videos.get(stem)!;
      const start = span[0] + config.tsOffsetSeconds;
      const end = span[1] + config.tsOffsetSeconds;
      const parts = localParts(start);
      const id = `${camera}/${stem}`;
      events.push({
        id,
        camera,
        key: stem,
        start,
        end,
        duration: Math.max(0, end - start),
        hasThumb: thumbs.has(stem),
        hasVideo: videos.has(stem),
        day: parts.dayKey,
        secondsOfDay: parts.secondsOfDay,
        ...lookupTags(id),
      });
      if (first === null || start < first) first = start;
      if (last === null || start > last) last = start;
    }

    cameras.push({
      id: camera,
      label: prettyLabel(camera),
      eventCount: stems.size,
      firstEvent: first,
      lastEvent: last,
    });
  }

  events.sort((a, b) => b.start - a.start || a.camera.localeCompare(b.camera));

  return {
    generation: ++generation,
    scannedAt: Date.now(),
    cameras,
    events,
    byId: new Map(events.map((e) => [e.id, e])),
  };
}

export function isValidKey(key: string): boolean {
  return STEM.test(key);
}
