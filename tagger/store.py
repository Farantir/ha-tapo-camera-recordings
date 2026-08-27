"""The tags sidecar: load, prune, write atomically.

The viewer only ever reads this file, and the footage mount stays read-only, so
this and the thumbnail directory beside it are the only places the two
processes meet.
"""

import json
import logging
import os
import tempfile
import time

log = logging.getLogger("tagger.store")

# 2 added the per-event thumbnail flag, and came with a reworked decision about
# what counts as an event. Bumping it makes an existing sidecar rebuild itself
# on the first run after an upgrade, which is what re-tags the backlog and cuts
# the thumbnails for it — otherwise every clip already in the file would keep
# its old answer forever, because its video has not changed.
VERSION = 2


class TagStore:
    def __init__(self, path):
        self.path = path
        self.events = {}
        self.models = {}
        self._dirty = False

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            log.info("%s does not exist yet — starting a fresh index", self.path)
            return self
        except (OSError, ValueError) as err:
            # Better to redo the work than to serve tags we cannot parse.
            log.warning("%s unreadable (%s) — starting a fresh index", self.path, err)
            return self
        if not isinstance(data, dict):
            # Valid JSON, but not a sidecar — a bare list or string would
            # otherwise blow up on the first .get() below.
            log.warning("%s is not a tags file — starting a fresh index", self.path)
            return self
        # Anything that is not exactly this version is discarded and rebuilt:
        # a missing number means it predates versioning, an older one means the
        # rules that produced it have changed, and a newer one is a format this
        # build does not know how to read.
        if data.get("version") != VERSION:
            log.warning("%s is version %s, expected %s — dropping it and re-tagging "
                        "every clip", self.path, data.get("version"), VERSION)
            return self
        events = data.get("events")
        if isinstance(events, dict):
            self.events = events
        self.models = data.get("models", {})
        log.info("loaded %d tagged events from %s", len(self.events), self.path)
        return self

    def fingerprint(self, event_id):
        entry = self.events.get(event_id)
        return entry.get("source") if entry else None

    def put(self, event_id, payload, fingerprint):
        self.events[event_id] = {**payload, "source": fingerprint, "taggedAt": int(time.time())}
        self._dirty = True

    def prune(self, live_ids):
        """Drop everything whose recording is gone.

        Without this the file only ever grows: the camera rotates its backup,
        the videos disappear, and their tags would sit here forever.
        """
        stale = [event_id for event_id in self.events if event_id not in live_ids]
        for event_id in stale:
            del self.events[event_id]
        if stale:
            self._dirty = True
            log.info("pruned %d event(s) whose video is gone", len(stale))
        return len(stale)

    def outdated(self, event_id, fingerprint):
        """True when this event has never been tagged, or the file changed."""
        return self.fingerprint(event_id) != fingerprint

    def save(self, force=False):
        if not (self._dirty or force):
            return False
        payload = {
            "version": VERSION,
            "generatedAt": int(time.time()),
            "models": self.models,
            "events": self.events,
        }
        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        os.makedirs(directory, exist_ok=True)
        # Write beside the target and rename, so a reader never sees a
        # half-written file on the shared volume.
        handle, tmp = tempfile.mkstemp(dir=directory, prefix=".tags-", suffix=".json")
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, separators=(",", ":"))
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o644)
            except OSError:
                pass
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        self._dirty = False
        log.info("wrote %d events to %s", len(self.events), self.path)
        return True
