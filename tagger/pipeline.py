"""Two-stage analysis of one recording.

A subject can occupy two seconds of a sixty-second clip, so the stills the
camera saves next to each video are usually empty and sampling a handful of
frames at random misses the animal entirely. Instead every clip is scanned
cheaply for motion, the most promising frames are pulled at full resolution,
a detector finds subjects in them, and each crop goes to the classifier.

Motion only ever *chooses* frames. It never decides whether something
happened: wind in a hedge and a shadow crossing a path light up a difference
mask just as brightly as an animal does, and the detector is what tells them
apart.
"""

import io
import logging
import subprocess

import numpy as np
import onnxruntime as ort
from PIL import Image

import taxonomy

log = logging.getLogger("tagger.pipeline")

# COCO ids the detector may propose. The class is only used to decide whether a
# crop is worth classifying — SpeciesNet has the final say on what it is.
COCO_SUBJECTS = {
    0: "person",
    1: "vehicle", 2: "vehicle", 3: "vehicle", 5: "vehicle", 7: "vehicle",
    14: "animal", 15: "animal", 16: "animal", 17: "animal", 18: "animal",
    19: "animal", 20: "animal", 21: "animal", 22: "animal", 23: "animal",
}

SCAN_W, SCAN_H = 320, 180
# Enough frames to estimate a clean background; more adds cost, not accuracy.
BACKGROUND_FRAMES = 48
DETECTOR_SIZE = 640
CLASSIFIER_SIZE = 480
# The burned-in clock changes every second in every clip, so it is masked out
# of the difference rather than counted as motion.
CLOCK_ROWS = 14


class FfmpegError(RuntimeError):
    pass


# ffmpeg ships with http/https/rtmp/tcp enabled, and some demuxers (HLS, concat)
# will follow a reference inside a file out to the network. Nothing here ever
# opens anything but a local path, so every invocation says so explicitly —
# a malformed or hostile recording then cannot turn into an outbound request.
LOCAL_ONLY = ("-protocol_whitelist", "file")


def _run(cmd, expect_output=True):
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise FfmpegError((proc.stderr or b"").decode("utf-8", "replace").strip()[:400])
    if expect_output and not proc.stdout:
        raise FfmpegError("produced no output")
    return proc.stdout


def duration_seconds(path):
    out = _run([
        "ffprobe", "-v", "error", *LOCAL_ONLY, "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
    ])
    try:
        return float(out.decode().strip())
    except ValueError as err:
        raise FfmpegError(f"unreadable duration: {out!r}") from err


def scan_frames(path, fps):
    """Whole clip at thumbnail size — small enough to hold in memory at once."""
    raw = _run([
        "ffmpeg", "-v", "error", *LOCAL_ONLY, "-i", str(path),
        "-vf", f"fps={fps},scale={SCAN_W}:{SCAN_H}",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ])
    stride = SCAN_W * SCAN_H * 3
    count = len(raw) // stride
    if count == 0:
        raise FfmpegError("decoded no frames")
    return np.frombuffer(raw[: count * stride], dtype=np.uint8).reshape(count, SCAN_H, SCAN_W, 3)


def motion_scores(frames):
    """How far each frame sits from the clip's own median background.

    The background is built from the clip itself, so lighting matches exactly —
    unlike a background pooled across events hours apart, where sun movement
    alone swamps the difference.
    """
    count = len(frames)
    picks = np.linspace(0, count - 1, min(BACKGROUND_FRAMES, count)).astype(int)
    background = np.median(frames[picks].astype(np.float32), axis=0)
    background[:CLOCK_ROWS] = 0
    scores = np.empty(count, dtype=np.float32)
    for i in range(count):
        frame = frames[i].astype(np.float32)
        frame[:CLOCK_ROWS] = 0
        scores[i] = (np.abs(frame - background).mean(axis=2) > 30).mean()
    return scores


def choose_frames(scores, budget):
    """Half the budget on the busiest frames, half spread evenly.

    A subject present for the whole clip is baked into the median background
    and barely registers as motion, so the even spread is what catches a parked
    car or an animal that settles down and stays.
    """
    count = len(scores)
    if count <= budget:
        return list(range(count))
    half = max(1, budget // 2)
    busiest = [int(i) for i in np.argsort(scores)[-half:]]
    spread = [int(i) for i in np.linspace(0, count - 1, budget - half).astype(int)]
    return sorted(set(busiest + spread))


def frame_at(path, seconds):
    """One frame at native resolution — the detector scores small subjects far
    better at full size than off the downscaled scan pass."""
    raw = _run([
        "ffmpeg", "-v", "error", *LOCAL_ONLY, "-ss", f"{seconds:.3f}", "-i", str(path),
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ])
    return Image.open(io.BytesIO(raw)).convert("RGB")


def crop_box(image, box, pad):
    x1, y1, x2, y2 = box
    dx, dy = (x2 - x1) * pad, (y2 - y1) * pad
    return image.crop((
        int(max(0, x1 - dx)), int(max(0, y1 - dy)),
        int(min(image.width, x2 + dx)), int(min(image.height, y2 + dy)),
    ))


class Models:
    def __init__(self, detector_path, classifier_path, labels_path, threads=0):
        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = threads
        providers = ["CPUExecutionProvider"]
        self.detector = ort.InferenceSession(str(detector_path), opts, providers=providers)
        self.classifier = ort.InferenceSession(str(classifier_path), opts, providers=providers)
        self.taxonomy = taxonomy.load(labels_path)
        self._det_input = self.detector.get_inputs()[0].name
        self._cls_input = self.classifier.get_inputs()[0].name

    def detect(self, image, min_score):
        """YOLOv10 emits already-deduplicated boxes, so there is no NMS here."""
        width, height = image.size
        resized = image.resize((DETECTOR_SIZE, DETECTOR_SIZE), Image.BILINEAR)
        batch = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
        out = self.detector.run(None, {self._det_input: batch})[0][0]
        found = []
        for x1, y1, x2, y2, score, cls in out:
            kind = COCO_SUBJECTS.get(int(cls))
            if kind is None or score < min_score:
                continue
            box = (
                x1 / DETECTOR_SIZE * width, y1 / DETECTOR_SIZE * height,
                x2 / DETECTOR_SIZE * width, y2 / DETECTOR_SIZE * height,
            )
            found.append((kind, float(score), box))
        return found

    def classify(self, crop):
        """SpeciesNet is an always-crop model: handed a whole frame it returns
        a muddle, handed a detector crop of the same frame it is decisive."""
        batch = np.asarray(
            crop.resize((CLASSIFIER_SIZE, CLASSIFIER_SIZE), Image.BILINEAR), dtype=np.float32
        )[None] / 255.0
        logits = self.classifier.run(None, {self._cls_input: batch})[0][0]
        shifted = np.exp(logits - logits.max())
        return shifted / shifted.sum()
