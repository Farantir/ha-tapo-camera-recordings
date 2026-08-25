import { createDayTimeline } from "./daytimeline.js";
import { fetchDayEvents } from "./days.js";
import { dayLabelShort } from "./format.js";
import { state, update } from "./state.js";

let rootEl, headingEl, plotEl, emptyEl;
let timeline = null;
let day = null; // { day, start } currently shown
let pending = 0; // guards against a slower fetch overwriting a newer day

export function initDaybar() {
  rootEl = document.getElementById("daybar");
  headingEl = rootEl.querySelector(".daybar-day");
  plotEl = rootEl.querySelector(".daybar-plot");
  emptyEl = rootEl.querySelector(".daybar-empty");

  timeline = createDayTimeline(plotEl, {
    orientation: "vertical",
    onPick: (id) => update({ event: id }),
  });

  rootEl.querySelector('[data-zoom="in"]').addEventListener("click", () => timeline.zoomIn());
  rootEl.querySelector('[data-zoom="out"]').addEventListener("click", () => timeline.zoomOut());
  rootEl.querySelector('[data-zoom="reset"]').addEventListener("click", () => timeline.reset());

  // The bar tracks whatever day the list has scrolled to, so it re-checks on
  // scroll and on resize — both coalesced onto one frame.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      syncToScroll();
    });
  };
  globalThis.addEventListener("scroll", schedule, { passive: true });
  globalThis.addEventListener("resize", schedule);

  // Rows arrive asynchronously — on first load, on infinite scroll and on every
  // filter change — so the bar watches the list rather than being told.
  new MutationObserver(schedule).observe(document.getElementById("list"), { childList: true });
}

/** Called after the list reloads: the day heads are new, so re-resolve. */
export function refresh() {
  day = null;
  syncToScroll();
}

export function setCurrentEvent(event) {
  timeline?.setCurrent(event);
}

function topbarHeight() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--topbar-h");
  return parseFloat(raw) || 0;
}

/**
 * The day shown is the last one whose heading has passed under the top bar —
 * i.e. the day the reader is actually looking at, not the next one down.
 */
function currentDayHead() {
  const heads = document.querySelectorAll(".day-head[data-day]");
  if (heads.length === 0) return null;
  const cutoff = topbarHeight() + 8;
  let found = heads[0];
  for (const head of heads) {
    if (head.getBoundingClientRect().top <= cutoff) found = head;
    else break; // day heads are in document order, so the first miss ends it
  }
  return found;
}

async function syncToScroll() {
  if (!rootEl || rootEl.offsetParent === null) return; // hidden by the media query

  const head = currentDayHead();
  if (!head) {
    day = null;
    headingEl.textContent = "";
    emptyEl.classList.remove("hidden");
    plotEl.classList.add("hidden");
    return;
  }

  const next = { day: head.dataset.day, start: Number(head.dataset.dayStart) };
  if (day && day.day === next.day) return;
  day = next;

  headingEl.textContent = dayLabelShort(next.start, next.day);
  emptyEl.classList.add("hidden");
  plotEl.classList.remove("hidden");

  const token = ++pending;
  let events;
  try {
    events = await fetchDayEvents(next.day, next.start, state.cameras);
  } catch {
    return;
  }
  if (token !== pending) return; // the reader scrolled on while this was in flight

  timeline.render({ events, day: next.day, current: currentEvent(events) });
}

function currentEvent(events) {
  return state.event ? events.find((e) => e.id === state.event) ?? null : null;
}
