/**
 * Single shared password plus a signed session cookie.
 *
 * This is a lock on a garden gate, not a bank vault: it exists so that a
 * device on the LAN cannot open the recordings by simply knowing the port.
 * There are no user accounts, so there is nothing to enumerate, and the only
 * secret is `AUTH_PASSWORD`.
 *
 * The session is stateless — the cookie carries its own expiry and an HMAC
 * over it, so nothing has to be kept in memory and any number of tabs or
 * devices can hold a session at once. Signing uses `AUTH_SECRET` when set;
 * otherwise a random key is drawn at startup, which logs everyone out on
 * restart.
 */

const COOKIE_NAME = "tapo_session";
const encoder = new TextEncoder();

/** Failed logins are throttled per client address. */
const MAX_FAILURES = 10;
const LOCKOUT_MS = 60_000;
const FAILURE_DELAY_MS = 250;
/** Bounded so a spoofed-address flood cannot grow the map without limit. */
const MAX_TRACKED_CLIENTS = 1024;

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function fromBase64url(text: string): Uint8Array | null {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(text.length / 4) * 4,
    "=",
  );
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** `document.cookie`-style header into a plain lookup. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Only same-origin paths may be handed back after login, so a crafted
 * `?next=` cannot bounce the browser to another site. `//host` and `/\host`
 * are protocol-relative URLs, not paths.
 */
export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export class Auth {
  readonly enabled: boolean;
  #key: CryptoKey | null = null;
  #password: string;
  #ttlS: number;
  #secret: string;
  #failures = new Map<string, { count: number; until: number }>();

  constructor(opts: { password: string; ttlS: number; secret: string }) {
    this.#password = opts.password;
    this.#ttlS = Math.max(60, Math.floor(opts.ttlS));
    this.#secret = opts.secret;
    this.enabled = opts.password !== "";
  }

  async #signingKey(): Promise<CryptoKey> {
    if (this.#key) return this.#key;
    const raw = this.#secret !== ""
      ? encoder.encode(this.#secret)
      : crypto.getRandomValues(new Uint8Array(32));
    this.#key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return this.#key;
  }

  async #sign(payload: string): Promise<Uint8Array> {
    const mac = await crypto.subtle.sign("HMAC", await this.#signingKey(), encoder.encode(payload));
    return new Uint8Array(mac);
  }

  /** `<expiry-epoch-seconds>.<hmac>` */
  async issueToken(now = Date.now()): Promise<string> {
    const expires = Math.floor(now / 1000) + this.#ttlS;
    const payload = String(expires);
    return `${payload}.${base64url(await this.#sign(payload))}`;
  }

  /** Expiry epoch of a valid token, or null if forged, malformed or expired. */
  async verifyToken(token: string | undefined, now = Date.now()): Promise<number | null> {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const provided = fromBase64url(token.slice(dot + 1));
    if (!provided) return null;
    if (!constantTimeEqual(provided, await this.#sign(payload))) return null;

    const expires = Number(payload);
    if (!Number.isFinite(expires) || expires * 1000 <= now) return null;
    return expires;
  }

  async isAuthenticated(req: Request, now = Date.now()): Promise<number | null> {
    if (!this.enabled) return null;
    const token = parseCookies(req.headers.get("cookie"))[COOKIE_NAME];
    return await this.verifyToken(token, now);
  }

  /**
   * A session past its halfway point is re-issued on the next request, so
   * someone who keeps the tab open is not logged out mid-scroll while an
   * abandoned tab still expires on schedule.
   */
  shouldRenew(expires: number, now = Date.now()): boolean {
    return expires - now / 1000 < this.#ttlS / 2;
  }

  #cookie(value: string, req: Request, maxAge: number): string {
    // Plain HTTP on a LAN is the normal case here, so `Secure` is set only
    // when the request actually arrived over TLS — otherwise the browser
    // would drop the cookie and login would silently never stick.
    const https = req.headers.get("x-forwarded-proto") === "https" ||
      new URL(req.url).protocol === "https:";
    const parts = [
      `${COOKIE_NAME}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${maxAge}`,
    ];
    if (https) parts.push("Secure");
    return parts.join("; ");
  }

  async setSessionCookie(res: Response, req: Request, token?: string): Promise<Response> {
    res.headers.append(
      "set-cookie",
      this.#cookie(token ?? await this.issueToken(), req, this.#ttlS),
    );
    return res;
  }

  clearSessionCookie(res: Response, req: Request): Response {
    res.headers.append("set-cookie", this.#cookie("", req, 0));
    return res;
  }

  #throttleKey(addr: Deno.Addr | undefined): string {
    return addr && "hostname" in addr ? addr.hostname : "unknown";
  }

  /** Remaining lockout in seconds, or 0 when this client may try again. */
  lockedFor(addr: Deno.Addr | undefined, now = Date.now()): number {
    const entry = this.#failures.get(this.#throttleKey(addr));
    if (!entry || entry.until <= now) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  #recordFailure(addr: Deno.Addr | undefined, now = Date.now()): void {
    const key = this.#throttleKey(addr);
    const entry = this.#failures.get(key);
    if (!entry || entry.until <= now) {
      if (this.#failures.size >= MAX_TRACKED_CLIENTS) this.#failures.clear();
      this.#failures.set(key, { count: 1, until: now + LOCKOUT_MS });
      return;
    }
    entry.count++;
    // The window slides with every failure, so a slow trickle of guesses still
    // accumulates towards the lockout instead of ageing out between attempts.
    entry.until = now + LOCKOUT_MS;
  }

  #clearFailures(addr: Deno.Addr | undefined): void {
    this.#failures.delete(this.#throttleKey(addr));
  }

  #isLockedOut(addr: Deno.Addr | undefined, now = Date.now()): boolean {
    const entry = this.#failures.get(this.#throttleKey(addr));
    return !!entry && entry.count >= MAX_FAILURES && entry.until > now;
  }

  async handleLogin(req: Request, addr: Deno.Addr | undefined): Promise<Response> {
    if (this.#isLockedOut(addr)) {
      const retry = this.lockedFor(addr);
      return new Response(JSON.stringify({ error: "too many attempts", retryAfter: retry }), {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(retry),
          "cache-control": "no-store",
        },
      });
    }

    let password = "";
    try {
      const body = await req.json();
      if (typeof body?.password === "string") password = body.password;
    } catch {
      password = "";
    }

    // Compare digests rather than the strings themselves: equal-length inputs
    // then leak nothing through timing, and unequal ones leak only a length
    // the attacker already chose.
    const ok = constantTimeEqual(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(password))),
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(this.#password))),
    );

    if (!ok) {
      this.#recordFailure(addr);
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
      return new Response(JSON.stringify({ error: "wrong password" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    this.#clearFailures(addr);
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
    return await this.setSessionCookie(res, req);
  }
}
