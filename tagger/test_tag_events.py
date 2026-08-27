"""Run with: python3 -m unittest discover -s tagger"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tag_events
import thumbs
from store import VERSION, TagStore

PAYLOAD = {"tags": ["animal"], "label": "animal", "rank": "kind", "confidence": 0.9}


class Cfg:
    def __init__(self, root):
        self.root = Path(root)


class QueueTest(unittest.TestCase):
    """The queue is re-derived from disk before every clip, newest first."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = Cfg(self.dir.name)
        self.store = TagStore(os.path.join(self.dir.name, "tags.json"))

    def record(self, camera, stem):
        videos = os.path.join(self.dir.name, camera, "videos")
        os.makedirs(videos, exist_ok=True)
        path = os.path.join(videos, f"{stem}.mp4")
        with open(path, "wb") as fh:
            fh.write(b"x")
        return f"{camera}/{stem}"

    def pick(self, blocked=frozenset()):
        target, _total, _pending = tag_events.newest_pending(self.cfg, self.store, blocked)
        return None if target is None else target[0]

    def tag(self, event_id):
        live = tag_events.discover(self.cfg.root)
        self.store.put(event_id, PAYLOAD, live[event_id][1])

    def test_the_newest_recording_goes_first_whichever_camera_it_is_on(self):
        self.record("garage", "1700000000-1700000060")
        newest = self.record("haustuer", "1700009000-1700009060")
        self.record("garage", "1700005000-1700005060")
        self.assertEqual(self.pick(), newest)

    def test_the_backlog_is_worked_downwards(self):
        old = self.record("garage", "1700000000-1700000060")
        mid = self.record("garage", "1700005000-1700005060")
        new = self.record("garage", "1700009000-1700009060")
        for expected in (new, mid, old):
            self.assertEqual(self.pick(), expected)
            self.tag(expected)
        self.assertIsNone(self.pick())

    def test_a_recording_that_lands_mid_backfill_is_next(self):
        # The whole point of re-listing: fresh footage is what someone is
        # actually waiting for, and the backlog can have the leftover compute.
        self.record("garage", "1700000000-1700000060")
        self.record("garage", "1700001000-1700001060")
        self.tag(self.pick())
        arrived = self.record("haustuer", "1799999000-1799999060")
        self.assertEqual(self.pick(), arrived)

    def test_a_clip_that_failed_this_pass_is_not_handed_back_forever(self):
        broken = self.record("garage", "1700009000-1700009060")
        other = self.record("garage", "1700000000-1700000060")
        self.assertEqual(self.pick(), broken)
        self.assertEqual(self.pick(blocked={broken}), other)

    def test_an_already_tagged_recording_is_not_offered_again(self):
        only = self.record("garage", "1700000000-1700000060")
        self.tag(only)
        self.assertIsNone(self.pick())

    def test_a_changed_recording_is_offered_again(self):
        only = self.record("garage", "1700000000-1700000060")
        self.tag(only)
        with open(os.path.join(self.dir.name, "garage", "videos",
                               "1700000000-1700000060.mp4"), "ab") as fh:
            fh.write(b"more")
        self.assertEqual(self.pick(), only)

    def test_picking_prunes_events_whose_video_is_gone(self):
        gone = self.record("garage", "1700000000-1700000060")
        self.tag(gone)
        os.unlink(os.path.join(self.dir.name, "garage", "videos",
                               "1700000000-1700000060.mp4"))
        self.pick()
        self.assertEqual(self.store.events, {})


if __name__ == "__main__":
    unittest.main()


class StubAnalyse:
    """Stands in for the models: every clip is an animal at 1.0s."""

    @staticmethod
    def analyse_video(_models, _path, _cfg):
        return dict(PAYLOAD), {"seconds": 1.0, "box": (0, 0, 10, 10)}


class StubWriter(thumbs.ThumbWriter):
    """The real pruning and pathing; a stub for the ffmpeg/PIL part."""

    def write(self, event_id, _video, subject, _cfg):
        if subject is None:
            self.discard(event_id)
            return False
        path = self.path_for(event_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"jpeg")
        return True


