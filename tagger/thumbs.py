"""Per-event thumbnails cut from the moment the subject was actually seen.

The camera saves its own still at the start of the recording, which is the one
moment the subject reliably is *not* there yet — a row of them is a row of
empty driveways. The detector already knows which frame it found something in
and where in that frame it was, so the same information yields a far better
thumbnail for free: seek back to that frame, crop around the box, and write it
next to the sidecar.

The viewer prefers these over the camera's own stills wherever one exists, so
this directory is an overlay, never a replacement — deleting it costs nothing
but the better pictures.
"""

import logging
import os
import tempfile

from PIL import Image

import pipeline

log = logging.getLogger("tagger.thumbs")

ASPECT = 16 / 9

# Narrowest window we will cut, in sensor pixels. A 30 px animal asked to fill
# half the frame would give a 66 px window, and since the crop is only ever
# downscaled, that is what the viewer would then be handed — a postage stamp.
# The floor trades some of the zoom for a picture at roughly the size the list
# draws it, 168 CSS pixels.
MIN_WIDTH = 160


def _crop_box(image, box, fill):
    """A 16:9 window around `box`, sized so the subject fills `fill` of it.

    Never smaller than the output, so a distant animal is shown at the sensor's
    own resolution rather than upscaled into mush, and never larger than the
    frame.
    """
    x1, y1, x2, y2 = box
    width = max(x2 - x1, (y2 - y1) * ASPECT) / max(fill, 0.05)
    width = min(max(width, MIN_WIDTH), image.width)
    height = min(width / ASPECT, image.height)
    # Height may have been the binding constraint on a very wide frame.
    width = min(height * ASPECT, image.width)

    centre_x = (x1 + x2) / 2
    centre_y = (y1 + y2) / 2
    left = min(max(centre_x - width / 2, 0), image.width - width)
    top = min(max(centre_y - height / 2, 0), image.height - height)
    return image.crop((int(left), int(top), int(left + width), int(top + height)))


class ThumbWriter:
    """`<dir>/<camera>/<key>.jpg`, mirroring the event ids in the sidecar."""

    def __init__(self, directory):
        self.dir = str(directory)

    def path_for(self, event_id):
        return os.path.join(self.dir, f"{event_id}.jpg")

    def write(self, event_id, video, subject, cfg):
        """Cut the thumbnail for one event. True when one now exists.

        A clip with no subject in it gets none — and loses the one it had, in
        case a re-analysis is what took the subject away.
        """
        if subject is None:
            self.discard(event_id)
            return False
        try:
            frame = pipeline.frame_at(video, subject["seconds"])
            crop = _crop_box(frame, subject["box"], cfg.thumb_fill)
            if crop.width > cfg.thumb_width:
                height = max(1, round(cfg.thumb_width / crop.width * crop.height))
                crop = crop.resize((cfg.thumb_width, height), Image.LANCZOS)
            self._save(self.path_for(event_id), crop, cfg.thumb_quality)
            return True
        except (pipeline.FfmpegError, OSError, ValueError) as err:
            # The tags themselves are already worth keeping; a missing picture
            # only means the viewer falls back to the camera's own still.
            log.warning("%s: no thumbnail (%s)", event_id, err)
            self.discard(event_id)
            return False

    def _save(self, dest, image, quality):
        directory = os.path.dirname(dest)
        os.makedirs(directory, exist_ok=True)
        # Same rename dance as the sidecar: the viewer reads this directory
        # while we write it, and a half-written JPEG renders as a broken image.
        handle, tmp = tempfile.mkstemp(dir=directory, prefix=".thumb-", suffix=".jpg")
        try:
            with os.fdopen(handle, "wb") as fh:
                image.save(fh, "JPEG", quality=quality, optimize=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, dest)
            try:
                os.chmod(dest, 0o644)
            except OSError:
                pass
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def discard(self, event_id):
        try:
            os.unlink(self.path_for(event_id))
            return True
        except OSError:
            return False

    def prune(self, live_ids):
        """Drop thumbnails for events the sidecar no longer has.

        The sidecar is itself pruned against the footage on every pass, so
        following it is what deletes a thumbnail when the camera rotates its
        backup and the recording disappears. Without this the pictures would
        outlive the videos they were cut from and the directory would only ever
        grow.
        """
        removed = 0
        for camera in self._subdirs():
            directory = os.path.join(self.dir, camera)
            try:
                names = os.listdir(directory)
            except OSError:
                continue
            for name in names:
                if not name.endswith(".jpg"):
                    continue
                if f"{camera}/{name[:-4]}" in live_ids:
                    continue
                try:
                    os.unlink(os.path.join(directory, name))
                    removed += 1
                except OSError:
                    pass
            # A camera that has been taken out of the backup leaves an empty
            # folder behind; drop it so the tree mirrors the footage exactly.
            try:
                os.rmdir(directory)
            except OSError:
                pass
        if removed:
            log.info("pruned %d thumbnail(s) whose event is gone", removed)
        return removed

    def _subdirs(self):
        try:
            return [e.name for e in os.scandir(self.dir) if e.is_dir()]
        except OSError:
            return []
