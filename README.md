# Tapo Camera Recordings Viewer

A small self-hosted browser for recordings pulled off TP-Link Tapo cameras — the folder-per-camera
backup that the inofficial Home Assistant integration creates.

Point it at the backup directory and it gives you a filterable event list, a per-camera density
timeline, a day bar and an inline video viewer. Nothing is copied, converted or written: the app
only ever reads the folder.

Deno on the backend, plain ES modules on the frontend. No build step, no bundler, no dependencies
beyond the Deno standard library.

## Screenshots

The event list: camera filter chips with counts, the multi-camera density timeline, and the
day-grouped events with thumbnails, with the day rail on the right.

![Event list with camera filters and the day timeline](screenshots/screenshot_1.png)

The timeline switches to an hour view over the last 14 days, so a busy stretch can be picked apart
hour by hour. Drag across it to select a range, or click a single bar to filter that day.

![The same list with the timeline in hour mode](screenshots/screenshot_3.png)

Opening an event plays it inline, with every camera's day timeline underneath and prev/next
navigation through the neighbouring events.

![Inline video viewer with the per-day timeline](screenshots/screenshot_2.png)

## Expected folder layout

```
<TAPO_ROOT>/<camera>/thumbs/<start>-<end>.jpg
<TAPO_ROOT>/<camera>/videos/<start>-<end>.mp4
```

## Running locally

```sh
deno task dev      # watch mode on http://127.0.0.1:8000
deno task start    # same, without the watcher
deno task test     # unit tests
deno task check    # typecheck
```

Put the recordings in `./tapo`, or set `TAPO_ROOT` elsewhere.

## Configuration

All optional, all environment variables.

| Variable            | Default         | Meaning                                   |
| ------------------- | --------------- | ----------------------------------------- |
| `TAPO_ROOT`         | `./tapo`        | Directory holding the per-camera folders  |
| `PORT`              | `8000`          | Listen port                               |
| `HOST`              | `127.0.0.1`     | Bind address; a container needs `0.0.0.0` |
| `DISPLAY_TZ`        | `Europe/Berlin` | Timezone for day/hour bucketing           |
| `TS_OFFSET_SECONDS` | `-3600`         | Correction applied to filename timestamps |
| `RESCAN_INTERVAL_S` | `1800`          | Seconds between background rescans        |
| `AUTH_PASSWORD`     | _(empty)_       | Shared login password; empty = no login   |
| `SESSION_TTL_S`     | `43200`         | How long a login lasts (12 h)             |
| `AUTH_SECRET`       | _(random)_      | Key the session cookie is signed with     |

See [Authentication](#authentication) for the three `AUTH_*`/`SESSION_*` variables.

`TS_OFFSET_SECONDS` exists because the camera writes filename epochs against a fixed UTC+1 clock
with DST disabled, so a raw filename timestamp runs one hour ahead of true UTC. See the comment in
`server/config.ts` for how that was verified.

## Authentication

Set `AUTH_PASSWORD` and the viewer asks for that one password before it shows anything. There are no
user accounts — it is a lock on the gate, meant to stop a random device on the network from opening
the recordings, not to withstand a determined attacker.

```sh
AUTH_PASSWORD=somethinglong deno task start
```

How it works:

- The password is checked against `AUTH_PASSWORD` and, if it matches, the browser gets a session
  cookie — `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the request arrived over HTTPS.
- The cookie is stateless: it carries its own expiry plus an HMAC over it, so nothing is kept
  server-side and any number of devices can be logged in at once. A session still in use past its
  halfway point is renewed silently, so an open tab is not thrown out mid-scroll.
- The signing key is `AUTH_SECRET`. Leave it empty and a random one is drawn at every start, which
  logs everyone out on restart — set it (`openssl rand -base64 32`) to avoid that.
- Ten wrong guesses from one address lock that address out for a minute, and every failed attempt is
  answered slowly, so guessing the password over the network is not practical.
- Everything is behind the login: the API, the media files and the app itself. Only the login page,
  its two assets and `GET /api/health` (the container health check) answer without a session.

Leaving `AUTH_PASSWORD` empty keeps the old behaviour — no login, no session, open to anyone who can
reach the port — and the server says so on startup.

Either way, keep the port on the LAN and reach it from outside over a VPN rather than
port-forwarding it. A shared password over plain HTTP is not an internet-facing setup; if you do
expose it, put it behind a reverse proxy with TLS.

## Deployment

Nothing in `docker-compose.yml` is hardcoded: every host-side setting is an environment variable
with a default, so the same compose file works unchanged on any host.

```sh
cp .env.example .env   # adjust
docker compose up -d --build
```

| Variable         | Default          | Meaning                                                       |
| ---------------- | ---------------- | ------------------------------------------------------------- |
| `TAPO_HOST_PATH` | `/volume1/tapo`  | Backup folder on the host, mounted read-only at `/data`       |
| `HTTP_PORT`      | `8123`           | Published port — mind that Home Assistant also uses it        |
| `BIND_ADDRESS`   | `0.0.0.0`        | Host interface to publish on                                  |
| `PUID` / `PGID`  | `1000`           | uid:gid the container runs as; must be able to read the mount |
| `CONTAINER_NAME` | `tapo-viewer`    | Container name                                                |
| `RESTART_POLICY` | `unless-stopped` | Docker restart policy                                         |

The app-side variables above — `DISPLAY_TZ`, `TS_OFFSET_SECONDS`, `RESCAN_INTERVAL_S`,
`AUTH_PASSWORD`, `SESSION_TTL_S`, `AUTH_SECRET` — are passed into the container by the same file.
`TAPO_ROOT`, `PORT` and `HOST` are fixed inside the image.

The image runs as a non-root user and the process is granted read access to the mount only, so the
footage cannot be modified from inside the container.

A bind mount keeps its ownership from the host, so a `PermissionDenied` on startup means the uid the
container runs as cannot read the footage. Find the owner with `ls -ldn <TAPO_HOST_PATH>` and either
set `PUID`/`PGID` to those numbers, or make the folder readable for uid 1000.

Set `AUTH_PASSWORD` in the `.env` file to require a login; see [Authentication](#authentication).
With or without it, keep the port on the LAN and reach it from outside over a VPN — do not
port-forward it.

## API

| Route                                              | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/cameras`                                 | Camera list with event counts and time span                  |
| `GET /api/events`                                  | Paginated events; `cameras`, `from`, `to`, `limit`, `cursor` |
| `GET /api/histogram`                               | Counts per local day or hour; `bucket=day\|hour`             |
| `GET /api/events/<id>`                             | A single event                                               |
| `POST /api/reindex`                                | Rescan now                                                   |
| `POST /api/login`                                  | Exchange the password for a session cookie (public)          |
| `POST /api/logout`                                 | Drop the session cookie                                      |
| `GET /api/health`                                  | Liveness probe; the only public API route (public)           |
| `GET /media/<camera>/<thumbs\|videos>/<key>.<ext>` | Media, with range support                                    |

## License

GPL-2.0.
