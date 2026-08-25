import { fetchCameras, fetchEvent, fetchHistogram, reindex as apiReindex } from "./api.js";
import { renderChips } from "./chips.js";
import { assignCameraColors } from "./colors.js";
import * as daybar from "./daybar.js";
import * as daytimeline from "./daytimeline.js";
import { clearDayCache } from "./days.js";
import * as density from "./density.js";
import { setTimezone, shortDate } from "./format.js";
import * as list from "./list.js";
import { initState, state, subscribe, update } from "./state.js";
import * as viewer from "./viewer.js";

const FOURTEEN_DAYS = 14 * 86400;

let cameras = [];

function watchTopbarHeight() {
  const topbar = document.querySelector(".topbar");
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  });
  ro.observe(topbar);
}

function paintCameraCaches() {
  list.setCameras(cameras);
  density.setCameras(cameras);
  daytimeline.setCameras(cameras);
  viewer.setCameras(cameras);
}

function renderChipsNow() {
  renderChips(document.getElementById("camera-chips"), cameras, state.cameras);
}

function updateRangeBar() {
  const bar = document.getElementById("range-bar");
  const label = document.getElementById("range-label");
  if (state.from != null && state.to != null) {
    bar.classList.remove("hidden");
    label.textContent = `${shortDate(state.from)} – ${shortDate(state.to)}`;
  } else {
    bar.classList.add("hidden");
  }
}

function histogramRange() {
  if (state.bucket === "day") return {};
  if (state.from != null && state.to != null) return { from: state.from, to: state.to };
  const to = Math.floor(Date.now() / 1000);
  return { from: to - FOURTEEN_DAYS, to };
}

async function refreshDensity() {
  const range = histogramRange();
  const data = await fetchHistogram({ cameras: state.cameras, bucket: state.bucket, ...range });
  density.renderDensity(data, { bucket: state.bucket, from: state.from, to: state.to });

  const hint = document.getElementById("timeline-hint");
  const capped = state.bucket === "hour" && !(state.from != null && state.to != null);
  hint.textContent = capped
    ? "Drag to select a range · click a bar to filter that day · the hour view covers the last 14 days"
    : "Drag to select a range · click a bar to filter that day";
}

async function resolveEvent(id) {
  const found = list.loadedEvents().find((e) => e.id === id);
  if (found) return found;
  try {
    return await fetchEvent(id);
  } catch {
    return null;
  }
}

async function openFromState() {
  if (!state.event) {
    viewer.closeViewer();
    daybar.setCurrentEvent(null);
    return;
  }
  const event = await resolveEvent(state.event);
  if (!event) {
    update({ event: null }, { replace: true });
    return;
  }
  viewer.openViewer(event);
  daybar.setCurrentEvent(event);
}

function wireTopControls() {
  document.getElementById("reindex").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await apiReindex();
      clearDayCache();
      const res = await fetchCameras();
      cameras = res.cameras;
      setTimezone(res.displayTz);
      assignCameraColors(cameras);
      paintCameraCaches();
      renderChipsNow();
      await refreshDensity();
      list.refresh();
      daybar.refresh();
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("range-clear").addEventListener("click", () => {
    update({ from: null, to: null });
  });

  document.querySelectorAll(".bucket-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => update({ bucket: btn.dataset.bucket }));
  });
}

function wireStateSubscription() {
  let prevCameras = JSON.stringify(state.cameras);
  let prevFrom = state.from;
  let prevTo = state.to;
  let prevBucket = state.bucket;
  let prevEvent = state.event;

  subscribe(() => {
    const camerasChanged = JSON.stringify(state.cameras) !== prevCameras;
    const rangeChanged = state.from !== prevFrom || state.to !== prevTo;
    const bucketChanged = state.bucket !== prevBucket;
    const eventChanged = state.event !== prevEvent;

    if (camerasChanged) renderChipsNow();
    if (rangeChanged) updateRangeBar();
    if (camerasChanged || rangeChanged) {
      list.refresh();
      daybar.refresh();
    }

    if (camerasChanged || bucketChanged) {
      refreshDensity();
    } else if (rangeChanged) {
      density.updateBrush(state.from, state.to);
    }

    if (bucketChanged) {
      document.querySelectorAll(".bucket-toggle button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.bucket === state.bucket);
      });
    }

    if (eventChanged) openFromState();

    prevCameras = JSON.stringify(state.cameras);
    prevFrom = state.from;
    prevTo = state.to;
    prevBucket = state.bucket;
    prevEvent = state.event;
  });
}

async function main() {
  initState();
  watchTopbarHeight();

  const res = await fetchCameras();
  cameras = res.cameras;
  setTimezone(res.displayTz);
  assignCameraColors(cameras);
  paintCameraCaches();

  list.initList({ onOpen: (event) => update({ event: event.id }) });
  density.initDensity(document.getElementById("density"));
  viewer.initViewer({ onStep: (event) => daybar.setCurrentEvent(event) });
  daybar.initDaybar();

  renderChipsNow();
  updateRangeBar();
  wireTopControls();
  wireStateSubscription();

  await refreshDensity();
  list.refresh();
  daybar.refresh();
  await openFromState();
}

main().catch((err) => {
  console.error("startup failed:", err);
});
