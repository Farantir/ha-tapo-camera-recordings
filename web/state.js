// View state lives in the URL so every view is bookmarkable and the back
// button behaves. Nothing else holds a second copy of it.

const listeners = new Set();

export const state = {
  cameras: [], // selected camera ids; empty means "all"
  tags: [], // selected tags; empty means "all". OR-ed, like cameras
  from: null, // true-UTC epoch seconds, inclusive
  to: null,
  bucket: "day",
  event: null, // "<camera>/<key>" of the open event, or null
};

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.cameras = (params.get("cam") ?? "").split(",").filter(Boolean);
  state.tags = (params.get("tag") ?? "").split(",").filter(Boolean);
  state.from = params.has("from") ? Number(params.get("from")) : null;
  state.to = params.has("to") ? Number(params.get("to")) : null;
  state.bucket = params.get("bucket") === "hour" ? "hour" : "day";
  state.event = params.get("event");
}

function writeUrl(replace) {
  const params = new URLSearchParams();
  if (state.cameras.length) params.set("cam", state.cameras.join(","));
  if (state.tags.length) params.set("tag", state.tags.join(","));
  if (state.from !== null) params.set("from", String(state.from));
  if (state.to !== null) params.set("to", String(state.to));
  if (state.bucket !== "day") params.set("bucket", state.bucket);
  if (state.event) params.set("event", state.event);
  const query = params.toString();
  const url = query ? `?${query}` : location.pathname;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

/**
 * @param patch  fields to change
 * @param opts.replace  overwrite the history entry instead of adding one —
 *                      used for transient changes like stepping through events
 */
export function update(patch, opts = {}) {
  const before = JSON.stringify(state);
  Object.assign(state, patch);
  if (JSON.stringify(state) === before) return;
  writeUrl(opts.replace ?? false);
  notify();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function toggleCamera(id) {
  const next = state.cameras.includes(id)
    ? state.cameras.filter((c) => c !== id)
    : [...state.cameras, id];
  update({ cameras: next, event: null });
}

export function toggleTag(tag) {
  const next = state.tags.includes(tag)
    ? state.tags.filter((t) => t !== tag)
    : [...state.tags, tag];
  update({ tags: next, event: null });
}

export function initState() {
  readUrl();
  globalThis.addEventListener("popstate", () => {
    readUrl();
    notify();
  });
}

/** The query fields that change which events are listed. */
export function filterKey() {
  return JSON.stringify([state.cameras, state.tags, state.from, state.to]);
}
