#!/usr/bin/env python3
"""Tag Tapo recordings so the viewer can filter them.

Walks TAPO_ROOT, analyses every video it has not seen before, and writes one
JSON sidecar plus one thumbnail per event that has a subject in it. Read-only
on the footage; both outputs live on their own volume.

Run once (INTERVAL_S=0, the default) or as a daemon that re-checks on an
interval. Work is incremental — a clip is re-analysed only when its size or
mtime changed — and entries whose video has disappeared are pruned on every
pass, so the file tracks the backup instead of growing forever.

The queue is re-derived from a fresh directory listing before every single
clip, and always yields the newest untagged recording. A clip that lands while
a backfill is running is therefore analysed next rather than after the whole
backlog, and the sidecar is written after each one, so the viewer never waits
on a batch.
"""

import logging
import os
import re
import signal
import sys
import time
from pathlib import Path

import analyse
import pipeline
import thumbs
from store import TagStore

log = logging.getLogger("tagger")

STEM = re.compile(r"^\d{10}-\d{10}$")


def _env(name, default, cast=str):
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    try:
        return cast(raw)
    except ValueError:
        raise SystemExit(f"{name}={raw!r} is not a valid {cast.__name__}")


class Config:
    def __init__(self):
        self.root = Path(_env("TAPO_ROOT", "/data"))
        self.tags_file = _env("TAGS_FILE", "/tags/tags.json")
        # Beside the sidecar by default, so the one volume the viewer already
        # mounts carries both outputs.
        self.thumbs_dir = Path(
            _env("EVENT_THUMBS_DIR", str(Path(self.tags_file).parent / "thumbs"))
        )
        models = Path(_env("MODELS_DIR", "/models"))
        self.detector = models / _env("DETECTOR_MODEL", "detector.onnx")
        self.classifier = models / _env("CLASSIFIER_MODEL", "classifier.onnx")
        self.labels = models / _env("LABELS_FILE", "classifier.labels.txt")

        # Frames per second for the cheap motion scan. The detector only ever
        # sees `max_frames` of them, so raising this widens the search without
        # multiplying the expensive work.
        self.scan_fps = _env("SCAN_FPS", 2.0, float)
        self.max_frames = _env("MAX_FRAMES", 24, int)
        # How far apart the busiest frames have to be, in seconds. Motion rises
        # and falls smoothly, so without this the top-scoring frames are all
        # the same moment and half the budget buys one second of the clip.
        self.peak_gap_s = _env("PEAK_GAP_S", 2.0, float)
        self.max_crops = _env("MAX_CROPS", 48, int)
        self.vote_frames = _env("VOTE_FRAMES", 5, int)

        self.detect_conf = _env("DETECT_CONF", 0.25, float)
        self.species_conf = _env("SPECIES_CONF", 0.55, float)
        self.crop_pad = _env("CROP_PAD", 0.15, float)

        # How much corroboration a sighting needs. A kind counts once it turns
        # up in `min_frames` frames, or in a single frame at these confidences.
        # People and vehicles are held to a lower bar than wildlife: the
        # detector was trained on both and is reliable about them, a visitor
        # can cross the frame in under a second, and a missed person is a worse
        # answer than an occasional false one. A lone weak box in a hedge, on
        # the other hand, is how a swaying branch becomes a "bird".
        self.min_frames = _env("MIN_FRAMES", 2, int)
        self.strong_score = _env("STRONG_SCORE", 0.45, float)
        self.strong_score_wildlife = _env("STRONG_SCORE_WILDLIFE", 0.75, float)
        # Above this the detector's own class stands even when SpeciesNet calls
        # the crop blank — see analyse.decide.
        self.trust_detector = _env("TRUST_DETECTOR", 0.35, float)

        self.thumb_width = _env("THUMB_WIDTH", 640, int)
        self.thumb_quality = _env("THUMB_QUALITY", 82, int)
        # Fraction of the thumbnail the subject should fill. Lower keeps more
        # of the scene around it; higher crops in tighter.
        self.thumb_fill = _env("THUMB_FILL", 0.45, float)

        self.threads = _env("THREADS", 0, int)
        self.interval = _env("INTERVAL_S", 0, int)
        self.limit = _env("LIMIT", 0, int)

    def check(self):
        missing = [p for p in (self.detector, self.classifier, self.labels) if not p.exists()]
        if missing:
            raise SystemExit(
                "missing model file(s): " + ", ".join(str(p) for p in missing) +
                "\nRun tagger/fetch_models.sh to download them into MODELS_DIR."
            )
        if not self.root.is_dir():
            raise SystemExit(f"TAPO_ROOT {self.root} is not a directory — is the folder mounted?")


