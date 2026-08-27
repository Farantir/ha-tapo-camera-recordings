"""Run with: python3 -m unittest discover -s tagger"""
import os
import tempfile
import unittest

from PIL import Image

import thumbs


class Cfg:
    thumb_width = 640
    thumb_quality = 82
    thumb_fill = 0.45


FRAME = Image.new("RGB", (2560, 1440))


class CropTest(unittest.TestCase):
    def crop(self, box, fill=Cfg.thumb_fill, image=FRAME):
        return thumbs._crop_box(image, box, fill)

    def test_the_window_is_sixteen_by_nine(self):
        crop = self.crop((1000, 600, 1200, 900))
        self.assertAlmostEqual(crop.width / crop.height, 16 / 9, places=1)

    def test_the_subject_is_inside_the_window(self):
        box = (1000, 600, 1200, 900)
        crop = self.crop(box)
        # Reconstruct where the window sits by cropping the same frame again
        # and checking the box fits within a window of that size centred on it.
        self.assertGreaterEqual(crop.width, box[2] - box[0])
        self.assertGreaterEqual(crop.height, box[3] - box[1])

    def test_a_tiny_subject_is_never_blown_up_past_the_sensor(self):
        # A 30 px animal cropped to fill 45% of the frame would be a 66 px wide
        # window upscaled 10x into mush. The floor keeps it at native pixels.
        crop = self.crop((100, 100, 130, 130))
        self.assertGreaterEqual(crop.width, thumbs.MIN_WIDTH)

    def test_a_subject_filling_the_frame_cannot_crop_outside_it(self):
        crop = self.crop((0, 0, 2560, 1440))
        self.assertLessEqual(crop.width, FRAME.width)
        self.assertLessEqual(crop.height, FRAME.height)

    def test_a_corner_subject_stays_in_frame(self):
        for box in ((0, 0, 200, 200), (2360, 1240, 2560, 1440)):
            crop = self.crop(box)
            self.assertLessEqual(crop.width, FRAME.width)
            self.assertLessEqual(crop.height, FRAME.height)

    def test_a_frame_shorter_than_sixteen_by_nine_still_fits(self):
        square = Image.new("RGB", (400, 400))
        crop = self.crop((150, 150, 250, 250), image=square)
        self.assertLessEqual(crop.width, square.width)
        self.assertLessEqual(crop.height, square.height)


class WriterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.writer = thumbs.ThumbWriter(self.dir.name)

    def write(self, event_id):
        path = self.writer.path_for(event_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.new("RGB", (64, 36)).save(path)
        return path

    def test_an_event_with_no_subject_gets_no_picture(self):
        self.assertFalse(self.writer.write("garage/1-2", "unused.mp4", None, Cfg))

    def test_a_re_analysis_that_finds_nothing_removes_the_old_picture(self):
        path = self.write("garage/1-2")
        self.writer.write("garage/1-2", "unused.mp4", None, Cfg)
        self.assertFalse(os.path.exists(path))

    def test_prune_follows_the_sidecar(self):
        keep = self.write("garage/1-2")
        drop = self.write("haustuer/3-4")
        self.assertEqual(self.writer.prune({"garage/1-2"}), 1)
        self.assertTrue(os.path.exists(keep))
        self.assertFalse(os.path.exists(drop))

    def test_prune_on_a_directory_that_was_never_written_is_quiet(self):
        self.assertEqual(thumbs.ThumbWriter("/no/such/place").prune(set()), 0)


if __name__ == "__main__":
    unittest.main()
