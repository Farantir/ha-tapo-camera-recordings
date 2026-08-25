// One lazily created tooltip, shared by the density strip and the day
// timeline. Positioned fixed and flipped left/up when it would overflow.

let el = null;

function ensure() {
  if (!el) {
    el = document.createElement("div");
    el.className = "tooltip hidden";
    document.body.appendChild(el);
  }
  return el;
}

export function showTooltip(html, x, y) {
  const t = ensure();
  t.innerHTML = html;
  // Measure off-screen first: a hidden element reports a zero-size rect.
  t.style.left = "-9999px";
  t.style.top = "-9999px";
  t.classList.remove("hidden");

  const rect = t.getBoundingClientRect();
  const pad = 12;
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > innerWidth - 4) left = x - rect.width - pad;
  if (top + rect.height > innerHeight - 4) top = y - rect.height - pad;

  t.style.left = `${Math.max(4, left)}px`;
  t.style.top = `${Math.max(4, top)}px`;
}

export function hideTooltip() {
  if (el) el.classList.add("hidden");
}
