"""The tags sidecar: load, prune, write atomically.

The viewer only ever reads this file, and the footage mount stays read-only, so
this is the one place the two processes meet.
"""

import json
import logging
import os
import tempfile
import time

log = logging.getLogger("tagger.store")

VERSION = 1


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
        if data.get("version") != VERSION:
            log.warning("%s is version %s, expected %s — rebuilding", self.path,
                        data.get("version"), VERSION)
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
