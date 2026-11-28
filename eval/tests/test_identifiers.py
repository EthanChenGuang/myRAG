import json
from pathlib import Path

import pytest

from rag_eval.identifiers import damerau_levenshtein, is_near_miss, normalize_identifier

VECTORS_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "identifiers" / "near-miss-vectors.json"
CASES = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))["cases"]


def test_vector_file_has_cases():
    assert len(CASES) >= 30


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_python_twin_matches_the_shared_vectors(case):
    asked = normalize_identifier(case["asked"])
    other = normalize_identifier(case["other"])
    assert (asked, other) == (case["asked_norm"], case["other_norm"]), case["id"]
    assert damerau_levenshtein(asked, other) == case["distance"], case["id"]
    assert is_near_miss(asked, other) is case["near_miss"], case["id"]


def test_whitespace_class_matches_the_javascript_one():
    assert normalize_identifier("Q X -﻿4　471") == "qx4471"
    assert normalize_identifier("QX\u001c4471") == "qx\u001c4471"


def test_bounded_distance_stops_above_the_limit():
    assert damerau_levenshtein("qx4471", "lm9902", 1) == 2
    assert damerau_levenshtein("ab", "ba", 1) == 1
