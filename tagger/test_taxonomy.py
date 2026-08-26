"""Run with: python3 -m unittest discover -s tagger"""
import os
import unittest

import taxonomy

LABELS = os.environ.get("SPECIESNET_LABELS", "/models/classifier.labels.txt")


def rows():
    return [
        "u1;;;;;;blank",
        "u2;;;;;;vehicle",
        "u3;mammalia;primates;hominidae;homo;sapiens;human",
        "u4;mammalia;;;;;mammal",
        "u5;mammalia;carnivora;felidae;;;cat family",
        "u6;mammalia;carnivora;felidae;felis;catus;domestic cat",
        "u7;mammalia;carnivora;felidae;lynx;lynx;eurasian lynx",
        "u8;mammalia;eulipotyphla;erinaceidae;erinaceus;europaeus;western european hedgehog",
        "u9;mammalia;rodentia;sciuridae;sciurus;vulgaris;eurasian red squirrel",
        "u10;aves;;;;;bird",
    ]


IDX = {r.split(";")[-1]: i for i, r in enumerate(rows())}


def vector(**weights):
    probs = [0.0] * len(rows())
    for name, value in weights.items():
        probs[IDX[name.replace("_", " ")]] = value
    return probs


class TaxonomyTest(unittest.TestCase):
    def setUp(self):
        self.tax = taxonomy.Taxonomy(rows())

    def test_blank_is_no_event(self):
        r = self.tax.resolve(vector(blank=0.97, bird=0.03))
        self.assertEqual(r.kind, "no_event")
        self.assertEqual(r.tags, ["no_event"])

    def test_vehicle_wins_on_its_own(self):
        self.assertEqual(self.tax.resolve(vector(vehicle=0.9)).kind, "vehicle")

    def test_human_is_not_filed_as_an_animal(self):
        r = self.tax.resolve(vector(human=0.9, bird=0.1))
        self.assertEqual(r.kind, "human")
        self.assertNotIn("animal", r.tags)
        self.assertNotIn("mammalia", r.tags)

    def test_confident_species_yields_the_whole_chain(self):
        r = self.tax.resolve(vector(domestic_cat=0.96), threshold=0.55)
        self.assertEqual(r.kind, "animal")
        self.assertEqual(r.rank, "species")
        self.assertEqual(r.label, "domestic cat")
        for expected in ("animal", "mammalia", "mammal", "felidae", "cat family", "domestic cat"):
            self.assertIn(expected, r.tags)

    def test_species_epithet_alone_is_not_a_tag(self):
        r = self.tax.resolve(vector(domestic_cat=0.96))
        self.assertNotIn("catus", r.tags)

    def test_split_between_two_cats_rolls_up_to_the_family(self):
        # Neither species clears the bar, but together the family does — this is
        # the "as family when it is less sure" behaviour.
        r = self.tax.resolve(vector(domestic_cat=0.45, eurasian_lynx=0.45), threshold=0.55)
        self.assertEqual(r.rank, "family")
        self.assertEqual(r.label, "cat family")
        self.assertIn("felidae", r.tags)
        self.assertNotIn("domestic cat", r.tags)

    def test_split_across_orders_rolls_up_to_the_class(self):
        r = self.tax.resolve(
            vector(domestic_cat=0.34, western_european_hedgehog=0.33, eurasian_red_squirrel=0.30),
            threshold=0.55,
        )
        self.assertEqual(r.rank, "class")
        self.assertEqual(r.label, "mammal")

    def test_no_confident_branch_stops_at_animal(self):
        r = self.tax.resolve(vector(domestic_cat=0.34, bird=0.33, blank=0.33), threshold=0.55)
        self.assertEqual(r.kind, "animal")
        self.assertEqual(r.rank, "kind")
        self.assertEqual(r.tags, ["animal"])

    def test_a_human_reading_does_not_drag_the_walk_into_primates(self):
        # Humans outweigh any single animal, so the kind is human; the point is
        # that the primate branch does not also become the animal answer.
        r = self.tax.resolve(vector(human=0.6, domestic_cat=0.4))
        self.assertEqual(r.kind, "human")

    def test_hedgehog_and_squirrel_resolve_to_their_own_species(self):
        for name, label in (
            ("western_european_hedgehog", "western european hedgehog"),
            ("eurasian_red_squirrel", "eurasian red squirrel"),
        ):
            r = self.tax.resolve(vector(**{name: 0.9}))
            self.assertEqual(r.label, label)
            self.assertEqual(r.rank, "species")


@unittest.skipUnless(os.path.exists(LABELS), f"{LABELS} not present")
class RealLabelsTest(unittest.TestCase):
    def test_the_shipped_label_file_parses(self):
        tax = taxonomy.load(LABELS)
        self.assertGreater(len(tax), 2000)
        self.assertIn(("mammalia", "carnivora", "felidae"), tax.common)


if __name__ == "__main__":
    unittest.main()
