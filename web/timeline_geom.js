// Zoom/pan maths for the day timelines, kept free of the DOM so it can be
// tested without a browser. A "window" is the visible slice of one local day:
// `offset` seconds since local midnight, `span` seconds wide.

export const DAY = 86400;
/** Below a minute the blocks stop carrying information and the ticks collide. */
export const MIN_SPAN = 60;

/** Snap a window back inside the day. Widening past a day is a full reset. */
export function clampWindow({ offset, span }) {
  const s = Math.min(DAY, Math.max(MIN_SPAN, span));
  const o = Math.min(DAY - s, Math.max(0, offset));
  return { offset: o, span: s };
}

export function fullDay() {
  return { offset: 0, span: DAY };
}

/**
 * Zoom by `factor` (>1 zooms in) while holding the time under `frac` still.
 * `frac` is the anchor's position along the axis, 0 = start, 1 = end.
 */
export function zoomAt(window, factor, frac) {
  const anchor = fromFraction(window, frac);
  const span = Math.min(DAY, Math.max(MIN_SPAN, window.span / factor));
  return clampWindow({ offset: anchor - frac * span, span });
}

/** Pan by a fraction of the current span; positive moves the window later. */
export function panBy(window, fracDelta) {
  return clampWindow({ ...window, offset: window.offset + fracDelta * window.span });
}

export function toFraction({ offset, span }, seconds) {
  return (seconds - offset) / span;
}

export function fromFraction({ offset, span }, frac) {
  return offset + frac * span;
}

// The 300 -> 60 gap is too wide on its own: a 15 min window would jump
// straight to 15 minute-ticks, so 120 sits in between.
const TICK_STEPS = [10800, 3600, 1800, 900, 300, 120, 60];

/** The coarsest step that still yields at least four ticks across the window. */
export function tickStep(span) {
  for (const step of TICK_STEPS) {
    if (span / step >= 4) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Tick positions covering the window, aligned to whole multiples of the step.
 * Labels drop the seconds; at a 3 h step the familiar `06h` form is kept.
 */
export function ticks(window) {
  const step = tickStep(window.span);
  const end = window.offset + window.span;
  const out = [];
  for (let t = Math.ceil(window.offset / step) * step; t <= end; t += step) {
    out.push({ seconds: t, label: tickLabel(t, step) });
  }
  return out;
}

function tickLabel(seconds, step) {
  const clamped = Math.min(DAY, Math.max(0, Math.round(seconds)));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  if (step >= 3600 && m === 0) return `${String(h).padStart(2, "0")}h`;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
