import { serveDir, serveFile } from "@std/http/file-server";
import { join } from "jsr:@std/path@1";
import { Auth, safeNextPath } from "./auth.ts";
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

/**
 * XHR callers get a 401 they can act on; a browser asking for a page is sent
 * to the login form with the path it wanted, so the deep link survives.
 */
function unauthorized(url: URL, path: string): Response {
  if (path.startsWith("/api/") || path.startsWith("/media/")) {
    return json({ error: "unauthenticated" }, 401);
  }
  const target = new URL("/login", url);
  const next = path + url.search;
  if (next !== "/") target.searchParams.set("next", safeNextPath(next));
  return Response.redirect(target, 302);
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
    // `authEnabled` only tells the UI whether to offer a sign-out button.
    return json({ cameras: listCameras(), displayTz: config.displayTz, authEnabled: auth.enabled });
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

  if (path === "/api/logout" && req.method === "POST") {
    return auth.clearSessionCookie(json({ ok: true }), req);
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

const auth = new Auth({
  password: config.authPassword,
  ttlS: config.sessionTtlS,
  secret: config.authSecret,
});

/**
 * Reachable without a session. Everything else needs one. The login page's own
 * stylesheet and script have to be in here, or the form could never render.
 */
function isPublicPath(req: Request, path: string): boolean {
  if (path === "/api/health") return true;
  if (path === "/api/login" && req.method === "POST") return true;
  if (path === "/login" || path === "/login.css" || path === "/login.js") return true;
  return false;
}

const index = await reindex();
console.log(
  `indexed ${index.events.length} events across ${index.cameras.length} cameras ` +
    `from ${config.tapoRoot}`,
);
if (auth.enabled) {
  console.log(`authentication on, sessions last ${config.sessionTtlS}s`);
} else {
  console.warn("AUTH_PASSWORD is unset — the viewer is open to anyone who can reach the port");
}
startBackgroundRescan();

Deno.serve({ port: config.port, hostname: config.host }, async (req, info) => {
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // The health check runs before anything else so an unauthenticated
    // container probe still reports the app as up.
    if (path === "/api/health") return json({ ok: true });

    if (path === "/api/login" && req.method === "POST") {
      return await auth.handleLogin(req, info.remoteAddr);
    }

    if (path === "/login") {
      // Nobody needs the form when auth is off, or when they already hold a
      // live session.
      if (!auth.enabled || await auth.isAuthenticated(req)) {
        return Response.redirect(new URL("/", url), 302);
      }
      return await serveFile(req, join(config.webRoot, "login.html"));
    }

    let session: number | null = null;
    if (auth.enabled && !isPublicPath(req, path)) {
      session = await auth.isAuthenticated(req);
      if (session === null) return unauthorized(url, path);
    }

    let response: Response;
    if (path.startsWith("/api/")) response = await handleApi(req, path, url.searchParams);
    else if (path.startsWith("/media/")) response = await handleMedia(req, path);
    else response = await serveDir(req, { fsRoot: config.webRoot, quiet: true });

    if (session !== null && auth.shouldRenew(session)) {
      // serveDir hands back an immutable response for some paths, so the
      // cookie goes onto a copy we own.
      response = new Response(response.body, response);
      response = await auth.setSessionCookie(response, req);
    }
    return response;
  } catch (err) {
    console.error(`${req.method} ${path} failed:`, err);
    return json({ error: "internal error" }, 500);
  }
});
