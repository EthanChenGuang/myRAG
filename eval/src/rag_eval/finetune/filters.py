"""python -m rag_eval.finetune filter: keep only answerable, non-copied, non-duplicate, non-golden queries (Phase 6.1 D-07, D-09).

Rule filters, in order: (a) shape (length within the language's bounds) and language (the registry detector confidently
names another language than the requested one), (b) verbatim_copy, (c) near_duplicate, then golden_overlap (D-09).
Thresholds come from the `filters` block of eval/config/finetune.json.
"""
from collections import defaultdict
from collections.abc import Sequence

from rag_sidecar.contracts.finetune import FilterConfig
from rag_sidecar.ingest.lang import detect_language_with_confidence

from rag_eval.finetune.decontam import GoldenIndex
from rag_eval.finetune.generate import RawSyntheticQuery
from rag_eval.finetune.textnorm import char_ngrams, containment, jaccard, normalize

STYLE_ORDER = ("keyword", "question", "colloquial", "cross_language")
MAX_QUERY_CHARS = 400
DEFAULT_CONTAINMENT_NGRAM = 5
DEFAULT_VERBATIM_CONTAINMENT = 0.6
DEFAULT_LCS_RATIO = 0.7
DEFAULT_NEAR_DUP_NGRAM = 3
DEFAULT_NEAR_DUP_JACCARD = 0.8


def longest_common_substring(query: str, text: str) -> int:
    """Length of the longest common substring; a sparse DP row over the query's positions (queries are <= 400 chars)."""
    if not query or not text:
        return 0
    positions: dict[str, list[int]] = defaultdict(list)
    for index, ch in enumerate(query):
        positions[ch].append(index)
    best = 0
    previous: dict[int, int] = {}
    for ch in text:
        current: dict[int, int] = {}
        for index in positions.get(ch, ()):
            length = previous.get(index - 1, 0) + 1
            current[index] = length
            if length > best:
                best = length
        previous = current
        if best == len(query):
            break
    return best


def verbatim_copy(
    query: str,
    chunk_text: str,
    *,
    ngram: int = DEFAULT_CONTAINMENT_NGRAM,
    containment_threshold: float = DEFAULT_VERBATIM_CONTAINMENT,
    lcs_ratio: float = DEFAULT_LCS_RATIO,
) -> bool:
    """True when the normalised query's character n-grams are mostly in the chunk, or a long substring is copied (D-07b)."""
    q = normalize(query)
    c = normalize(chunk_text)
    if not q or not c:
        return False
    if len(q) >= ngram and containment(char_ngrams(q, ngram), char_ngrams(c, ngram)) >= containment_threshold:
        return True
    return longest_common_substring(q, c) >= lcs_ratio * len(q)


def _length_bounds(language: str, config: FilterConfig) -> tuple[int, int]:
    return config.min_query_chars.get(language, 1), config.max_query_chars.get(language, MAX_QUERY_CHARS)


def shape_ok(row: RawSyntheticQuery, config: FilterConfig) -> bool:
    low, high = _length_bounds(row.language, config)
    return low <= len(row.query.strip()) <= high


def language_ok(row: RawSyntheticQuery) -> bool:
    """A query is in the wrong language only when the detector is confident about another language."""
    detection = detect_language_with_confidence(row.query)
    return not (detection.confident and detection.language is not None and detection.language != row.language)


def rule_reason(row: RawSyntheticQuery, chunk_text: str, config: FilterConfig) -> str | None:
    """The first per-query rule that drops the row (shape, language, verbatim_copy), or None."""
    if not shape_ok(row, config):
        return "shape"
    if not language_ok(row):
        return "language"
    if verbatim_copy(
        row.query,
        chunk_text,
        ngram=config.containment_ngram,
        containment_threshold=config.verbatim_containment,
        lcs_ratio=config.lcs_ratio,
    ):
        return "verbatim_copy"
    return None


def golden_reason(row: RawSyntheticQuery, golden: GoldenIndex, config: FilterConfig) -> str | None:
    return "golden_overlap" if golden.overlaps(row.query, config.golden_overlap_jaccard) else None


def _style_rank(style: str) -> int:
    return STYLE_ORDER.index(style) if style in STYLE_ORDER else len(STYLE_ORDER)


def near_duplicates(
    rows: Sequence[RawSyntheticQuery],
    *,
    ngram: int = DEFAULT_NEAR_DUP_NGRAM,
    threshold: float = DEFAULT_NEAR_DUP_JACCARD,
) -> set[int]:
    """Indices to drop (D-07c): exact normalised duplicates inside a tenant, and n-gram Jaccard >= threshold among one
    chunk's queries. Rows are visited chunk by chunk in first-seen order and, inside a chunk, by style order (keyword,
    question, colloquial, cross_language); the first of a duplicate group is kept."""
    by_chunk: dict[tuple[str, str], list[int]] = {}
    for index, row in enumerate(rows):
        by_chunk.setdefault((row.tenant_key, row.chunk_id), []).append(index)
    seen: set[tuple[str, str]] = set()
    dropped: set[int] = set()
    for indices in by_chunk.values():
        kept_grams: list[set[str]] = []
        for index in sorted(indices, key=lambda i: (_style_rank(rows[i].style), i)):
            row = rows[index]
            key = (row.tenant_key, normalize(row.query))
            if key in seen:
                dropped.add(index)
                continue
            grams = char_ngrams(key[1], ngram)
            if any(jaccard(grams, other) >= threshold for other in kept_grams):
                dropped.add(index)
                continue
            seen.add(key)
            kept_grams.append(grams)
    return dropped
