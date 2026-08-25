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

`TS_OFFSET_SECONDS` exists because the camera writes filename epochs against a fixed UTC+1 clock
with DST disabled, so a raw filename timestamp runs one hour ahead of true UTC. See the comment in
`server/config.ts` for how that was verified.

## Deployment

Nothing in `docker-compose.yml` is hardcoded: every host-side setting is an environment variable
with a default, so the same compose file works unchanged on any host.

```sh
cp .env.example .env   # adjust
docker compose up -d --build
```

| Variable         | Default          | Meaning                                                 |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `TAPO_HOST_PATH` | `/volume1/tapo`  | Backup folder on the host, mounted read-only at `/data` |
| `HTTP_PORT`      | `8123`           | Published port — mind that Home Assistant also uses it  |
| `BIND_ADDRESS`   | `0.0.0.0`        | Host interface to publish on                            |
| `CONTAINER_NAME` | `tapo-viewer`    | Container name                                          |
| `RESTART_POLICY` | `unless-stopped` | Docker restart policy                                   |

The app-side variables above — `DISPLAY_TZ`, `TS_OFFSET_SECONDS`, `RESCAN_INTERVAL_S` — are passed
into the container by the same file. `TAPO_ROOT`, `PORT` and `HOST` are fixed inside the image.


The image runs as a non-root user and the process is granted read access to the mount only, so the
footage cannot be modified from inside the container.

**There is no authentication.** Keep the port on the LAN and reach it from outside over a VPN — do
not port-forward it.

## API

| Route                                              | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/cameras`                                 | Camera list with event counts and time span                  |
| `GET /api/events`                                  | Paginated events; `cameras`, `from`, `to`, `limit`, `cursor` |
| `GET /api/histogram`                               | Counts per local day or hour; `bucket=day\|hour`             |
| `GET /api/events/<id>`                             | A single event                                               |
| `POST /api/reindex`                                | Rescan now                                                   |
| `GET /media/<camera>/<thumbs\|videos>/<key>.<ext>` | Media, with range support                                    |

## License

GPL-2.0.
