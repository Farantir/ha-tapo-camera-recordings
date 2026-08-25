import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import {
  clampWindow,
  DAY,
  fromFraction,
  fullDay,
  MIN_SPAN,
  panBy,
  ticks,
  tickStep,
  toFraction,
  zoomAt,
} from "./timeline_geom.js";

Deno.test("clampWindow keeps the window inside the day at both extremes", () => {
  assertEquals(clampWindow({ offset: -500, span: DAY }), { offset: 0, span: DAY });
  assertEquals(clampWindow({ offset: 0, span: DAY * 3 }), { offset: 0, span: DAY });
  assertEquals(clampWindow({ offset: 0, span: 1 }), { offset: 0, span: MIN_SPAN });
  // Panning past the end pins the window's right edge to midnight.
  assertEquals(clampWindow({ offset: DAY, span: 3600 }), { offset: DAY - 3600, span: 3600 });
});

Deno.test("panning can never escape the day, however far it is pushed", () => {
  let w = { offset: 12 * 3600, span: 3600 };
  for (let i = 0; i < 100; i++) w = panBy(w, 1);
  assertEquals(w, { offset: DAY - 3600, span: 3600 });
  for (let i = 0; i < 100; i++) w = panBy(w, -1);
  assertEquals(w, { offset: 0, span: 3600 });
});

Deno.test("zoomAt holds the anchored time still", () => {
  const w = { offset: 6 * 3600, span: 6 * 3600 };
  for (const frac of [0, 0.25, 0.5, 1]) {
    const anchor = fromFraction(w, frac);
    const zoomed = zoomAt(w, 2, frac);
    assertAlmostEquals(fromFraction(zoomed, frac), anchor, 1e-9);
    assertEquals(zoomed.span, 3 * 3600);
  }
});

Deno.test("zooming out at an edge clamps rather than leaving the day", () => {
  // Centred zoom-out on the first hour wants a negative offset; it pins to 0.
  const zoomed = zoomAt({ offset: 0, span: 3600 }, 1 / 4, 0.5);
  assertEquals(zoomed, { offset: 0, span: 4 * 3600 });
});

Deno.test("zooming out past a full day lands exactly on the full day", () => {
  const zoomed = zoomAt({ offset: 10 * 3600, span: 6 * 3600 }, 1 / 100, 0.5);
  assertEquals(zoomed, fullDay());
});

Deno.test("toFraction and fromFraction round-trip", () => {
  const w = { offset: 7 * 3600 + 137, span: 4321 };
  for (const seconds of [w.offset, w.offset + 1000, w.offset + w.span]) {
    assertAlmostEquals(fromFraction(w, toFraction(w, seconds)), seconds, 1e-9);
  }
  assertEquals(toFraction(w, w.offset), 0);
  assertEquals(toFraction(w, w.offset + w.span), 1);
});

Deno.test("tickStep coarsens with the span and always yields at least four ticks", () => {
  assertEquals(tickStep(DAY), 10800);
  assertEquals(tickStep(6 * 3600), 3600);
  assertEquals(tickStep(3 * 3600), 1800);
  assertEquals(tickStep(3600), 900);
  assertEquals(tickStep(900), 120);
  assertEquals(tickStep(MIN_SPAN), 60);
  for (const span of [DAY, 12 * 3600, 3600, 600, MIN_SPAN]) {
    assert(span / tickStep(span) >= 4 || tickStep(span) === 60);
  }
});

Deno.test("ticks are aligned to the step and stay within the window", () => {
  const w = { offset: 3700, span: 7200 };
  const t = ticks(w);
  assert(t.length > 0);
  for (const { seconds } of t) {
    assertEquals(seconds % tickStep(w.span), 0);
    assert(seconds >= w.offset && seconds <= w.offset + w.span);
  }
  assertEquals(ticks(fullDay())[0], { seconds: 0, label: "00h" });
});

Deno.test("tick labels drop to minutes once the step is sub-hourly", () => {
  const labels = ticks({ offset: 0, span: 3600 }).map((t) => t.label);
  // Once the step is sub-hourly every label carries minutes, so the ladder
  // reads consistently instead of mixing "00h" with "00:15".
  assertEquals(labels, ["00:00", "00:15", "00:30", "00:45", "01:00"]);
});
