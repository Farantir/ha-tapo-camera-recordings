import { cameraColor } from "./colors.js";
import { toggleCamera, update } from "./state.js";

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
