import { serveDir, serveFile } from "@std/http/file-server";
import { join } from "jsr:@std/path@1";
import { config } from "./config.ts";
import { isValidKey } from "./scan.ts";
import {
  getEvent,
  histogram,
  listCameras,
  queryEvents,
  reindex,
  startBackgroundRescan,
} from "./store.ts";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseCameras(params: URLSearchParams): Set<string> | undefined {
  const raw = params.get("cameras");
  if (raw === null || raw === "") return undefined;
  // Unknown names simply match nothing, so a stale bookmark yields an empty
  // list rather than silently widening to every camera.
  return new Set(raw.split(",").filter(Boolean));
}

function parseNumber(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function handleApi(req: Request, path: string, params: URLSearchParams): Promise<Response> {
  if (path === "/api/cameras") {
    return json({ cameras: listCameras(), displayTz: config.displayTz });
  }

  if (path === "/api/events") {
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseNumber(params, "limit") ?? DEFAULT_LIMIT));
    const result = queryEvents({
      cameras: parseCameras(params),
      from: parseNumber(params, "from"),
      to: parseNumber(params, "to"),
      cursor: params.get("cursor") ?? undefined,
      limit,
    });
    return json(result);
  }

  if (path === "/api/histogram") {
    const bucket = params.get("bucket") === "hour" ? "hour" : "day";
    return json(
      histogram(
        bucket,
        parseCameras(params),
        parseNumber(params, "from"),
        parseNumber(params, "to"),
      ),
    );
  }

  if (path.startsWith("/api/events/")) {
    const id = decodeURIComponent(path.slice("/api/events/".length));
    const event = getEvent(id);
    return event ? json(event) : json({ error: "unknown event" }, 404);
  }

  if (path === "/api/reindex" && req.method === "POST") {
    const index = await reindex();
    return json({ generation: index.generation, events: index.events.length });
  }

  return json({ error: "unknown endpoint" }, 404);
}

/** `/media/<camera>/<thumbs|videos>/<key>.<ext>` */
async function handleMedia(req: Request, path: string): Promise<Response> {
  const segments = path.split("/").slice(2);
  if (segments.length !== 3) return new Response("not found", { status: 404 });

  const [camera, kind, filename] = segments;
  const ext = kind === "thumbs" ? ".jpg" : kind === "videos" ? ".mp4" : null;
  if (ext === null || !filename.endsWith(ext)) return new Response("not found", { status: 404 });

  const key = filename.slice(0, -ext.length);
  // Never build a path from unvalidated input: the camera must be one we
  // actually discovered, and the key must be exactly two 10-digit epochs.
  const known = listCameras().some((c) => c.id === camera);
  if (!known || !isValidKey(key)) return new Response("not found", { status: 404 });

  const file = join(config.tapoRoot, camera, kind, filename);
  try {
    const response = await serveFile(req, file);
    // Filenames are immutable, so clients may cache them indefinitely. This is
    // what makes lazy loading cheap when scrolling back up the list.
    if (response.status === 200 || response.status === 206) {
      response.headers.set("cache-control", "public, max-age=31536000, immutable");
    }
    return response;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw err;
  }
}

const index = await reindex();
console.log(
  `indexed ${index.events.length} events across ${index.cameras.length} cameras ` +
    `from ${config.tapoRoot}`,
);
startBackgroundRescan();

Deno.serve({ port: config.port, hostname: config.host }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (path.startsWith("/api/")) return await handleApi(req, path, url.searchParams);
    if (path.startsWith("/media/")) return await handleMedia(req, path);
    return await serveDir(req, { fsRoot: config.webRoot, quiet: true });
  } catch (err) {
    console.error(`${req.method} ${path} failed:`, err);
    return json({ error: "internal error" }, 500);
  }
});