def discover(root):
    """Every video in the backup, keyed by the id the viewer uses."""
    found = {}
    for camera in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        videos = camera / "videos"
        if not videos.is_dir():
            continue
        for video in sorted(videos.glob("*.mp4")):
            if not STEM.match(video.stem):
                continue
            try:
                info = video.stat()
            except OSError:
                continue
            found[f"{camera.name}/{video.stem}"] = (video, f"{info.st_size}:{int(info.st_mtime)}")
    return found


def newest_pending(cfg, store, blocked):
    """The newest recording still waiting for tags, off a fresh listing.

    Re-listing before every clip is what keeps new footage at the front of the
    queue: a recording that lands during a long backfill is picked next, and
    the backlog only gets the compute nobody else is waiting for. The walk is
    a few hundred stat() calls against minutes of analysis, so its cost does
    not show up.
    """
    live = discover(cfg.root)
    store.prune(set(live))
    pending = [
        event_id for event_id, (_path, fingerprint) in live.items()
        if store.outdated(event_id, fingerprint) and event_id not in blocked
    ]
    if not pending:
        return None, len(live), 0
    # The stem starts with the recording's own epoch, so the lexical maximum
    # is the newest clip.
    event_id = max(pending, key=lambda k: k.split("/")[-1])
    return (event_id, *live[event_id]), len(live), len(pending)


def run_pass(models, cfg, store, writer, stopping):
    """Analyse everything outstanding, newest first, one clip at a time."""
    # Clips that failed this pass. Without this the newest-first pick would
    # hand back the same unreadable file forever; leaving them out of the
    # sidecar means the next pass still retries them.
    blocked = set()
    done = failed = 0
    announced = False

    while not stopping():
        target, total, pending = newest_pending(cfg, store, blocked)
        if not announced:
            # Once per pass, so an idle daemon still says what it is looking at
            # without narrating every clip it decides to skip.
            log.info("%d videos, %d already tagged, %d to do",
                     total, total - pending, pending)
            announced = True
        if target is None:
            break
        event_id, path, fingerprint = target

        started = time.monotonic()
        try:
            payload, subject = analyse.analyse_video(models, path, cfg)
        except pipeline.FfmpegError as err:
            # A truncated or still-copying file: leave it untagged so the next
            # pass retries it rather than recording a wrong answer.
            log.warning("%s unreadable: %s", event_id, err)
            blocked.add(event_id)
            failed += 1
            continue
        except Exception:
            log.exception("%s failed", event_id)
            blocked.add(event_id)
            failed += 1
            continue

        payload["thumb"] = writer.write(event_id, path, subject, cfg)
        store.put(event_id, payload, fingerprint)
        # One clip, one write. The viewer re-reads the sidecar on its own
        # schedule, so tags for a clip that just finished are never held back
        # waiting for a batch to fill.
        store.save()
        done += 1
        log.info(
            "%s -> %s (%.2f, %s)%s %.1fs, %d left",
            event_id, payload["label"], payload["confidence"], payload["rank"],
            " +thumb" if payload["thumb"] else "", time.monotonic() - started,
            pending - 1,
        )
        if cfg.limit and done >= cfg.limit:
            log.info("LIMIT=%d reached", cfg.limit)
            break

    writer.prune(set(store.events))
    store.save(force=True)
    log.info("pass complete: %d tagged, %d failed", done, failed)
    return done, failed


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = Config()
    cfg.check()

    stopping = {"flag": False}

    def stop(signum, _frame):
        log.info("signal %s received — finishing the current clip", signum)
        stopping["flag"] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log.info("loading models from %s", cfg.detector.parent)
    models = pipeline.Models(cfg.detector, cfg.classifier, cfg.labels, cfg.threads)

    store = TagStore(cfg.tags_file).load()
    store.models = {
        "detector": cfg.detector.name,
        "classifier": cfg.classifier.name,
        "speciesConf": cfg.species_conf,
        "detectConf": cfg.detect_conf,
    }
    writer = thumbs.ThumbWriter(cfg.thumbs_dir)

    while True:
        run_pass(models, cfg, store, writer, lambda: stopping["flag"])
        if cfg.interval <= 0 or stopping["flag"]:
            return 0
        log.info("sleeping %ds", cfg.interval)
        for _ in range(cfg.interval):
            if stopping["flag"]:
                return 0
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
