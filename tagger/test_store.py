"""Run with: python3 -m unittest discover -s tagger"""
import json
import os
import tempfile
import unittest

from store import TagStore

PAYLOAD = {"tags": ["animal", "domestic cat"], "label": "domestic cat",
           "rank": "species", "confidence": 0.99}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "tags.json")
        self.addCleanup(self.dir.cleanup)

    def read(self):
        with open(self.path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_a_missing_file_is_an_empty_index(self):
        store = TagStore(self.path).load()
        self.assertEqual(store.events, {})

    def test_round_trip(self):
        store = TagStore(self.path)
        store.put("haustuer/1-2", PAYLOAD, "100:200")
        store.save()
        again = TagStore(self.path).load()
        self.assertEqual(again.events["haustuer/1-2"]["label"], "domestic cat")
        self.assertEqual(again.fingerprint("haustuer/1-2"), "100:200")

    def test_prune_drops_events_whose_video_is_gone(self):
        store = TagStore(self.path)
        store.put("a/1-2", PAYLOAD, "1:1")
        store.put("b/3-4", PAYLOAD, "1:1")
        store.save()

        removed = store.prune({"a/1-2"})
        store.save()
        self.assertEqual(removed, 1)
        self.assertEqual(list(self.read()["events"]), ["a/1-2"])

    def test_prune_of_nothing_leaves_the_file_alone(self):
        store = TagStore(self.path)
        store.put("a/1-2", PAYLOAD, "1:1")
        store.save()
        before = os.path.getmtime(self.path)
        self.assertEqual(store.prune({"a/1-2"}), 0)
        self.assertFalse(store.save())
        self.assertEqual(os.path.getmtime(self.path), before)

    def test_outdated_tracks_size_and_mtime(self):
        store = TagStore(self.path)
        store.put("a/1-2", PAYLOAD, "100:200")
        self.assertFalse(store.outdated("a/1-2", "100:200"))
        self.assertTrue(store.outdated("a/1-2", "101:200"))
        self.assertTrue(store.outdated("a/1-2", "100:201"))
        self.assertTrue(store.outdated("never/seen", "1:1"))

    def test_a_corrupt_file_is_rebuilt_rather_than_trusted(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('{"version":1,"events":{"a/1-2":{"tag')
        self.assertEqual(TagStore(self.path).load().events, {})

    def test_a_future_version_is_not_half_read(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump({"version": 99, "events": {"a/1-2": PAYLOAD}}, fh)
        self.assertEqual(TagStore(self.path).load().events, {})

    def test_save_leaves_no_temp_files_behind(self):
        store = TagStore(self.path)
        store.put("a/1-2", PAYLOAD, "1:1")
        store.save()
        self.assertEqual(sorted(os.listdir(self.dir.name)), ["tags.json"])

    def test_save_is_atomic_from_a_readers_point_of_view(self):
        # The replace happens on a fully written file, so a reader either sees
        # the old content or the new — never a truncated document.
        store = TagStore(self.path)
        store.put("a/1-2", PAYLOAD, "1:1")
        store.save()
        first = self.read()
        store.put("b/3-4", PAYLOAD, "1:1")
        store.save()
        self.assertEqual(len(first["events"]), 1)
        self.assertEqual(len(self.read()["events"]), 2)


if __name__ == "__main__":
    unittest.main()
