"""Golden decontamination (D-09): training queries that duplicate a golden question are dropped, and documents holding gold
evidence of a test-split golden item are forced into the fine-tune test split."""
from collections.abc import Iterable, Sequence
from pathlib import Path

from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.finetune.textnorm import char_ngrams, jaccard, normalize
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT

FIXTURE_GOLDEN_PATH = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
PRIVATE_GOLDEN_PATH = REPO_ROOT / "eval" / "golden" / "private" / "golden.jsonl"
GOLDEN_NGRAM = 3
GOLDEN_OVERLAP_JACCARD = 0.8


def default_golden_paths() -> list[Path]:
    """The committed golden set plus the private golden file when it exists."""
    paths = [FIXTURE_GOLDEN_PATH]
    if PRIVATE_GOLDEN_PATH.is_file():
        paths.append(PRIVATE_GOLDEN_PATH)
    return paths


def load_golden_items(paths: Iterable[Path] | None = None) -> list[GoldenItem]:
    items: list[GoldenItem] = []
    for path in default_golden_paths() if paths is None else paths:
        items.extend(load_golden(Path(path)))
    return items


def load_golden_questions(paths: Iterable[Path] | None = None) -> list[str]:
    """Every golden question of every split and provenance."""
    return [item.question for item in load_golden_items(paths)]


class GoldenIndex:
    """Normalised character n-grams of the golden questions, built once."""

    def __init__(self, questions: Iterable[str], n: int = GOLDEN_NGRAM):
        self.n = n
        grams = (char_ngrams(normalize(question), n) for question in questions)
        self._grams = [g for g in grams if g]

    def __len__(self) -> int:
        return len(self._grams)

    def best(self, query: str) -> float:
        grams = char_ngrams(normalize(query), self.n)
        if not grams:
            return 0.0
        size = len(grams)
        best = 0.0
        for golden in self._grams:
            small, large = sorted((size, len(golden)))
            if small / large <= best:
                continue
            best = max(best, jaccard(grams, golden))
        return best

    def overlaps(self, query: str, threshold: float = GOLDEN_OVERLAP_JACCARD) -> bool:
        return self.best(query) >= threshold


_DEFAULT_INDEX: tuple[tuple[tuple[str, int], ...], GoldenIndex] | None = None


def _default_index() -> GoldenIndex:
    global _DEFAULT_INDEX
    paths = default_golden_paths()
    key = tuple((str(path), path.stat().st_mtime_ns) for path in paths)
    if _DEFAULT_INDEX is None or _DEFAULT_INDEX[0] != key:
        _DEFAULT_INDEX = (key, GoldenIndex(load_golden_questions(paths)))
    return _DEFAULT_INDEX[1]


def golden_overlap(
    query: str, golden: GoldenIndex | Sequence[str] | None = None, *, threshold: float = GOLDEN_OVERLAP_JACCARD
) -> bool:
    """True when the query's normalised character 3-grams have Jaccard >= threshold with any golden question."""
    if not 0 < threshold <= 1:
        raise ValueError("threshold must be in (0, 1]")
    if golden is None:
        index = _default_index()
    elif isinstance(golden, GoldenIndex):
        index = golden
    else:
        index = GoldenIndex(golden)
    return index.overlaps(query, threshold)


def golden_test_documents(items: Iterable[GoldenItem]) -> set[str]:
    """Document names of the gold evidence of every test-split golden item."""
    return {span.document for item in items if item.split == "test" for span in item.gold_evidence}


def golden_test_document_ids(items: Iterable[GoldenItem]) -> set[str]:
    """Document ids (lower case) named by the gold evidence of test-split items, where the span carries one."""
    return {
        span.document_id.lower()
        for item in items
        if item.split == "test"
        for span in item.gold_evidence
        if span.document_id
    }
