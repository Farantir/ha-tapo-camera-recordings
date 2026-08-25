import { thumbUrl, videoUrl } from "./api.js";
import { displayLabel } from "./chips.js";
import { createDayTimeline } from "./daytimeline.js";
import { fetchDayEvents } from "./days.js";
import { clock, duration, longDate, relativeAge } from "./format.js";
import { ensureMore, loadedEvents } from "./list.js";
import { state, update } from "./state.js";

let root;
let onStepCb;
let current = null;
let lastFocused = null;
let timeline = null;
let cameraLabels = new Map();

export function setCameras(cameras) {
  cameraLabels = new Map(cameras.map((c) => [c.id, displayLabel(c)]));
}

export function initViewer({ onStep }) {
  root = document.getElementById("viewer");
  onStepCb = onStep;

  document.addEventListener("keydown", (e) => {
    if (root.classList.contains("hidden")) return;
    if (e.key === "Escape" && !document.fullscreenElement) update({ event: null });
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", syncFullscreenButton);
}

export function openViewer(event) {
  const fresh = timeline === null;
  current = event;

  if (fresh) {
    lastFocused = document.activeElement;
    build();
  }

  fillHead(event);
  renderStage(event);

  root.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (fresh) root.querySelector('[data-nav="close"]').focus();

  loadDayTimeline(event);
}

export function closeViewer() {
  if (!root) return;
  const video = root.querySelector("video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  timeline?.destroy();
  timeline = null;
  root.classList.add("hidden");
  root.replaceChildren();
  document.body.style.overflow = "";
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  current = null;
}

/**
 * Built once per opening, not once per event: stepping with the arrow keys
 * only swaps the media and the head, so the day timeline keeps its zoom and
 * the close button keeps focus.
 */
function build() {
  root.innerHTML = `
    <div class="viewer-head">
      <div class="viewer-title">
        <span class="when"></span>
        <span class="sub"></span>
      </div>
      <div class="spacer"></div>
      <div class="viewer-nav">
        <button type="button" class="ghost" data-nav="prev" aria-label="Previous event">‹</button>
        <button type="button" class="ghost" data-nav="next" aria-label="Next event">›</button>
        <button type="button" class="ghost" data-nav="fullscreen" aria-pressed="false" title="Fullscreen (f)" aria-label="Fullscreen">⛶</button>
        <button type="button" class="ghost" data-nav="close">Close</button>
      </div>
    </div>
    <div class="viewer-stage"></div>
    <div class="viewer-foot">
      <div class="foot-head">
        <h3>Day timeline</h3>
        <div class="zoom-controls" role="group" aria-label="Zoom timeline">
          <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
          <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
          <button type="button" data-zoom="reset" aria-label="Whole day">⤢</button>
        </div>
      </div>
      <div class="day-timeline"></div>
    </div>
  `;

  root.querySelector('[data-nav="prev"]').addEventListener("click", () => step(-1));
  root.querySelector('[data-nav="next"]').addEventListener("click", () => step(1));
  root.querySelector('[data-nav="fullscreen"]').addEventListener("click", toggleFullscreen);
  root.querySelector('[data-nav="close"]').addEventListener("click", () => update({ event: null }));

  timeline = createDayTimeline(root.querySelector(".day-timeline"), {
    orientation: "horizontal",
    onPick: (id) => update({ event: id }, { replace: true }),
  });

  root.querySelector('[data-zoom="in"]').addEventListener("click", () => timeline.zoomIn());
  root.querySelector('[data-zoom="out"]').addEventListener("click", () => timeline.zoomOut());
  root.querySelector('[data-zoom="reset"]').addEventListener("click", () => timeline.reset());
  syncFullscreenButton();
}

/**
 * Fullscreen targets the whole viewer rather than the `<video>`, so the day
 * timeline stays reachable. iOS Safari has no element fullscreen, only the
 * video's own — fall back to that there.
 */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (root.requestFullscreen) {
    root.requestFullscreen().catch(() => {});
    return;
  }
  root.querySelector("video")?.webkitEnterFullscreen?.();
}

function syncFullscreenButton() {
  const btn = root?.querySelector('[data-nav="fullscreen"]');
  if (!btn) return;
  const on = document.fullscreenElement === root;
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Exit fullscreen (f)" : "Fullscreen (f)";
}

function fillHead(event) {
  root.querySelector(".when").textContent = clock(event.start);
  root.querySelector(".sub").textContent = [
    cameraLabels.get(event.camera) ?? event.camera,
    longDate(event.start),
    duration(event.duration),
    relativeAge(event.start),
  ].join(" · ");
}

function renderStage(event) {
  const stage = root.querySelector(".viewer-stage");
  stage.replaceChildren();

  if (event.hasVideo) {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (event.hasThumb) video.poster = thumbUrl(event);
    video.src = videoUrl(event);
    stage.appendChild(video);
    return;
  }

  if (event.hasThumb) {
    const img = document.createElement("img");
    img.src = thumbUrl(event);
    img.alt = "";
    stage.appendChild(img);
  }

  const note = document.createElement("div");
  note.className = "no-video";
  note.textContent = "no video in this backup";
  stage.appendChild(note);
}

async function step(delta) {
  if (!current) return;
  const list = loadedEvents();
  const idx = list.findIndex((e) => e.id === current.id);
  if (idx === -1) return;

  const nextIdx = idx + delta;
  if (nextIdx < 0) return;

  if (nextIdx >= list.length) {
    if (delta <= 0) return;
    await ensureMore();
    const refreshed = loadedEvents();
    if (nextIdx >= refreshed.length) return; // truly the last loaded event
    current = refreshed[nextIdx];
  } else {
    current = list[nextIdx];
  }

  update({ event: current.id }, { replace: true });
  onStepCb?.(current);
}

async function loadDayTimeline(event) {
  const dayStart = event.start - event.secondsOfDay;

  let dayEvents;
  try {
    dayEvents = await fetchDayEvents(event.day, dayStart, state.cameras);
  } catch {
    return;
  }

  if (!current || current.day !== event.day || !timeline) return; // moved on while in flight

  // Same day means the same timeline window, so zoom survives stepping.
  timeline.render({ events: dayEvents, day: event.day, current });
}
