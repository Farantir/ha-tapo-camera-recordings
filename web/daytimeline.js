import { clock, duration, escapeXml } from "./format.js";
import { hideTooltip, showTooltip } from "./tooltip.js";
import { fullDay, zoomAt } from "./timeline_geom.js";
import { BLOCK_CLASS, cameraLabel, createPainter, setCameras } from "./daytimeline_draw.js";
import { createGestures } from "./daytimeline_input.js";

export { setCameras };

/**
 * A 24 h swimlane chart of one day, zoomable and pannable by wheel, drag and
 * pinch. Instance-based because the viewer and the overview day bar show one
 * each, with independent zoom.
 *
 * This module holds the state — which day, which events, how far zoomed in —
 * and delegates: `daytimeline_draw.js` turns that state into SVG, and
 * `daytimeline_input.js` turns gestures back into window changes.
 */
export function createDayTimeline(container, { orientation = "horizontal", onPick } = {}) {
  const painter = createPainter(container, orientation);

  let win = fullDay();
  let events = [];
  let cams = [];
  let current = null;
  let day = null;

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  // Gestures are wired once, on the container: `draw()` replaces the <svg>
  // wholesale, so an svg holding pointer capture would be torn out mid-drag.
  const gestures = createGestures(container, {
    targetSelector: `.${BLOCK_CLASS}`,
    ready: painter.ready,
    timeLen: painter.timeLen,
    fractionAt: painter.fractionAt,
    getWindow: () => win,
    setWindow: (next) => {
      win = next;
      draw();
    },
    onPick: (el) => onPick?.(el.dataset.id),
    onHover: showBlockTooltip,
    onHoverEnd: hideTooltip,
  });

  function draw() {
    painter.draw({ events, cams, current, win });
  }

  function render(next) {
    // A new day is a new context, so zoom starts over; re-rendering the same
    // day (a step to a sibling event) keeps whatever the user zoomed to.
    if (next.day !== day) {
      day = next.day;
      win = fullDay();
    }
    events = next.events ?? [];
    current = next.current ?? null;
    cams = [...new Set(events.map((e) => e.camera))].sort();
    draw();
  }

  function setCurrent(event) {
    current = event;
    draw();
  }

  function zoomIn() {
    win = zoomAt(win, 2, 0.5);
    draw();
  }

  function zoomOut() {
    win = zoomAt(win, 0.5, 0.5);
    draw();
  }

  function reset() {
    win = fullDay();
    draw();
  }

  function showBlockTooltip(block, x, y) {
    const event = events.find((ev) => ev.id === block.dataset.id);
    if (!event) return;
    showTooltip(
      `<strong>${clock(event.start)}</strong><br>${escapeXml(cameraLabel(event.camera))}<br>${
        duration(event.duration)
      }`,
      x,
      y,
    );
  }

  function destroy() {
    ro.disconnect();
    gestures.destroy();
    hideTooltip();
    painter.clear();
  }

  return { render, setCurrent, zoomIn, zoomOut, reset, destroy };
}
