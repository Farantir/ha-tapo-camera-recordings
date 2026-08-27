import { cameraThumbUrl, fetchEvents, hasThumb, thumbUrl } from "./api.js";
import { displayLabel, tagLabel } from "./chips.js";
import { cameraColor } from "./colors.js";
import { clock, dayHeading, duration, plural, relativeAge } from "./format.js";
import { filterKey, state, update } from "./state.js";
import { observeThumb, resetThumbs } from "./thumbs.js";

const PAGE_LIMIT = 60;

let listEl, statusEl, countEl, sentinelEl, onOpenCb;
let cameraLabels = new Map();

let events = [];
let cursor = null;
let total = 0;
let loading = false;
let done = false;
let key = null;

let lastDayRendered = null;
let lastDayHeadEl = null;
let dayCount = 0;

export function setCameras(cameras) {
  cameraLabels = new Map(cameras.map((c) => [c.id, displayLabel(c)]));
}

export function initList({ onOpen }) {
  listEl = document.getElementById("list");
  statusEl = document.getElementById("list-status");
  countEl = document.getElementById("result-count");
  sentinelEl = document.getElementById("sentinel");
  onOpenCb = onOpen;

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) ensureMore();
  }, { rootMargin: "600px 0px" });
  io.observe(sentinelEl);
}

export function loadedEvents() {
  return events;
}

export function refresh() {
  key = filterKey();
  events = [];
  cursor = null;
  total = 0;
  done = false;
  loading = false;
  lastDayRendered = null;
  lastDayHeadEl = null;
  dayCount = 0;
  listEl.replaceChildren();
  resetThumbs();
  loadMore();
}

export function ensureMore() {
  return loadMore();
}

async function loadMore() {
  if (loading || done) return;
  loading = true;
  const requestKey = key;
  setStatus("Loading …");

  try {
    const result = await fetchEvents({
      cameras: state.cameras,
      tags: state.tags,
      from: state.from,
      to: state.to,
      cursor,
      limit: PAGE_LIMIT,
    });
    if (requestKey !== key) return; // filter changed while this page was in flight

    total = result.total;
    cursor = result.nextCursor;
    done = cursor === null;
    events = events.concat(result.events);
    appendRows(result.events);
    updateCount();

    if (events.length === 0) {
      showEmptyState();
    } else {
      setStatus(done ? "No more events" : "");
    }
  } catch (err) {
    if (requestKey !== key) return;
    showError(err);
  } finally {
    if (requestKey === key) loading = false;
  }
}

function appendRows(newEvents) {
  const frag = document.createDocumentFragment();
  const thumbBoxes = [];

  for (const event of newEvents) {
    if (event.day !== lastDayRendered) {
      lastDayRendered = event.day;
      dayCount = 0;
      lastDayHeadEl = document.createElement("div");
      lastDayHeadEl.className = "day-head";
      // The day bar reads these instead of redoing timezone maths client-side.
      lastDayHeadEl.dataset.day = event.day;
      lastDayHeadEl.dataset.dayStart = String(event.start - event.secondsOfDay);
      lastDayHeadEl.innerHTML = `<span>${
        dayHeading(event.start, event.day)
      }</span><span class="n"></span>`;
      frag.appendChild(lastDayHeadEl);
    }
    dayCount++;
    lastDayHeadEl.querySelector(".n").textContent = plural(dayCount, "event", "events");

    const { row, thumbBox } = buildRow(event);
    frag.appendChild(row);
    if (thumbBox) thumbBoxes.push(thumbBox);
  }

  listEl.appendChild(frag);
  for (const box of thumbBoxes) observeThumb(box);
}

function buildRow(event) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "event";
  btn.dataset.id = event.id;

  const thumb = document.createElement("div");
  const pictured = hasThumb(event);
  thumb.className = "thumb" + (pictured ? "" : " missing");

  let thumbBox = null;
  if (pictured) {
    thumb.dataset.src = thumbUrl(event);
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("load", () => img.classList.add("ready"));
    if (event.eventThumb != null && event.hasThumb) {
      // The tagger's thumbnails live on their own volume and can be cleared
      // independently of the sidecar that lists them. Fall back to the
      // camera's own picture rather than leaving a grey rectangle.
      img.addEventListener("error", () => {
        // The box holds the URL the lazy loader re-attaches from, so it has to
        // change too — otherwise the missing picture comes back the next time
        // this row scrolls into view.
        thumb.dataset.src = cameraThumbUrl(event);
        img.src = thumb.dataset.src;
      }, { once: true });
    }
    thumb.appendChild(img);
    thumbBox = thumb;
  }

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = duration(event.duration);
  thumb.appendChild(badge);

  if (!event.hasVideo) {
    const nv = document.createElement("span");
    nv.className = "novideo";
    nv.title = "no video in this backup";
    nv.textContent = "no video";
    thumb.appendChild(nv);
  }

  const meta = document.createElement("div");
  meta.className = "event-meta";

  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = clock(event.start);

  const sub = document.createElement("span");
  sub.className = "event-sub";

  const camTag = document.createElement("span");
  camTag.className = "cam-tag";
  camTag.style.setProperty("--dot", cameraColor(event.camera));
  const dot = document.createElement("span");
  dot.className = "dot";
  camTag.appendChild(dot);
  camTag.appendChild(document.createTextNode(cameraLabels.get(event.camera) ?? event.camera));
  sub.appendChild(camTag);

  const durSpan = document.createElement("span");
  durSpan.textContent = duration(event.duration);
  sub.appendChild(durSpan);

  const ageSpan = document.createElement("span");
  ageSpan.textContent = relativeAge(event.start);
  sub.appendChild(ageSpan);

  if (event.label) {
    const tag = document.createElement("span");
    // The row shows only the deepest resolved name; the rest of the chain is
    // what the filter matches on, and would just be noise here.
    tag.className = "row-tag" + (event.label === "no_event" ? " quiet" : "");
    tag.textContent = tagLabel(event.label);
    sub.appendChild(tag);
  }

  meta.append(time, sub);
  btn.append(thumb, meta);
  btn.addEventListener("click", () => onOpenCb?.(event));

  return { row: btn, thumbBox };
}

function setStatus(text) {
  statusEl.replaceChildren();
  statusEl.textContent = text;
}

function showError() {
  statusEl.replaceChildren();
  const span = document.createElement("span");
  span.textContent = "Could not load. ";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost small";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => loadMore());
  statusEl.append(span, retry);
}

function updateCount() {
  countEl.textContent = plural(total, "event", "events");
}

function showEmptyState() {
  setStatus("");
  const div = document.createElement("div");
  div.className = "empty-state";
  div.textContent = "No events match this filter. ";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "ghost small";
  reset.textContent = "Reset filters";
  reset.addEventListener(
    "click",
    () => update({ cameras: [], tags: [], from: null, to: null, event: null }),
  );
  div.appendChild(reset);
  listEl.appendChild(div);
}