class PassTest(unittest.TestCase):
    """A whole pass, with the models stubbed out."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.cfg = Cfg(self.dir.name)
        self.cfg.limit = 0
        self.tags = os.path.join(self.dir.name, "tags.json")
        self.store = TagStore(self.tags)
        self.writer = StubWriter(os.path.join(self.dir.name, "thumbs"))

    def record(self, camera, stem):
        videos = os.path.join(self.dir.name, camera, "videos")
        os.makedirs(videos, exist_ok=True)
        with open(os.path.join(videos, f"{stem}.mp4"), "wb") as fh:
            fh.write(b"x")
        return f"{camera}/{stem}", os.path.join(videos, f"{stem}.mp4")

    def run_pass(self):
        with mock.patch.object(tag_events, "analyse", StubAnalyse):
            return tag_events.run_pass(None, self.cfg, self.store, self.writer, lambda: False)

    def test_a_pass_tags_every_clip_and_writes_a_thumbnail_for_each(self):
        a, _ = self.record("garage", "1700000000-1700000060")
        b, _ = self.record("haustuer", "1700009000-1700009060")
        self.assertEqual(self.run_pass(), (2, 0))
        self.assertEqual(sorted(self.store.events), sorted([a, b]))
        for event_id in (a, b):
            self.assertTrue(os.path.exists(self.writer.path_for(event_id)), event_id)

    def test_the_sidecar_is_on_disk_after_every_clip_not_just_at_the_end(self):
        self.record("garage", "1700000000-1700000060")
        self.record("garage", "1700009000-1700009060")
        seen = []
        real_save = self.store.save

        def spy(force=False):
            wrote = real_save(force)
            if wrote and not force:
                with open(self.tags, encoding="utf-8") as fh:
                    seen.append(len(json.load(fh)["events"]))
            return wrote

        with mock.patch.object(self.store, "save", spy):
            self.run_pass()
        # One clip, one write — the file grew by one each time rather than
        # appearing all at once at the end of the pass.
        self.assertEqual(seen, [1, 2])

    def test_deleting_a_video_removes_its_tag_and_its_thumbnail(self):
        gone, path = self.record("garage", "1700000000-1700000060")
        kept, _ = self.record("garage", "1700009000-1700009060")
        self.run_pass()
        thumb = self.writer.path_for(gone)
        self.assertTrue(os.path.exists(thumb))

        os.unlink(path)
        self.run_pass()
        self.assertNotIn(gone, self.store.events)
        self.assertFalse(os.path.exists(thumb))
        self.assertTrue(os.path.exists(self.writer.path_for(kept)))

    def test_a_camera_that_leaves_the_backup_takes_its_folder_with_it(self):
        gone, path = self.record("garage", "1700000000-1700000060")
        self.record("haustuer", "1700009000-1700009060")
        self.run_pass()
        os.unlink(path)
        os.rmdir(os.path.dirname(path))
        os.rmdir(os.path.join(self.dir.name, "garage"))
        self.run_pass()
        self.assertNotIn(gone, self.store.events)
        self.assertFalse(os.path.exists(os.path.join(self.writer.dir, "garage")))

    def test_a_pass_with_nothing_to_do_still_prunes(self):
        # The prune has to happen even when there is no clip to analyse —
        # otherwise a deleted recording keeps its picture until the next time
        # something new turns up.
        gone, path = self.record("garage", "1700000000-1700000060")
        self.run_pass()
        os.unlink(path)
        self.assertEqual(self.run_pass(), (0, 0))
        self.assertFalse(os.path.exists(self.writer.path_for(gone)))


class VersionTest(unittest.TestCase):
    """The sidecar carries a format number, checked when it is loaded."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "tags.json")

    def write(self, payload):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        return TagStore(self.path).load()

    def test_the_current_version_is_kept(self):
        store = self.write({"version": VERSION, "events": {"a/1-2": PAYLOAD}})
        self.assertEqual(list(store.events), ["a/1-2"])

    def test_a_sidecar_from_before_versioning_is_dropped(self):
        self.assertEqual(self.write({"events": {"a/1-2": PAYLOAD}}).events, {})

    def test_an_older_version_is_dropped(self):
        self.assertEqual(self.write({"version": VERSION - 1,
                                     "events": {"a/1-2": PAYLOAD}}).events, {})

    def test_a_newer_version_is_dropped_rather_than_half_read(self):
        self.assertEqual(self.write({"version": VERSION + 1,
                                     "events": {"a/1-2": PAYLOAD}}).events, {})

    def test_json_that_is_not_a_sidecar_at_all_does_not_crash(self):
        self.assertEqual(self.write([1, 2, 3]).events, {})
        self.assertEqual(self.write("nope").events, {})
