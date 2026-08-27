import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { Auth, parseCookies, safeNextPath } from "./auth.ts";

const OPTS = { password: "hunter2", ttlS: 3600, secret: "test-secret" };
const make = (over: Partial<typeof OPTS> = {}) => new Auth({ ...OPTS, ...over });

function loginRequest(password: unknown): Request {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

const addr = (hostname: string): Deno.Addr => ({ transport: "tcp", hostname, port: 1234 });

Deno.test("auth is disabled when no password is configured", () => {
  assertFalse(make({ password: "" }).enabled);
  assert(make().enabled);
});

Deno.test("parseCookies handles multiple pairs and junk", () => {
  assertEquals(parseCookies("a=1; tapo_session=xyz; b=2"), {
    a: "1",
    tapo_session: "xyz",
    b: "2",
  });
  assertEquals(parseCookies(null), {});
  assertEquals(parseCookies("nonsense"), {});
});

Deno.test("safeNextPath keeps same-origin paths and rejects off-site ones", () => {
  assertEquals(safeNextPath("/?event=abc"), "/?event=abc");
  assertEquals(safeNextPath("//evil.example"), "/");
  assertEquals(safeNextPath("/\\evil.example"), "/");
  assertEquals(safeNextPath("https://evil.example"), "/");
  assertEquals(safeNextPath(null), "/");
});

Deno.test("a freshly issued token verifies", async () => {
  const auth = make();
  const token = await auth.issueToken();
  const expires = await auth.verifyToken(token);
  assert(expires !== null);
  assertEquals(expires, Math.floor(Date.now() / 1000) + OPTS.ttlS);
});

Deno.test("expired tokens are rejected", async () => {
  const auth = make();
  const token = await auth.issueToken();
  assertEquals(await auth.verifyToken(token, Date.now() + (OPTS.ttlS + 1) * 1000), null);
});

Deno.test("tampered and malformed tokens are rejected", async () => {
  const auth = make();
  const token = await auth.issueToken();
  const [payload, mac] = token.split(".");

  // A later expiry with the original signature must not pass.
  assertEquals(await auth.verifyToken(`${Number(payload) + 86400}.${mac}`), null);
  // Tamper with the *first* character, and make sure it actually changes.
  // The signature is 32 bytes in 43 base64url characters, so the last
  // character carries four significant bits and two that decode to nothing —
  // rewriting it can leave the decoded MAC byte-for-byte identical, and the
  // token then verifies exactly as it should. Every bit of the first character
  // counts.
  const flipped = (mac.startsWith("A") ? "B" : "A") + mac.slice(1);
  assertEquals(await auth.verifyToken(`${payload}.${flipped}`), null);
  assertEquals(await auth.verifyToken(payload), null);
  assertEquals(await auth.verifyToken(""), null);
  assertEquals(await auth.verifyToken(undefined), null);
  assertEquals(await auth.verifyToken(".abc"), null);
});

Deno.test("a token signed with another secret is rejected", async () => {
  const token = await make({ secret: "other-secret" }).issueToken();
  assertEquals(await make().verifyToken(token), null);
});

Deno.test("shouldRenew only fires past the halfway point", () => {
  const auth = make();
  const now = Date.now();
  const fresh = Math.floor(now / 1000) + OPTS.ttlS;
  assertFalse(auth.shouldRenew(fresh, now));
  assert(auth.shouldRenew(fresh, now + (OPTS.ttlS / 2 + 1) * 1000));
});

Deno.test("the right password sets a hardened session cookie", async () => {
  const auth = make();
  const res = await auth.handleLogin(loginRequest("hunter2"), addr("10.0.0.5"));
  assertEquals(res.status, 200);

  const cookie = res.headers.get("set-cookie") ?? "";
  assert(cookie.startsWith("tapo_session="));
  assert(cookie.includes("HttpOnly"));
  assert(cookie.includes("SameSite=Lax"));
  assert(cookie.includes(`Max-Age=${OPTS.ttlS}`));
  // Plain HTTP on the LAN: Secure would make the browser drop the cookie.
  assertFalse(cookie.includes("Secure"));

  const token = cookie.slice("tapo_session=".length, cookie.indexOf(";"));
  assert(await auth.verifyToken(token) !== null);
});

Deno.test("Secure is set when the request arrived over TLS", async () => {
  const auth = make();
  const req = new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ password: "hunter2" }),
  });
  const res = await auth.handleLogin(req, addr("10.0.0.5"));
  assert((res.headers.get("set-cookie") ?? "").includes("Secure"));
});

Deno.test("a wrong password is rejected without a cookie", async () => {
  const auth = make();
  const res = await auth.handleLogin(loginRequest("wrong"), addr("10.0.0.6"));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("a non-string password never authenticates", async () => {
  const auth = make();
  for (const value of [null, 42, { toString: () => "hunter2" }]) {
    assertEquals((await auth.handleLogin(loginRequest(value), addr("10.0.0.7"))).status, 401);
  }
});

Deno.test("isAuthenticated reads the cookie and only accepts a valid one", async () => {
  const auth = make();
  const token = await auth.issueToken();

  const withCookie = (value: string) =>
    new Request("http://localhost/api/events", { headers: { cookie: value } });

  assert(await auth.isAuthenticated(withCookie(`tapo_session=${token}`)) !== null);
  assertEquals(await auth.isAuthenticated(withCookie("tapo_session=nope")), null);
  assertEquals(await auth.isAuthenticated(new Request("http://localhost/api/events")), null);
});

Deno.test("repeated failures lock a client out, and only that client", async () => {
  const auth = make();
  const attacker = addr("10.0.0.9");

  for (let i = 0; i < 10; i++) {
    assertEquals((await auth.handleLogin(loginRequest("wrong"), attacker)).status, 401);
  }
  assert(auth.lockedFor(attacker) > 0);

  // Locked out even with the correct password now.
  const blocked = await auth.handleLogin(loginRequest("hunter2"), attacker);
  assertEquals(blocked.status, 429);
  assert(blocked.headers.has("retry-after"));

  // A different address is unaffected.
  assertEquals((await auth.handleLogin(loginRequest("hunter2"), addr("10.0.0.10"))).status, 200);
});

Deno.test("a successful login clears the failure count", async () => {
  const auth = make();
  const client = addr("10.0.0.11");

  for (let i = 0; i < 3; i++) await auth.handleLogin(loginRequest("wrong"), client);
  assertEquals((await auth.handleLogin(loginRequest("hunter2"), client)).status, 200);
  assertEquals(auth.lockedFor(client), 0);
});

Deno.test("clearSessionCookie expires the cookie", () => {
  const auth = make();
  const req = new Request("http://localhost/api/logout", { method: "POST" });
  const res = auth.clearSessionCookie(new Response("{}"), req);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert(cookie.startsWith("tapo_session=;"));
  assert(cookie.includes("Max-Age=0"));
});
