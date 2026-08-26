"""Turns the per-frame detections of one clip into a single set of tags."""

import logging
from collections import defaultdict

import numpy as np

import pipeline
from taxonomy import ANIMAL_TAG, NO_EVENT

log = logging.getLogger("tagger.analyse")


def _present(kinds, min_frames, strong_score):
    """A kind counts once it shows up repeatedly, or once very convincingly.

    A single weak box on one frame is how a swaying branch becomes a "bird", so
    one sighting is not enough unless the detector was sure about it.
    """
    out = {}
    for kind, hits in kinds.items():
        if kind == NO_EVENT:
            continue
        best = max(score for score, _, _ in hits)
        if len(hits) >= min_frames or best >= strong_score:
            out[kind] = hits
    return out


def analyse_video(models, path, cfg):
    """Analyse one recording and return the tag payload for it."""
    frames = pipeline.scan_frames(path, cfg.scan_fps)
    scores = pipeline.motion_scores(frames)
    chosen = pipeline.choose_frames(scores, cfg.max_frames)

    kinds = defaultdict(list)
    detections = 0
    for index in chosen:
        if detections >= cfg.max_crops:
            break
        seconds = index / cfg.scan_fps
        try:
            image = pipeline.frame_at(path, seconds)
        except pipeline.FfmpegError as err:
            log.debug("%s: frame at %.1fs unreadable: %s", path.name, seconds, err)
            continue
        for _guess, score, box in models.detect(image, cfg.detect_conf):
            if detections >= cfg.max_crops:
                break
            detections += 1
            probs = models.classify(pipeline.crop_box(image, box, cfg.crop_pad))
            resolved = models.taxonomy.resolve(probs, cfg.species_conf)
            kinds[resolved.kind].append((score, probs, resolved))

    diagnostics = {
        "frames": len(chosen),
        "clipFrames": len(frames),
        "detections": detections,
    }

    present = _present(kinds, cfg.min_frames, cfg.strong_score)
    if not present:
        # Either nothing was detected at all, or every crop classified as blank
        # — both mean the motion trigger fired on something that is not a
        # subject: wind, a shadow, rain on the lens.
        return {
            "tags": [NO_EVENT],
            "label": NO_EVENT,
            "rank": "kind",
            "confidence": 1.0,
            **diagnostics,
        }

    # Whichever kind the detector was most confident about, summed over frames,
    # is what the event is "about"; the others still get a tag.
    primary = max(present, key=lambda k: sum(score for score, _, _ in present[k]))
    hits = present[primary]

    if primary == ANIMAL_TAG:
        # Averaging the distributions before resolving lets several partial
        # views of the same animal add up to a species, where each frame alone
        # would only have justified the family.
        top = sorted(hits, key=lambda h: h[0], reverse=True)[: cfg.vote_frames]
        mean = np.mean([probs for _, probs, _ in top], axis=0)
        resolved = models.taxonomy.resolve(mean, cfg.species_conf)
        tags, label, rank, confidence = (
            list(resolved.tags), resolved.label, resolved.rank, resolved.confidence,
        )
    else:
        best = max(hits, key=lambda h: h[0])[2]
        tags, label, rank, confidence = [primary], best.label, best.rank, best.confidence

    for other in present:
        if other != primary and other not in tags:
            tags.append(other)

    return {
        "tags": tags,
        "label": label,
        "rank": rank,
        "confidence": round(float(confidence), 4),
        **diagnostics,
    }
