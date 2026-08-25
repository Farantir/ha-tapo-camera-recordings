import { DAY, fullDay, panBy, zoomAt } from "./timeline_geom.js";

// Below this much movement a press is a tap, not a pan.
const TAP_SLOP = 5;

/**
 * Turns raw pointer and wheel events into window changes on a 0..1 time axis.
 * Deals only in fractions and in the target elements the host names — it has no
 * idea what an SVG, a camera or an event is.
 *
 * The host supplies:
 *   fractionAt(e)      pixel position -> 0..1 along the time axis
 *   timeLen()          plot length in px, for wheel panning
 *   ready()            false while the plot has no measured geometry
 *   getWindow/setWindow  the visible window; setWindow is expected to redraw
 *   targetSelector     what counts as a pickable element
 *   onPick(el)         a tap landed on one
 *   onHover(el, x, y) / onHoverEnd()
 */
export function createGestures(container, host) {
  // `pointers` holds live pointers so a second finger can promote a pan into a
  // pinch without losing the first one's position.
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  const abort = new AbortController();
  const opts = { signal: abort.signal };
  container.addEventListener("pointerdown", onDown, opts);
  container.addEventListener("pointermove", onMove, opts);
  container.addEventListener("pointerup", onUp, opts);
  container.addEventListener("pointercancel", onUp, opts);
  container.addEventListener("pointerleave", () => host.onHoverEnd(), opts);
  container.addEventListener("wheel", onWheel, { passive: false, signal: abort.signal });
  container.addEventListener("dblclick", onDoubleClick, opts);

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.abs(a.frac - b.frac), mid: (a.frac + b.frac) / 2 };
  }

  function onDown(e) {
    if (!host.ready()) return;
    // Read the target before capturing: once the container has the pointer,
    // every later event for it retargets to the container, so `pointerup`
    // would never know which element was under the finger.
    const target = e.target.closest?.(host.targetSelector) ?? null;
    container.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { frac: host.fractionAt(e), x: e.clientX, y: e.clientY });
    host.onHoverEnd();

    if (pointers.size === 2) {
      const { dist, mid } = pinchState();
      pinch = { startWin: { ...host.getWindow() }, dist, mid };
      drag = null;
    } else if (pointers.size === 1) {
      drag = {
        startWin: { ...host.getWindow() },
        startFrac: host.fractionAt(e),
        x: e.clientX,
        y: e.clientY,
        moved: 0,
        target,
      };
    }
  }

  function onMove(e) {
    const tracked = pointers.get(e.pointerId);
    if (!tracked) {
      const target = e.target.closest?.(host.targetSelector);
      if (target) host.onHover(target, e.clientX, e.clientY);
      else host.onHoverEnd();
      return;
    }

    tracked.frac = host.fractionAt(e);
    tracked.x = e.clientX;
    tracked.y = e.clientY;

    if (pinch && pointers.size === 2) {
      const { dist, mid } = pinchState();
      if (pinch.dist > 0) {
        const zoomed = zoomAt(pinch.startWin, dist / pinch.dist, pinch.mid);
        host.setWindow(panBy(zoomed, pinch.mid - mid));
      }
      return;
    }

    if (drag) {
      drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y));
      if (drag.moved > TAP_SLOP) {
        // Content follows the finger: dragging towards later times pulls the
        // window earlier.
        host.setWindow(panBy(drag.startWin, drag.startFrac - host.fractionAt(e)));
      }
    }
  }

  function onUp(e) {
    const wasDrag = drag;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;

    if (!wasDrag || wasDrag.moved > TAP_SLOP) return;
    // A tap that never really moved is a pick, not a pan.
    if (wasDrag.target) host.onPick(wasDrag.target);
  }

  function onWheel(e) {
    if (!host.ready()) return;
    const delta = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : 1);
    if (!delta) return;

    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel in every major browser.
      e.preventDefault();
      host.setWindow(zoomAt(host.getWindow(), Math.exp(-delta * 0.002), host.fractionAt(e)));
      return;
    }

    // Fully zoomed out there is nothing to pan, so let the page scroll instead
    // of trapping the wheel over the day bar.
    const win = host.getWindow();
    if (win.span >= DAY) return;
    e.preventDefault();
    host.setWindow(panBy(win, delta / (host.timeLen() || 1)));
  }

  function onDoubleClick(e) {
    e.preventDefault();
    const win = host.getWindow();
    host.setWindow(win.span < DAY ? fullDay() : zoomAt(fullDay(), 4, host.fractionAt(e)));
  }

  return { destroy: () => abort.abort() };
}
