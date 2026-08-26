"""Turns a SpeciesNet probability vector into a tag chain.

The classifier emits 2498 labels that are already a taxonomy — ``blank`` and
``vehicle`` sit on their own, everything else carries
``class;order;family;genus;species`` plus a common name. Crucially there is a
label at *every* depth, so "some kind of squirrel" (``sciuridae family``) is a
class the model can pick on its own rather than something we synthesise.

That means no species list is configured anywhere: the caller asks for the
deepest node whose probability mass clears a threshold, and gets back whatever
the tree happens to say — ``animal`` when it is unsure, ``cat family`` when it
is surer, ``domestic cat`` when it is sure.
"""

from collections import defaultdict

# Anything below hominidae is a person, not wildlife, even though the taxonomy
# nests it under mammalia like every other mammal.
HUMAN_PATH = ("mammalia", "primates", "hominidae")

BLANK = ("\x00blank",)
VEHICLE = ("\x00vehicle",)

NO_EVENT = "no_event"
VEHICLE_TAG = "vehicle"
HUMAN_TAG = "human"
ANIMAL_TAG = "animal"


class Resolution:
    __slots__ = ("kind", "tags", "label", "confidence", "rank")

    def __init__(self, kind, tags, label, confidence, rank):
        self.kind = kind
        self.tags = tags
        self.label = label
        self.confidence = confidence
        self.rank = rank

    def as_dict(self):
        return {
            "tags": self.tags,
            "label": self.label,
            "rank": self.rank,
            "confidence": round(float(self.confidence), 4),
        }


RANKS = ("class", "order", "family", "genus", "species")


class Taxonomy:
    """The label file, indexed for prefix sums."""

    def __init__(self, rows):
        self.paths = []
        # Common name for an exact node, e.g. ("mammalia","carnivora","felidae")
        # -> "cat family". Present for most internal nodes.
        self.common = {}
        for row in rows:
            parts = row.split(";")
            if len(parts) != 7:
                raise ValueError(f"expected 7 fields, got {len(parts)}: {row!r}")
            _uuid, cls, order, family, genus, species, common = (p.strip().lower() for p in parts)
            if not any((cls, order, family, genus, species)):
                # The two specials get synthetic paths so they never collide
                # with the taxonomy root.
                path = BLANK if common == "blank" else VEHICLE
            else:
                path = tuple(p for p in (cls, order, family, genus, species) if p)
            self.paths.append(path)
            self.common.setdefault(path, common)
        if len(self.paths) < 2:
            raise ValueError("label file looks empty")

    def __len__(self):
        return len(self.paths)

    def _sums(self, probs):
        """Probability mass of every node, including its whole subtree."""
        sums = defaultdict(float)
        for i, p in enumerate(probs):
            if p < 1e-6:
                continue
            path = self.paths[i]
            for depth in range(len(path) + 1):
                sums[path[:depth]] += float(p)
        return sums

    def _name(self, path):
        """Display name for a node: its own common name, else the bare taxon."""
        return self.common.get(path) or path[-1]

    def resolve(self, probs, threshold=0.55):
        """Deepest node clearing `threshold`, with the chain that leads to it."""
        sums = self._sums(probs)
        blank = sums.get(BLANK, 0.0)
        vehicle = sums.get(VEHICLE, 0.0)
        human = sums.get(HUMAN_PATH, 0.0)
        animal = sums.get((), 0.0) - blank - vehicle - human

        kind, score = max(
            ((NO_EVENT, blank), (VEHICLE_TAG, vehicle), (HUMAN_TAG, human), (ANIMAL_TAG, animal)),
            key=lambda kv: kv[1],
        )
        if kind != ANIMAL_TAG:
            return Resolution(kind, [kind], kind, score, "kind")

        # Descend the wildlife tree only. People are counted above, so their
        # mass comes back out of hominidae's ancestors (mammalia, primates)
        # before those compete as children — otherwise a clear human reading
        # would drag the walk down the primate branch.
        sums.pop(BLANK, None)
        sums.pop(VEHICLE, None)
        for depth in range(len(HUMAN_PATH)):
            node = HUMAN_PATH[:depth]
            if node in sums:
                sums[node] -= human
        for node in list(sums):
            if node[: len(HUMAN_PATH)] == HUMAN_PATH:
                del sums[node]

        by_depth = defaultdict(list)
        for node, total in sums.items():
            if node:
                by_depth[len(node)].append((node, total))

        tags = [ANIMAL_TAG]
        path = ()
        rank = "kind"
        confidence = animal
        while len(path) < len(RANKS):
            children = [(n, t) for n, t in by_depth[len(path) + 1] if n[: len(path)] == path]
            if not children:
                break
            best, total = max(children, key=lambda kv: kv[1])
            if total < threshold:
                break
            path = best
            confidence = total
            rank = RANKS[len(path) - 1]
            # Both the scientific taxon and its common name become tags, so a
            # filter on "cat family" and one on "felidae" find the same events.
            # The species epithet is the exception: a bare "vulgaris" or
            # "europaeus" means nothing without its genus, and would collide
            # across unrelated species.
            names = [self._name(path)] if rank == "species" else [path[-1], self._name(path)]
            for tag in names:
                if tag and tag not in tags:
                    tags.append(tag)

        label = self._name(path) if path else ANIMAL_TAG
        return Resolution(ANIMAL_TAG, tags, label, confidence, rank)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return Taxonomy([line.strip() for line in fh if line.strip()])
