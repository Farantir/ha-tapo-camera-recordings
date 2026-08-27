import { config } from "./config.ts";

/**
 * One analysed event, as written by the tagger. `tags` is the flattened
 * ancestor chain (`animal`, `mammalia`, `carnivora`, … , `domestic cat`) so a
 * filter on any level matches without the server knowing any taxonomy;
 * `label`/`rank` name the deepest node the classifier was confident about.
 */
export interface EventTags {
  tags: string[];
  label?: string;
  rank?: string;
  confidence?: number;
  /** True when the tagger wrote a thumbnail for this event. */
  thumb?: boolean;
  /** When it did so — doubles as the cache key for that thumbnail's URL. */
  taggedAt?: number;
}

export interface TagsFile {
  version: number;
  generatedAt?: number;
  models?: Record<string, string>;
  events: Record<string, EventTags>;
}

/** Events the tagger has not reached yet carry this instead of a real tag. */
export const UNTAGGED = "untagged";

/**
 * The roots of the tagger's vocabulary, in the order the chips show them.
 * Everything else in a tag chain hangs below `animal`, so these five are the
 * only names both sides have to agree on — species are discovered, never
 * configured.
 */
export const ROOT_TAGS = ["no_event", "animal", "human", "vehicle"] as const;

/** What `scan()` attaches to an event. */
export interface ResolvedTags {
  tags: string[];
  label: string | null;
  /**
   * Version stamp of the tagger's own thumbnail for this event, or null when
   * there is none and the camera's still is all there is. It goes into the
   * image URL so a re-analysed clip is re-fetched rather than served from the
   * browser cache under a filename that never changes.
   */
  eventThumb: number | null;
}

const NONE: ResolvedTags = { tags: [], label: null, eventThumb: null };

let byId = new Map<string, ResolvedTags>();
let loadedAt = 0;
let source: string | null = null;

export type TagLookup = (id: string) => ResolvedTags;

export function tagsFor(id: string): ResolvedTags {
  return byId.get(id) ?? NONE;
}

export function tagsState(): { file: string | null; loadedAt: number; events: number } {
  return { file: source, loadedAt, events: byId.size };
}

function parse(raw: string, file: string): Map<string, ResolvedTags> {
  const data = JSON.parse(raw) as TagsFile;
  if (!data || typeof data !== "object" || typeof data.events !== "object") {
    throw new Error(`${file} is not a tags file (no "events" object)`);
  }
  const next = new Map<string, ResolvedTags>();
  for (const [id, entry] of Object.entries(data.events)) {
    if (!entry || !Array.isArray(entry.tags)) continue;
    // Normalise here so neither the query parser nor the UI has to.
    const tags = entry.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (!tags.length) continue;
    // The label is the deepest node the classifier committed to; it is always
    // one of the tags, so a chip built from it filters correctly.
    const label = typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim().toLowerCase()
      : tags[tags.length - 1];
    const taggedAt = typeof entry.taggedAt === "number" ? entry.taggedAt : 0;
    next.set(id, {
      tags: [...new Set(tags)],
      label,
      eventThumb: entry.thumb === true ? taggedAt : null,
    });
  }
  return next;
}

/**
 * Re-read the sidecar. A missing file is normal — it just means the tagger has
 * not run yet — so it clears the index rather than throwing. A malformed file
 * keeps the previous index: the tagger writes atomically, but a half-copied
 * file on a shared volume should not blank every tag in the UI.
 */
export async function loadTags(file: string | null = config.tagsFile): Promise<number> {
  source = file;
  if (!file) {
    byId = new Map();
    return 0;
  }
  let raw: string;
  try {
    raw = await Deno.readTextFile(file);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      byId = new Map();
      loadedAt = Date.now();
      return 0;
    }
    if (err instanceof Deno.errors.PermissionDenied) {
      console.error(
        `TAGS_FILE ${file} is not readable — check the volume mount and that ` +
          `--allow-read covers it`,
      );
      return byId.size;
    }
    throw err;
  }
  try {
    byId = parse(raw, file);
    loadedAt = Date.now();
  } catch (err) {
    console.error(`ignoring unreadable ${file}:`, err instanceof Error ? err.message : err);
  }
  return byId.size;
}

/** Test seam: install a tag index without touching the filesystem. */
export function setTags(entries: Record<string, string[]>): void {
  byId = new Map(
    Object.entries(entries).map((
      [id, tags],
    ) => [id, { tags: [...new Set(tags)], label: tags.at(-1) ?? null, eventThumb: null }]),
  );
  loadedAt = Date.now();
}
