import { displayLabel } from "./chips.js";
import { cameraColor } from "./colors.js";
import { dayMonth, escapeXml, plural } from "./format.js";
import { update } from "./state.js";
import { hideTooltip, showTooltip } from "./tooltip.js";

const LEFT = 92;
const RIGHT = 8;
const LANE_H = 14;
const LANE_GAP = 3;
const AXIS_H = 14;
const TOP_PAD = 4;
const BOTTOM_PAD = 4;
const MIN_LABEL_GAP = 56;
const DRAG_THRESHOLD = 4;

let containerEl, svgEl, ro;
let cameraLabels = new Map();
let lastData = null;
let lastView = null;
let geom = null; // { buckets, lanes, barWidth, plotWidth, plotHeight, stepSeconds, width }
let dragging = false;
let dragStartX = null;

export function setCameras(cameras) {
  cameraLabels = new Map(cameras.map((c) => [c.id, displayLabel(c)]));
}

export function initDensity(container) {
  containerEl = container;
  ro = new ResizeObserver(() => {
    if (lastData) renderDensity(lastData, lastView);
  });
  ro.observe(container);
}

export function renderDensity(data, view) {
  lastData = data;
  lastView = view;

  const width = containerEl.clientWidth || 600;
  const stepSeconds = view.bucket === "hour" ? 3600 : 86400;
  const buckets = fillGaps(data.buckets, stepSeconds);
  const lanes = data.cameras;

  const n = Math.max(1, buckets.length);
  const plotWidth = Math.max(0, width - LEFT - RIGHT);
  const barWidth = Math.max(1, Math.floor(plotWidth / n));
  const laneStep = LANE_H + LANE_GAP;
  const plotHeight = lanes.length ? lanes.length * laneStep - LANE_GAP : 0;
  const height = TOP_PAD + plotHeight + AXIS_H + BOTTOM_PAD;

  geom = { buckets, lanes, barWidth, plotWidth, plotHeight, stepSeconds, width };

  const maxCount = buckets.reduce((m, b) => Math.max(m, b.total), 1);

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;

  lanes.forEach((cam, i) => {
    const y = TOP_PAD + i * laneStep;
    svg +=
      `<rect class="lane-bg" x="${LEFT}" y="${y}" width="${plotWidth}" height="${LANE_H}" rx="2"></rect>`;
    svg += `<text class="lane-label" x="${LEFT - 8}" y="${y + LANE_H / 2}" text-anchor="end">${
      escapeXml(cameraLabels.get(cam) ?? cam)
    }</text>`;
  });

  buckets.forEach((b, i) => {
    const x = LEFT + i * barWidth;
    lanes.forEach((cam, li) => {
      const count = b.counts[cam] ?? 0;
      if (!count) return;
      const y = TOP_PAD + li * laneStep;
      const op = (0.2 + 0.8 * (count / maxCount)).toFixed(2);
      svg += `<rect class="bar" x="${x}" y="${y}" width="${barWidth}" height="${LANE_H}" fill="${
        cameraColor(cam)
      }" fill-opacity="${op}"></rect>`;
    });
  });

  const everyN = Math.max(1, Math.ceil(MIN_LABEL_GAP / barWidth));
  const axisY = TOP_PAD + plotHeight + AXIS_H - 3;
  for (let i = 0; i < buckets.length; i += everyN) {
    const x = LEFT + i * barWidth + barWidth / 2;
    svg += `<text class="axis" x="${x}" y="${axisY}" text-anchor="middle">${
      dayMonth(buckets[i].start)
    }</text>`;
  }

  svg +=
    `<rect class="brush hidden" x="${LEFT}" y="${TOP_PAD}" width="0" height="${plotHeight}"></rect>`;
  svg +=
    `<rect class="hitbox" x="${LEFT}" y="${TOP_PAD}" width="${plotWidth}" height="${plotHeight}"></rect>`;
  svg += `</svg>`;

  containerEl.innerHTML = svg;
  svgEl = containerEl.querySelector("svg");
  wireInteraction();
  drawBrush(view.from, view.to);
}

export function updateBrush(from, to) {
  if (lastView) lastView = { ...lastView, from, to };
  drawBrush(from, to);
}

