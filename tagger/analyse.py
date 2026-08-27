"""Turns the per-frame detections of one clip into a single set of tags.

Also hands back *where* the winning subject was — the timestamp of the frame
and the box inside it — which is what lets the thumbnail show the animal
instead of the empty driveway the camera photographed a moment earlier.
"""

import logging
from collections import defaultdict

import numpy as np

import pipeline
from taxonomy import ANIMAL_TAG, NO_EVENT

log = logging.getLogger("tagger.analyse")


class Hit:
    """One detected box: how sure the detector was, what the classifier made of
    it, and where in the clip it is, so a thumbnail can be cut from it later."""

    __slots__ = ("score", "probs", "resolved", "seconds", "box")

    def __init__(self, score, probs, resolved, seconds, box):
        self.score = score
        self.probs = probs
        self.resolved = resolved
        self.seconds = seconds
        self.box = box


def decide(guess, score, resolved, cfg):
    """Which kind one detection counts as.

    SpeciesNet is a camera-trap classifier, and its ``blank`` class means "no
    animal in this crop" — which is exactly what it says about a person in
    infrared, a subject cut off by the frame edge, or a car it was never
    trained on. Letting that veto the detector is what left clips with a
    visible person tagged ``no_event``: the box was found, scored, and then
    thrown away.

    So the detector keeps the last word on *whether* something is there, and
    the classifier only gets to say *what* — which is the one it is good at.
    """
    if resolved.kind != NO_EVENT:
        return resolved.kind
    if score >= cfg.trust_detector:
        return guess
    return NO_EVENT


def _corroborated(kind, hits, cfg):
    """Is one sighting of `kind`, on its own, worth believing?

    A single weak box on one frame is how a swaying branch becomes a "bird".
    People and vehicles clear that on the detector's own evidence at a lower
    bar: it was trained on both, a visitor can cross the frame in under a
    second, and a missed person is a worse answer than an occasional false one.

    Wildlife gets a second route to the same place. A squirrel crossing a path
    is sharp in exactly one sampled frame and motion-blurred past recognition
    in its neighbours, so "seen twice" is a test it can never pass — but when
    the classifier has independently walked the taxonomy down to a named taxon
    on that one crop, two models trained on entirely different data agree that
    it is an animal. A branch does not get called a red squirrel; it comes back
    blank, and blank never reaches this rank.
    """
    best = max(hit.score for hit in hits)
    if kind != ANIMAL_TAG:
        return best >= cfg.strong_score
    if best >= cfg.strong_score_wildlife:
        return True
    return any(h.resolved.kind == ANIMAL_TAG and h.resolved.rank != "kind" for h in hits)


def _present(kinds, cfg):
    """The kinds this clip actually contains, with the hits that prove it."""
    out = {}
    for kind, hits in kinds.items():
        if kind == NO_EVENT:
            continue
        if len(hits) >= cfg.min_frames or _corroborated(kind, hits, cfg):
            out[kind] = hits
    return out


def analyse_video(models, path, cfg):
    """Analyse one recording and return the tag payload for it."""
    frames = pipeline.scan_frames(path, cfg.scan_fps)
    scores = pipeline.motion_scores(frames)
    gap = max(1, round(cfg.peak_gap_s * cfg.scan_fps))
    chosen = pipeline.choose_frames(scores, cfg.max_frames, gap)

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
        for guess, score, box in models.detect(image, cfg.detect_conf):
            if detections >= cfg.max_crops:
                break
            detections += 1
            probs = models.classify(pipeline.crop_box(image, box, cfg.crop_pad))
            resolved = models.taxonomy.resolve(probs, cfg.species_conf)
            kinds[decide(guess, score, resolved, cfg)].append(
                Hit(score, probs, resolved, seconds, box)
            )

    diagnostics = {
        "frames": len(chosen),
        "clipFrames": len(frames),
        "detections": detections,
    }

    present = _present(kinds, cfg)
    if not present:
        # Either nothing was detected at all, or every crop was blank to both
        # models — both mean the motion trigger fired on something that is not
        # a subject: wind, a shadow, rain on the lens.
        return {
            "tags": [NO_EVENT],
            "label": NO_EVENT,
            "rank": "kind",
            "confidence": 1.0,
            **diagnostics,
        }, None

    # Whichever kind the detector was most confident about, summed over frames,
    # is what the event is "about"; the others still get a tag.
    primary = max(present, key=lambda k: sum(hit.score for hit in present[k]))
    hits = present[primary]
    best = max(hits, key=lambda hit: hit.score)

    if primary == ANIMAL_TAG:
        # Averaging the distributions before resolving lets several partial
        # views of the same animal add up to a species, where each frame alone
        # would only have justified the family.
        top = sorted(hits, key=lambda hit: hit.score, reverse=True)[: cfg.vote_frames]
        mean = np.mean([hit.probs for hit in top], axis=0)
        resolved = models.taxonomy.resolve(mean, cfg.species_conf)
        if resolved.kind == ANIMAL_TAG:
            tags, label, rank, confidence = (
                list(resolved.tags), resolved.label, resolved.rank, resolved.confidence,
            )
        else:
            # The vote came out blank even though the detector kept finding an
            # animal, frame after frame. Keep the event — just do not pretend
            # to put a name to it.
            tags, label, rank, confidence = [ANIMAL_TAG], ANIMAL_TAG, "kind", best.score
    else:
        tags = [primary]
        label, rank = primary, "kind"
        # The classifier abstained on these, so the number that means something
        # is how sure the detector was.
        confidence = best.resolved.confidence if best.resolved.kind == primary else best.score

    for other in present:
        if other != primary and other not in tags:
            tags.append(other)

    payload = {
        "tags": tags,
        "label": label,
        "rank": rank,
        "confidence": round(float(confidence), 4),
        **diagnostics,
    }
    # Where the best view of the subject was, for the thumbnail.
    return payload, {"seconds": best.seconds, "box": best.box}
