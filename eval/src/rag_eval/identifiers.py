"""Python twin of src/lib/rag/ids/normalize.ts (D-28, D-31); tests/fixtures/identifiers/near-miss-vectors.json is the
shared oracle of both implementations."""

import re
import unicodedata

# JavaScript `\s` (WhiteSpace and LineTerminator), not Python's str.isspace, plus - _ . /
_SEPARATORS = re.compile(
    "[\t\n\u000b\u000c\r    -     　﻿\\-_./]"
)
SHORT_FORM_MAX = 6


def normalize_identifier(raw: str) -> str:
    """NFKC, then lower case (String.prototype.toLowerCase, not full case folding), then separators removed."""
    return _SEPARATORS.sub("", unicodedata.normalize("NFKC", raw).lower())


def damerau_levenshtein(a: str, b: str, limit: int | None = None) -> int:
    """Restricted Damerau-Levenshtein (optimal string alignment) over code points; with `limit`, returns limit + 1
    as soon as the distance is known to exceed it."""
    bound = float("inf") if limit is None else max(0, limit)
    if abs(len(a) - len(b)) > bound:
        return int(bound) + 1
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev2: list[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        row_min = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            value = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                value = min(value, prev2[j - 2] + 1)
            row[j] = value
            row_min = min(row_min, value)
        if row_min > bound:
            return int(bound) + 1
        prev2, prev = prev, row
    distance = prev[len(b)]
    return int(bound) + 1 if distance > bound else distance


def is_near_miss(asked_norm: str, other_norm: str) -> bool:
    """D-31: at most 1 edit for asked forms of up to 6 code points, at most 2 above; equal forms are not near-misses."""
    if not asked_norm or asked_norm == other_norm:
        return False
    limit = 1 if len(asked_norm) <= SHORT_FORM_MAX else 2
    return damerau_levenshtein(asked_norm, other_norm, limit) <= limit
