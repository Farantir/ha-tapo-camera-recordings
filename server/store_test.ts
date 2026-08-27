import { assertEquals } from "jsr:@std/assert@1";
import type { TapoEvent } from "./scan.ts";
import { histogram, queryEvents } from "./store.ts";
import { localParts } from "./tz.ts";

function makeEvent(camera: string, start: number, duration = 60, tags: string[] = []): TapoEvent {
  const end = start + duration;
  const parts = localParts(start);
  return {
    id: `${camera}/${start}-${end}`,
    camera,
    key: `${start}-${end}`,
    start,
    end,
    duration,
    hasThumb: true,
    hasVideo: true,
    day: parts.dayKey,
    secondsOfDay: parts.secondsOfDay,
    tags,
    label: tags.at(-1) ?? null,
    eventThumb: null,
  };
}

Deno.test("queryEvents: cursor pagination visits every event exactly once, ties broken camera asc", () => {
  const base = 1_800_000_000;
  const events = [
    makeEvent("zebra", base),
    makeEvent("alpha", base),
    makeEvent("mid", base),
    makeEvent("alpha", base - 100),
    makeEvent("zebra", base - 200),
  ].sort((a, b) => b.start - a.start || a.camera.localeCompare(b.camera));

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = queryEvents({ limit: 2, cursor }, events);
    seen.push(...page.events.map((e) => e.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  assertEquals(seen.length, events.length);
  assertEquals(new Set(seen).size, events.length); // no duplicates
  assertEquals(seen, events.map((e) => e.id)); // (start desc, camera asc) preserved across pages

  const tieOrder = seen.filter((id) => id.includes(`/${base}-${base + 60}`));
  assertEquals(tieOrder, [
    `alpha/${base}-${base + 60}`,
    `mid/${base}-${base + 60}`,
    `zebra/${base}-${base + 60}`,
  ]);
});

Deno.test("queryEvents: from/to bound the range inclusively on start", () => {
  const events = [makeEvent("a", 1000), makeEvent("a", 2000), makeEvent("a", 3000)];
  const page = queryEvents({ limit: 10, from: 1500, to: 2500 }, events);
  assertEquals(page.events.map((e) => e.start), [2000]);
  assertEquals(page.total, 1);
});

Deno.test("queryEvents: camera filter narrows both the page and the total", () => {
  const events = [makeEvent("a", 3000), makeEvent("b", 2000), makeEvent("a", 1000)];
  const page = queryEvents({ limit: 10, cameras: new Set(["a"]) }, events);
  assertEquals(page.events.map((e) => e.camera), ["a", "a"]);
  assertEquals(page.total, 2);
});

Deno.test("histogram: day buckets snap to local midnight", () => {
  const events = [
    makeEvent("a", 1_800_000_000),
    makeEvent("a", 1_800_000_000 + 3600),
  ];
  const { buckets } = histogram("day", undefined, undefined, undefined, events);
  assertEquals(buckets.length, 1);
  assertEquals(buckets[0].total, 2);
  const parts = localParts(buckets[0].start);
  assertEquals(parts.secondsOfDay, 0);
  assertEquals(parts.dayKey, events[0].day);
});

Deno.test("histogram: from/to bound which events are counted", () => {
  const events = [makeEvent("a", 1000), makeEvent("a", 100_000)];
  const { buckets } = histogram("day", undefined, 500, 2000, events);
  const total = buckets.reduce((sum, b) => sum + b.total, 0);
  assertEquals(total, 1);
});
