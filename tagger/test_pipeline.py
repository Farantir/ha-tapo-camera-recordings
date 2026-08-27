"""Run with: python3 -m unittest discover -s tagger"""
import unittest

import numpy as np
from PIL import Image

import pipeline


class ChooseFramesTest(unittest.TestCase):
    def test_a_short_clip_is_taken_whole(self):
        self.assertEqual(pipeline.choose_frames(np.zeros(5), 24), [0, 1, 2, 3, 4])

    def test_the_busiest_frames_do_not_all_come_from_one_burst(self):
        # One long swell in the middle and a brief spike near the start — the
        # shape of a clip where someone walks past twice. Taking the top
        # scorers outright spends the whole budget on the swell and never looks
        # at the spike; this is the regression that left a visible person
        # untagged.
        scores = np.zeros(120)
        scores[40:70] = np.linspace(0.5, 0.9, 30)
        scores[6] = 0.8
        chosen = pipeline.choose_frames(scores, 24, gap=4)
        self.assertIn(6, chosen)

    def test_peaks_keep_their_distance(self):
        scores = np.linspace(0, 1, 100)
        peaks = pipeline._peaks(scores, 5, gap=4)
        for i, a in enumerate(peaks):
            for b in peaks[i + 1:]:
                self.assertGreaterEqual(abs(a - b), 4)

    def test_the_whole_clip_is_still_covered(self):
        # Even with every peak in one place, the even spread reaches both ends.
        scores = np.zeros(200)
        scores[100:110] = 1.0
        chosen = pipeline.choose_frames(scores, 24, gap=4)
        self.assertLess(min(chosen), 10)
        self.assertGreater(max(chosen), 190)

    def test_the_budget_is_not_overspent(self):
        chosen = pipeline.choose_frames(np.random.RandomState(0).rand(500), 24, gap=4)
        self.assertLessEqual(len(chosen), 24)

    def test_flat_motion_still_yields_frames(self):
        chosen = pipeline.choose_frames(np.zeros(200), 24, gap=4)
        self.assertTrue(chosen)
        self.assertLessEqual(len(chosen), 24)


class LetterboxTest(unittest.TestCase):
    def test_the_frame_keeps_its_shape(self):
        canvas, scale, pad_x, pad_y = pipeline.letterbox(Image.new("RGB", (2560, 1440)), 640)
        self.assertEqual(canvas.size, (640, 640))
        self.assertAlmostEqual(scale, 640 / 2560)
        self.assertEqual(pad_x, 0)
        self.assertEqual(pad_y, (640 - 360) // 2)

    def test_boxes_map_back_onto_the_original_frame(self):
        image = Image.new("RGB", (2560, 1440))
        _canvas, scale, pad_x, pad_y = pipeline.letterbox(image, 640)
        # A box drawn around the whole frame in canvas coordinates has to come
        # back as the whole frame, or every thumbnail would be cut in the wrong
        # place.
        x1, y1 = pad_x, pad_y
        x2, y2 = 640 - pad_x, 640 - pad_y
        self.assertAlmostEqual((x1 - pad_x) / scale, 0)
        self.assertAlmostEqual((y1 - pad_y) / scale, 0)
        self.assertAlmostEqual((x2 - pad_x) / scale, 2560, places=0)
        self.assertAlmostEqual((y2 - pad_y) / scale, 1440, places=0)

    def test_a_portrait_frame_is_padded_sideways(self):
        _canvas, _scale, pad_x, pad_y = pipeline.letterbox(Image.new("RGB", (720, 1280)), 640)
        self.assertGreater(pad_x, 0)
        self.assertEqual(pad_y, 0)


if __name__ == "__main__":
    unittest.main()
