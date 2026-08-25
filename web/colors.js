// Per-camera colour, golden-angle spaced by position in the sorted camera
// list so a handful of cameras stay maximally distinguishable. A hash
// fallback covers ids that show up later (a stale bookmark, a race with
// reindex) without ever throwing.

const S = 70;
const L = 60;

let order = [];

export function assignCameraColors(cameras) {
  order = cameras.map((c) => c.id).sort();
}

function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function cameraColor(id) {
  const i = order.indexOf(id);
  const hue = i === -1 ? hashHue(id) : (i * 137.5) % 360;
  return `hsl(${hue} ${S}% ${L}%)`;
}

export function paintCamera(el, id) {
  el.style.setProperty("--dot", cameraColor(id));
}
