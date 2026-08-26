#!/usr/bin/env python3
"""Tag Tapo recordings so the viewer can filter them.

Walks TAPO_ROOT, analyses every video it has not seen before, and writes one
JSON sidecar. Read-only on the footage; the sidecar lives on its own volume.

Run once (INTERVAL_S=0, the default) or as a daemon that re-checks on an
interval. Work is incremental — a clip is re-analysed only when its size or
mtime changed — and entries whose video has disappeared are pruned on every
pass, so the file tracks the backup instead of growing forever.
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
        models = Path(_env("MODELS_DIR", "/models"))
        self.detector = models / _env("DETECTOR_MODEL", "detector.onnx")
        self.classifier = models / _env("CLASSIFIER_MODEL", "classifier.onnx")
        self.labels = models / _env("LABELS_FILE", "classifier.labels.txt")

        # Frames per second for the cheap motion scan. The detector only ever
        # sees `max_frames` of them, so raising this widens the search without
        # multiplying the expensive work.
        self.scan_fps = _env("SCAN_FPS", 2.0, float)
        self.max_frames = _env("MAX_FRAMES", 24, int)
        self.max_crops = _env("MAX_CROPS", 48, int)
        self.vote_frames = _env("VOTE_FRAMES", 5, int)

        self.detect_conf = _env("DETECT_CONF", 0.25, float)
        self.species_conf = _env("SPECIES_CONF", 0.55, float)
        self.crop_pad = _env("CROP_PAD", 0.15, float)
        self.min_frames = _env("MIN_FRAMES", 2, int)
        self.strong_score = _env("STRONG_SCORE", 0.80, float)

        self.threads = _env("THREADS", 0, int)
        self.interval = _env("INTERVAL_S", 0, int)
        self.limit = _env("LIMIT", 0, int)
        self.save_every = _env("SAVE_EVERY", 10, int)

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


def run_once(models, cfg, store):
    live = discover(cfg.root)
    store.prune(set(live))

    todo = [(k, v) for k, v in live.items() if store.outdated(k, v[1])]
    # Newest first: during a long backfill the events someone is most likely to
    # be looking at get their tags first.
    todo.sort(key=lambda kv: kv[0].split("/")[-1], reverse=True)
    log.info("%d videos, %d already tagged, %d to do",
             len(live), len(live) - len(todo), len(todo))
    if cfg.limit:
        todo = todo[: cfg.limit]

    done = failed = 0
    for index, (event_id, (path, fingerprint)) in enumerate(todo, start=1):
        started = time.monotonic()
        try:
            payload = analyse.analyse_video(models, path, cfg)
        except pipeline.FfmpegError as err:
            # A truncated or still-copying file: leave it untagged so the next
            # pass retries it rather than recording a wrong answer.
            log.warning("[%d/%d] %s unreadable: %s", index, len(todo), event_id, err)
            failed += 1
            continue
        except Exception:
            log.exception("[%d/%d] %s failed", index, len(todo), event_id)
            failed += 1
            continue
        store.put(event_id, payload, fingerprint)
        done += 1
        log.info(
            "[%d/%d] %s -> %s (%.2f, %s) %.1fs",
            index, len(todo), event_id, payload["label"], payload["confidence"],
            payload["rank"], time.monotonic() - started,
        )
        if cfg.save_every and done % cfg.save_every == 0:
            store.save()

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

    while True:
        run_once(models, cfg, store)
        if cfg.interval <= 0 or stopping["flag"]:
            return 0
        log.info("sleeping %ds", cfg.interval)
        for _ in range(cfg.interval):
            if stopping["flag"]:
                return 0
            time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
