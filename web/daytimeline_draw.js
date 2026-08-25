import { displayLabel } from "./chips.js";
import { escapeXml } from "./format.js";
import { cameraColor } from "./colors.js";
import { DAY, ticks, toFraction } from "./timeline_geom.js";

// One event's block never shrinks below this, or a 2 s recording disappears.
const MIN_BLOCK = 2;
const LANE_GAP = 4;

// Geometry per orientation. "time" is the axis the day runs along, "cross" the
// one the camera lanes stack on; everything below is written once in those
// terms and mapped to x/y at the last moment.
const LAYOUT = {
  horizontal: { timeStart: 80, timeEnd: 8, crossStart: 4, crossEnd: 18, laneSize: 16 },
  vertical: { timeStart: 70, timeEnd: 8, crossStart: 42, crossEnd: 6, laneSize: null },
};

let cameraLabels = new Map();
let uid = 0;

export function setCameras(cameras) {
  cameraLabels = new Map(cameras.map((c) => [c.id, displayLabel(c)]));
}

export function cameraLabel(id) {
  return cameraLabels.get(id) ?? id;
}

/** The class the painter puts on an event block; gestures target it by name. */
export const BLOCK_CLASS = "block";

/**
 * Owns the <svg> and the measured geometry behind it: everything from
 * "here is a day's worth of events" down to markup, plus the pixel->axis
 * conversion that pointer handling needs. Knows nothing about input.
 */
export function createPainter(container, orientation) {
  const vertical = orientation === "vertical";
  const L = LAYOUT[orientation];
  const clipId = `dt-clip-${++uid}`;

  let geom = null;
  let svgEl = null;

  function measure(laneCount) {
    const width = container.clientWidth;
    const lanes = Math.max(1, laneCount);

    if (vertical) {
      const height = container.clientHeight;
      if (!width || !height) return null;
      const crossLen = Math.max(0, width - L.crossStart - L.crossEnd);
      const laneSize = Math.max(6, (crossLen - LANE_GAP * (lanes - 1)) / lanes);
      return {
        width,
        height,
        timeLen: Math.max(0, height - L.timeStart - L.timeEnd),
        crossLen,
        laneSize,
      };
    }

    const laneSize = L.laneSize;
    const crossLen = lanes * laneSize + (lanes - 1) * LANE_GAP;
    return {
      width,
      height: L.crossStart + crossLen + L.crossEnd,
      timeLen: Math.max(0, width - L.timeStart - L.timeEnd),
      crossLen,
      laneSize,
    };
  }

  /** Axis-space rect -> an SVG rect's x/y/width/height. */
  function place(timePos, timeLen, crossPos, crossLen) {
    return vertical
      ? { x: crossPos, y: timePos, width: crossLen, height: timeLen }
      : { x: timePos, y: crossPos, width: timeLen, height: crossLen };
  }

  function timeAt(frac) {
    return L.timeStart + frac * geom.timeLen;
  }

  function laneAt(i) {
    return L.crossStart + i * (geom.laneSize + LANE_GAP);
  }

  function attrs(r) {
    return `x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" ` +
      `width="${Math.max(0, r.width).toFixed(2)}" height="${Math.max(0, r.height).toFixed(2)}"`;
  }

  function laneBackgrounds(cams) {
    return cams
      .map((_cam, i) => {
        const bg = place(L.timeStart, geom.timeLen, laneAt(i), geom.laneSize);
        return `<rect class="lane-bg" ${attrs(bg)} rx="2"></rect>`;
      })
      .join("");
  }

  function axis(win) {
    let out = "";
    for (const tick of ticks(win)) {
      const pos = timeAt(toFraction(win, tick.seconds)).toFixed(2);
      const far = L.crossStart + geom.crossLen;
      out += vertical
        ? `<line class="tick" x1="${L.crossStart}" y1="${pos}" x2="${far}" y2="${pos}"></line>` +
          `<text class="tick-label" x="${L.crossStart - 6}" y="${pos}" ` +
          `text-anchor="end" dominant-baseline="middle">${tick.label}</text>`
        : `<line class="tick" x1="${pos}" y1="${L.crossStart}" x2="${pos}" y2="${far}"></line>` +
          `<text class="tick-label" x="${pos}" y="${far + 12}" ` +
          `text-anchor="middle">${tick.label}</text>`;
    }
    return out;
  }

  function blocks(events, cams, current, win) {
    let out = "";
    for (const e of events) {
      const lane = cams.indexOf(e.camera);
      if (lane === -1) continue;
      const f0 = toFraction(win, e.secondsOfDay);
      const f1 = toFraction(win, e.secondsOfDay + e.duration);
      if (f1 < 0 || f0 > 1) continue; // outside the zoom window
      const len = Math.max(MIN_BLOCK, (f1 - f0) * geom.timeLen);
      const r = place(timeAt(f0), len, laneAt(lane), geom.laneSize);
      const isCurrent = current && e.id === current.id;
      out += `<rect class="${BLOCK_CLASS}${isCurrent ? " current" : ""}" ` +
        `data-id="${escapeXml(e.id)}" ${attrs(r)} fill="${cameraColor(e.camera)}"></rect>`;
    }
    return `<g clip-path="url(#${clipId})">${out}</g>`;
  }

  function laneLabels(cams) {
    return cams
      .map((cam, i) => {
        const mid = (laneAt(i) + geom.laneSize / 2).toFixed(2);
        const label = escapeXml(truncate(cameraLabel(cam), vertical ? 12 : 14));
        const near = L.timeStart - 8;
        return vertical
          ? `<text class="lane-label" x="${mid}" y="${near}" text-anchor="start" ` +
            `transform="rotate(-90 ${mid} ${near})">${label}</text>`
          : `<text class="lane-label" x="${near}" y="${mid}" text-anchor="end">${label}</text>`;
      })
      .join("");
  }

  /** Returns false when the container has no measurable size yet. */
  function draw({ events, cams, current, win }) {
    geom = measure(cams.length);
    if (!geom) return false;

    const plot = place(L.timeStart, geom.timeLen, L.crossStart, geom.crossLen);
    container.innerHTML = `<svg viewBox="0 0 ${geom.width} ${geom.height}" width="${geom.width}" ` +
      `height="${geom.height}">` +
      `<defs><clipPath id="${clipId}"><rect ${attrs(plot)}></rect></clipPath></defs>` +
      laneBackgrounds(cams) +
      `<rect class="hitbox" ${attrs(plot)}></rect>` +
      axis(win) +
      blocks(events, cams, current, win) +
      laneLabels(cams) +
      `</svg>`;

    svgEl = container.querySelector("svg");
    svgEl.classList.toggle("zoomed", win.span < DAY);
    return true;
  }

  /** Pointer position as a 0..1 fraction along the time axis of the plot. */
  function fractionAt(event) {
    if (!svgEl || !geom) return 0;
    const rect = svgEl.getBoundingClientRect();
    const scale = (vertical ? rect.height / geom.height : rect.width / geom.width) || 1;
    const local = vertical
      ? (event.clientY - rect.top) / scale
      : (event.clientX - rect.left) / scale;
    return (local - L.timeStart) / (geom.timeLen || 1);
  }

  function clear() {
    container.replaceChildren();
    svgEl = null;
    geom = null;
  }

  return {
    draw,
    fractionAt,
    clear,
    ready: () => geom !== null,
    timeLen: () => geom?.timeLen ?? 0,
  };
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
