/**
 * A session that lapsed while the tab was open turns every request into a 401.
 * Bouncing to the login form here means no caller has to think about it, and
 * the current view comes back afterwards via `?next=`.
 */
function redirectToLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`/login?next=${next}`);
  // Nothing after this matters; the navigation is already under way.
  return new Promise(() => {});
}

async function request(input, init) {
  const response = await fetch(input, init);
  if (response.status === 401) await redirectToLogin();
  return response;
}

async function get(path, params) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await request(url);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

export const fetchCameras = () => get("/api/cameras");

export const fetchEvents = ({ cameras, tags, from, to, cursor, limit = 60 }) =>
  get("/api/events", {
    cameras: cameras?.length ? cameras.join(",") : undefined,
    tags: tags?.length ? tags.join(",") : undefined,
    from,
    to,
    cursor,
    limit,
  });

export const fetchHistogram = ({ cameras, tags, bucket, from, to }) =>
  get("/api/histogram", {
    cameras: cameras?.length ? cameras.join(",") : undefined,
    tags: tags?.length ? tags.join(",") : undefined,
    bucket,
    from,
    to,
  });

export async function fetchEvent(id) {
  const response = await request(`/api/events/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`/api/events/${id} -> ${response.status}`);
  return response.json();
}

export async function reindex() {
  const response = await request("/api/reindex", { method: "POST" });
  if (!response.ok) throw new Error(`reindex -> ${response.status}`);
  return response.json();
}

export async function logout() {
  await fetch("/api/logout", { method: "POST" });
  location.replace("/login");
}

/** The still the camera saved, full sensor resolution, taken as recording began. */
export const cameraThumbUrl = (event) => `/media/${event.camera}/thumbs/${event.key}.jpg`;

/**
 * The still the tagger cut from the frame its detector actually found the
 * subject in. The camera's own picture is taken the instant recording starts —
 * before whoever triggered it has walked into shot — so a list of them is a
 * list of empty driveways. The version stamp is in the URL because this is the
 * one media file that can be rewritten in place, when a clip is re-analysed;
 * every other filename here is immutable.
 */
export const eventThumbUrl = (event) =>
  `/media/${event.camera}/event-thumbs/${event.key}.jpg?v=${event.eventThumb}`;

/** What the list shows: the tagger's picture when there is one. */
export const thumbUrl = (event) =>
  event.eventThumb != null ? eventThumbUrl(event) : cameraThumbUrl(event);

/** True when this event has a picture of any kind. */
export const hasThumb = (event) => event.hasThumb || event.eventThumb != null;

export const videoUrl = (event) => `/media/${event.camera}/videos/${event.key}.mp4`;
