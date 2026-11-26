"""Near-duplicate questions (Phase 7 D-22, taken over by Phase 5.1.1 D-20): character 3-gram Jaccard on normalize_text."""

from collections.abc import Iterable

from rag_eval.matching import normalize_text

NEAR_DUPLICATE_THRESHOLD = 0.85


def _trigrams(text: str) -> frozenset[str]:
    normalized = normalize_text(text)
    if len(normalized) < 3:
        return frozenset({normalized}) if normalized else frozenset()
    return frozenset(normalized[index : index + 3] for index in range(len(normalized) - 2))


def jaccard(left: str, right: str) -> float:
    a, b = _trigrams(left), _trigrams(right)
    union = a | b
    return len(a & b) / len(union) if union else 0.0


def near_duplicates(
    rows: Iterable[tuple[str, str]], threshold: float = NEAR_DUPLICATE_THRESHOLD
) -> list[tuple[str, str, float]]:
    """Every pair (id_a, id_b, score) of the given (id, question) rows at or above the threshold, in input order."""
    grams = [(item_id, _trigrams(text)) for item_id, text in rows]
    pairs: list[tuple[str, str, float]] = []
    for i, (left_id, left) in enumerate(grams):
        for right_id, right in grams[i + 1 :]:
            union = left | right
            score = len(left & right) / len(union) if union else 0.0
            if score >= threshold:
                pairs.append((left_id, right_id, score))
    return pairs


def matches(question: str, existing: Iterable[tuple[str, str]], threshold: float = NEAR_DUPLICATE_THRESHOLD) -> list[tuple[str, float]]:
    """Existing (id, score) pairs whose question is a near-duplicate of the given one, best first."""
    found = [(item_id, jaccard(question, text)) for item_id, text in existing]
    return sorted([(item_id, score) for item_id, score in found if score >= threshold], key=lambda row: (-row[1], row[0]))
