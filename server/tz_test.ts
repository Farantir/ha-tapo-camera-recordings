import { assertEquals } from "jsr:@std/assert@1";
import { localParts, tzOffsetSeconds } from "./tz.ts";

const TZ = "Europe/Berlin";

function utc(y: number, m: number, d: number, h: number, min = 0, s = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s) / 1000;
}

Deno.test("spring forward 2026-03-29: offset jumps from +1h to +2h", () => {
  const before = utc(2026, 3, 29, 0, 59, 59); // 01:59:59 CET
  const after = utc(2026, 3, 29, 1, 0, 0); // 03:00:00 CEST (02:00-03:00 is skipped)
  assertEquals(tzOffsetSeconds(before, TZ), 3600);
  assertEquals(tzOffsetSeconds(after, TZ), 7200);
  assertEquals(localParts(before, TZ).hourKey, "2026-03-29T01");
  assertEquals(localParts(after, TZ).hourKey, "2026-03-29T03");
});

Deno.test("fall back 2026-10-25: offset drops from +2h to +1h", () => {
  const before = utc(2026, 10, 25, 0, 59, 59); // 02:59:59 CEST
  const after = utc(2026, 10, 25, 1, 0, 0); // 02:00:00 CET (the second 02:00)
  assertEquals(tzOffsetSeconds(before, TZ), 7200);
  assertEquals(tzOffsetSeconds(after, TZ), 3600);
  assertEquals(localParts(before, TZ).hourKey, "2026-10-25T02");
  assertEquals(localParts(after, TZ).hourKey, "2026-10-25T02");
});

Deno.test("local midnight has secondsOfDay 0", () => {
  const ts = utc(2026, 6, 30, 22, 0, 0); // 2026-07-01T00:00:00 CEST
  const parts = localParts(ts, TZ);
  assertEquals(parts.dayKey, "2026-07-01");
  assertEquals(parts.secondsOfDay, 0);
});

Deno.test("23:59:59 local stays within the same day", () => {
  const ts = utc(2026, 7, 1, 21, 59, 59); // 2026-07-01T23:59:59 CEST
  const parts = localParts(ts, TZ);
  assertEquals(parts.dayKey, "2026-07-01");
  assertEquals(parts.secondsOfDay, 86399);
});

Deno.test("hour-keyed offset cache never straddles a DST transition", () => {
  // The transition lands exactly on an hour edge, so the two timestamps below
  // fall in adjacent-but-distinct UTC hour buckets and must never share a
  // cached offset.
  const justBefore = utc(2026, 3, 29, 0, 59, 59);
  const justAfter = utc(2026, 3, 29, 1, 0, 0);
  assertEquals(Math.floor(justBefore / 3600), Math.floor(justAfter / 3600) - 1);
  assertEquals(tzOffsetSeconds(justBefore, TZ), 3600);
  assertEquals(tzOffsetSeconds(justAfter, TZ), 7200);
});
