import { fetchEvents } from "./api.js";

// One local day's events, keyed by day and the active filter. Shared by the
// viewer and the overview day bar so stepping between them costs at most one
// fetch. Tags are part of the key as well as the query, so prev/next in the
// viewer walks the same set the list is showing.
const cache = new Map();

const DAY_LIMIT = 200;

export function fetchDayEvents(day, dayStart, cameras, tags = []) {
  const key = `${day}|${cameras.join(",")}|${tags.join(",")}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchEvents({
      cameras,
      tags,
      from: dayStart,
      to: dayStart + 86399,
      limit: DAY_LIMIT,
    })
      .then((result) => result.events)
      .catch((err) => {
        cache.delete(key); // a failed day must be retryable
        throw err;
      });
    cache.set(key, pending);
  }
  return pending;
}

export function clearDayCache() {
  cache.clear();
}
