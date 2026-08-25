// The backup holds full 2560x1440 JPEGs and is served as-is, so a long scroll
// would otherwise pin hundreds of megabytes of *decoded* bitmap in memory —
// far more than the download cost. Images are attached as a row nears the
// viewport and detached again once it is well outside, letting the browser
// release the decode. The two margins differ so slow scrolling at the boundary
// cannot thrash.

const LOAD_MARGIN = "1000px 0px";
const KEEP_MARGIN = "2600px 0px";

function attach(box) {
  const img = box.querySelector("img");
  if (!img || img.dataset.attached === "1") return;
  img.dataset.attached = "1";
  img.src = box.dataset.src;
}

function detach(box) {
  const img = box.querySelector("img");
  if (!img || img.dataset.attached !== "1") return;
  delete img.dataset.attached;
  img.classList.remove("ready");
  img.removeAttribute("src");
}

const loader = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) attach(entry.target);
}, { rootMargin: LOAD_MARGIN });

const keeper = new IntersectionObserver((entries) => {
  for (const entry of entries) if (!entry.isIntersecting) detach(entry.target);
}, { rootMargin: KEEP_MARGIN });

export function observeThumb(box) {
  loader.observe(box);
  keeper.observe(box);
}

export function resetThumbs() {
  loader.disconnect();
  keeper.disconnect();
}
