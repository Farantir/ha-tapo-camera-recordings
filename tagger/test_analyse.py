"""Run with: python3 -m unittest discover -s tagger"""
import unittest

import analyse
from taxonomy import ANIMAL_TAG, HUMAN_TAG, NO_EVENT, Resolution, VEHICLE_TAG


class Cfg:
    """Only the fields the two decision functions read."""
    min_frames = 2
    strong_score = 0.45
    strong_score_wildlife = 0.75
    trust_detector = 0.35


def resolution(kind, confidence=0.9, rank="kind"):
    return Resolution(kind, [kind], kind, confidence, rank)


def hit(score, kind=NO_EVENT, seconds=0.0, rank="kind"):
    return analyse.Hit(score, None, resolution(kind, rank=rank), seconds, (0, 0, 10, 10))


class DecideTest(unittest.TestCase):
    def test_the_classifier_names_the_kind_when_it_has_one(self):
        self.assertEqual(
            analyse.decide("animal", 0.9, resolution(ANIMAL_TAG), Cfg), ANIMAL_TAG)
        self.assertEqual(
            analyse.decide("human", 0.9, resolution(VEHICLE_TAG), Cfg), VEHICLE_TAG)

    def test_a_blank_verdict_does_not_erase_a_confident_detection(self):
        # The regression this exists for: clips with a plainly visible person
        # came back no_event because SpeciesNet called the crop blank.
        self.assertEqual(
            analyse.decide("human", 0.62, resolution(NO_EVENT), Cfg), HUMAN_TAG)
        self.assertEqual(
            analyse.decide("animal", 0.51, resolution(NO_EVENT), Cfg), ANIMAL_TAG)

    def test_a_weak_box_both_models_doubt_stays_nothing(self):
        self.assertEqual(
            analyse.decide("animal", 0.30, resolution(NO_EVENT), Cfg), NO_EVENT)


class PresentTest(unittest.TestCase):
    def test_two_sightings_are_enough_for_anything(self):
        kinds = {ANIMAL_TAG: [hit(0.3, ANIMAL_TAG), hit(0.31, ANIMAL_TAG)]}
        self.assertEqual(list(analyse._present(kinds, Cfg)), [ANIMAL_TAG])

    def test_one_moderate_sighting_carries_a_person_but_not_wildlife(self):
        # Someone can be in shot for a single sampled frame; a lone weak box in
        # a hedge is more likely a branch.
        self.assertEqual(
            list(analyse._present({HUMAN_TAG: [hit(0.5, HUMAN_TAG)]}, Cfg)), [HUMAN_TAG])
        self.assertEqual(
            list(analyse._present({ANIMAL_TAG: [hit(0.5, ANIMAL_TAG)]}, Cfg)), [])

    def test_one_certain_sighting_carries_wildlife_too(self):
        self.assertEqual(
            list(analyse._present({ANIMAL_TAG: [hit(0.8, ANIMAL_TAG)]}, Cfg)), [ANIMAL_TAG])

    def test_a_named_species_on_one_frame_is_enough(self):
        # A squirrel crossing a path is sharp in exactly one sampled frame and
        # a blur in its neighbours, so it can never be "seen twice". When the
        # classifier walked the taxonomy down to a species on that one crop,
        # that is the corroboration.
        lone = [hit(0.54, ANIMAL_TAG, rank="species")]
        self.assertEqual(list(analyse._present({ANIMAL_TAG: lone}, Cfg)), [ANIMAL_TAG])

    def test_a_lone_box_the_classifier_would_not_name_is_still_dropped(self):
        # The detector guessed animal, the classifier came back blank, and the
        # box was too weak to stand alone — a branch, in other words.
        lone = [hit(0.54, NO_EVENT)]
        self.assertEqual(list(analyse._present({ANIMAL_TAG: lone}, Cfg)), [])

    def test_no_event_is_never_a_kind_that_is_present(self):
        self.assertEqual(analyse._present({NO_EVENT: [hit(0.99), hit(0.99)]}, Cfg), {})


if __name__ == "__main__":
    unittest.main()
