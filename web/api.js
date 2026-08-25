async function get(path, params) {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

export const fetchCameras = () => get("/api/cameras");

export const fetchEvents = ({ cameras, from, to, cursor, limit = 60 }) =>
  get("/api/events", {
    cameras: cameras?.length ? cameras.join(",") : undefined,
    from,
    to,
    cursor,
    limit,
  });

export const fetchHistogram = ({ cameras, bucket, from, to }) =>
  get("/api/histogram", {
    cameras: cameras?.length ? cameras.join(",") : undefined,
    bucket,
    from,
    to,
  });

export async function fetchEvent(id) {
  const response = await fetch(`/api/events/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`/api/events/${id} -> ${response.status}`);
  return response.json();
}

export async function reindex() {
  const response = await fetch("/api/reindex", { method: "POST" });
  if (!response.ok) throw new Error(`reindex -> ${response.status}`);
  return response.json();
}

export const thumbUrl = (event) => `/media/${event.camera}/thumbs/${event.key}.jpg`;
export const videoUrl = (event) => `/media/${event.camera}/videos/${event.key}.mp4`;