function fillGaps(buckets, stepSeconds) {
  if (buckets.length === 0) return [];
  const filled = [buckets[0]];
  for (let i = 1; i < buckets.length; i++) {
    const prev = filled[filled.length - 1];
    const curr = buckets[i];
    const gap = Math.max(1, Math.round((curr.start - prev.start) / stepSeconds));
    for (let g = 1; g < gap; g++) {
      filled.push({ key: null, start: prev.start + g * stepSeconds, counts: {}, total: 0 });
    }
    filled.push(curr);
  }
  return filled;
}

function bucketIndexForTime(ts) {
  const first = geom.buckets[0].start;
  const idx = Math.floor((ts - first) / geom.stepSeconds);
  return Math.min(Math.max(idx, 0), geom.buckets.length - 1);
}

function drawBrush(from, to) {
  if (!svgEl) return;
  const brush = svgEl.querySelector(".brush");
  if (from == null || to == null || !geom || geom.buckets.length === 0) {
    brush.classList.add("hidden");
    return;
  }
  const i0 = bucketIndexForTime(from);
  const i1 = bucketIndexForTime(to);
  const lo = Math.min(i0, i1);
  const hi = Math.max(i0, i1);
  brush.setAttribute("x", String(LEFT + lo * geom.barWidth));
  brush.setAttribute("width", String(Math.max(1, (hi - lo + 1) * geom.barWidth)));
  brush.classList.remove("hidden");
}

function localX(clientX, rect) {
  const scale = rect.width / geom.width;
  return (clientX - rect.left) / scale - LEFT;
}

function bucketIndexForLocalX(x) {
  return Math.min(Math.max(Math.floor(x / geom.barWidth), 0), geom.buckets.length - 1);
}

function wireInteraction() {
  const hitbox = svgEl.querySelector(".hitbox");
  const brush = svgEl.querySelector(".brush");

  hitbox.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragStartX = e.clientX;
    hitbox.setPointerCapture(e.pointerId);
  });

  hitbox.addEventListener("pointermove", (e) => {
    const rect = svgEl.getBoundingClientRect();
    const x = localX(e.clientX, rect);

    if (dragging) {
      const startX = localX(dragStartX, rect);
      const lo = Math.max(0, Math.min(startX, x));
      const hi = Math.min(geom.plotWidth, Math.max(startX, x));
      brush.setAttribute("x", String(LEFT + lo));
      brush.setAttribute("width", String(Math.max(1, hi - lo)));
      brush.classList.remove("hidden");
      hideTooltip();
    } else {
      const idx = bucketIndexForLocalX(x);
      showBucketTooltip(geom.buckets[idx], e.clientX, e.clientY);
    }
  });

  hitbox.addEventListener("pointerleave", () => {
    if (!dragging) hideTooltip();
  });

  hitbox.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = svgEl.getBoundingClientRect();
    const startX = localX(dragStartX, rect);
    const endX = localX(e.clientX, rect);

    if (Math.abs(endX - startX) < DRAG_THRESHOLD) {
      const idx = bucketIndexForLocalX(endX);
      const b = geom.buckets[idx];
      update({ from: b.start, to: b.start + geom.stepSeconds - 1 });
    } else {
      const i0 = bucketIndexForLocalX(startX);
      const i1 = bucketIndexForLocalX(endX);
      const lo = Math.min(i0, i1);
      const hi = Math.max(i0, i1);
      update({ from: geom.buckets[lo].start, to: geom.buckets[hi].start + geom.stepSeconds - 1 });
    }
  });
}

function showBucketTooltip(bucket, x, y) {
  if (!bucket || bucket.total === 0) {
    hideTooltip();
    return;
  }
  const lines = geom.lanes
    .filter((cam) => bucket.counts[cam])
    .map((cam) => `${escapeXml(cameraLabels.get(cam) ?? cam)}: ${bucket.counts[cam]}`)
    .join("<br>");
  showTooltip(
    `<strong>${dayMonth(bucket.start)}</strong><br>${
      lines || plural(bucket.total, "event", "events")
    }`,
    x,
    y,
  );
}
