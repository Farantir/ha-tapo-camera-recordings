import { cameraColor } from "./colors.js";
import { toggleCamera, toggleTag, update } from "./state.js";

// The single place camera names are turned into UI text. The server already
// derives a label from the folder name; this stays as the hook for anyone who
// wants to override it without renaming directories on disk.
export function displayLabel(camera) {
  return camera.label;
}

export function renderChips(container, cameras, selected) {
  container.replaceChildren();

  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip all";
  all.setAttribute("aria-pressed", String(selected.length === 0));
  all.innerHTML = `<span class="dot"></span>All`;
  all.addEventListener("click", () => update({ cameras: [], event: null }));
  container.appendChild(all);

  for (const camera of cameras) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (camera.eventCount === 0 ? " empty" : "");
    btn.dataset.cam = camera.id;
    btn.style.setProperty("--dot", cameraColor(camera.id));
    btn.setAttribute("aria-pressed", String(selected.includes(camera.id)));
    btn.innerHTML = `<span class="dot"></span>${
      displayLabel(camera)
    }<span class="n">${camera.eventCount}</span>`;
    btn.addEventListener("click", () => toggleCamera(camera.id));
    container.appendChild(btn);
  }
}

// Only the roots get a hand-written name; everything below them is a taxonomy
// label the tagger discovered, so it is title-cased and shown as-is rather than
// matched against a list this file would have to keep in sync.
const TAG_NAMES = {
  no_event: "No event",
  animal: "Animal",
  human: "Human",
  vehicle: "Vehicle",
  untagged: "Not analysed",
};

export function tagLabel(tag) {
  return TAG_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
}

function tagChip(tag, count, selected) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `chip tag tag-${tag.replace(/[^a-z0-9]+/g, "-")}`;
  btn.dataset.tag = tag;
  btn.setAttribute("aria-pressed", String(selected.includes(tag)));
  btn.append(document.createTextNode(tagLabel(tag)));
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(count);
  btn.appendChild(n);
  btn.addEventListener("click", () => toggleTag(tag));
  return btn;
}

/**
 * Two rows in one strip: the four kinds an event can be, then the species the
 * classifier actually resolved. Nothing here is configured — an empty
 * vocabulary (no tagger has run) renders nothing at all.
 */
export function renderTagChips(container, vocabulary, selected) {
  container.replaceChildren();
  const { buckets = [], labels = [] } = vocabulary ?? {};
  container.classList.toggle("hidden", buckets.length === 0);
  if (buckets.length === 0) return;

  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip all";
  all.setAttribute("aria-pressed", String(selected.length === 0));
  all.textContent = "Any";
  all.addEventListener("click", () => update({ tags: [], event: null }));
  container.appendChild(all);

  for (const { tag, count } of buckets) container.appendChild(tagChip(tag, count, selected));

  if (labels.length) {
    const sep = document.createElement("span");
    sep.className = "chip-sep";
    sep.setAttribute("aria-hidden", "true");
    container.appendChild(sep);
    for (const { tag, count } of labels) container.appendChild(tagChip(tag, count, selected));
  }
}
