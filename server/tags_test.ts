import { assertEquals } from "jsr:@std/assert@1";
import { loadTags, setTags, tagsFor, UNTAGGED } from "./tags.ts";
import { queryEvents, tagVocabulary } from "./store.ts";
import type { TapoEvent } from "./scan.ts";
import { localParts } from "./tz.ts";

function ev(camera: string, start: number, tags: string[]): TapoEvent {
  const parts = localParts(start);
  return {
    id: `${camera}/${start}-${start + 60}`,
    camera,
    key: `${start}-${start + 60}`,
    start,
    end: start + 60,
    duration: 60,
    hasThumb: true,
    hasVideo: true,
    day: parts.dayKey,
    secondsOfDay: parts.secondsOfDay,
    tags,
    label: tags.at(-1) ?? null,
  };
}

const BASE = 1_800_000_000;
const CAT = ["animal", "mammalia", "carnivora", "felidae", "domestic cat"];
const HEDGEHOG = ["animal", "mammalia", "eulipotyphla", "erinaceidae", "western european hedgehog"];
const sample = [
  ev("haustuer", BASE, CAT),
  ev("haustuer", BASE - 100, HEDGEHOG),
  ev("garage", BASE - 200, ["human"]),
  ev("garage", BASE - 300, ["no_event"]),
  ev("garage", BASE - 400, []),
];

async function withTagsFile<T>(body: unknown, fn: (path: string) => Promise<T>): Promise<T> {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, typeof body === "string" ? body : JSON.stringify(body));
    return await fn(path);
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("a parent tag selects every species beneath it", () => {
  const ids = (tags: string[]) =>
    queryEvents({ tags: new Set(tags), limit: 10 }, sample).events.map((e) => e.id);

  assertEquals(ids(["animal"]).length, 2);
  assertEquals(ids(["mammalia"]).length, 2);
  // ...while a leaf stays specific.
  assertEquals(ids(["domestic cat"]), [sample[0].id]);
  assertEquals(ids(["western european hedgehog"]), [sample[1].id]);
});

Deno.test("several tags are OR-ed, like the camera chips", () => {
  const result = queryEvents({ tags: new Set(["human", "no_event"]), limit: 10 }, sample);
  assertEquals(result.total, 2);
});

Deno.test("untagged selects only events the tagger has not reached", () => {
  const result = queryEvents({ tags: new Set([UNTAGGED]), limit: 10 }, sample);
  assertEquals(result.events.map((e) => e.id), [sample[4].id]);
});

Deno.test("tag and camera filters intersect rather than widen", () => {
  const result = queryEvents(
    { cameras: new Set(["haustuer"]), tags: new Set(["animal", "human"]), limit: 10 },
    sample,
  );
  assertEquals(result.total, 2);
});

Deno.test("an unknown tag matches nothing instead of everything", () => {
  assertEquals(queryEvents({ tags: new Set(["capybara"]), limit: 10 }, sample).total, 0);
});

Deno.test("the bucket row is the fixed roots that occur, untagged last", () => {
  const { buckets } = tagVocabulary(sample);
  assertEquals(buckets.map((b) => b.tag), ["no_event", "animal", "human", UNTAGGED]);
  // `animal` counts both species beneath it, each exactly once.
  assertEquals(buckets.find((b) => b.tag === "animal")?.count, 2);
  assertEquals(buckets.find((b) => b.tag === UNTAGGED)?.count, 1);
});

Deno.test("the label row holds resolved leaves only, never the roots", () => {
  const { labels } = tagVocabulary(sample);
  assertEquals(labels.map((l) => l.tag), ["domestic cat", "western european hedgehog"]);
  // `human` and `no_event` resolve to a root, so they stay in the bucket row.
  assertEquals(labels.some((l) => l.tag === "human"), false);
});

Deno.test("a family-level rollup shows up as its own label", () => {
  const rolledUp = [...sample, ev("tiere", BASE - 500, ["animal", "mammalia", "cat family"])];
  const { labels } = tagVocabulary(rolledUp);
  assertEquals(labels.some((l) => l.tag === "cat family"), true);
  assertEquals(tagVocabulary(rolledUp).buckets.find((b) => b.tag === "animal")?.count, 3);
});

Deno.test("loadTags lowercases, trims and de-duplicates what the tagger wrote", async () => {
  await withTagsFile(
    { version: 1, events: { "a/1-2": { tags: ["  Animal ", "MAMMALIA", "animal", ""] } } },
    async (path) => {
      assertEquals(await loadTags(path), 1);
      assertEquals(tagsFor("a/1-2").tags, ["animal", "mammalia"]);
    },
  );
});

Deno.test("a missing sidecar is normal, not an error", async () => {
  setTags({ "a/1-2": ["animal"] });
  assertEquals(await loadTags("/nonexistent/tags.json"), 0);
  assertEquals(tagsFor("a/1-2").tags, []);
});

Deno.test("a half-written sidecar keeps the tags already loaded", async () => {
  setTags({ "a/1-2": ["animal"] });
  await withTagsFile('{"version":1,"events":{"a/1-2":{"tags":["ani', async (path) => {
    await loadTags(path);
    assertEquals(tagsFor("a/1-2").tags, ["animal"]);
  });
});

Deno.test("TAGS_FILE unset simply disables tagging", async () => {
  setTags({ "a/1-2": ["animal"] });
  assertEquals(await loadTags(null), 0);
  assertEquals(tagsFor("a/1-2").tags, []);
});
