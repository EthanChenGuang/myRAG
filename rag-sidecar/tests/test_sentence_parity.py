"""Sentence-splitter parity with src/lib/rag/lang/sentences.ts via sentence-cases.json (Phase 3.2 D-55, plan 23)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

tiktoken = pytest.importorskip("tiktoken")

from rag_sidecar.parse.sentences import (  # noqa: E402
    LEGACY_SPLITTER,
    count_tokens,
    split_sentences,
    splitter_for,
)

_ROOT = Path(__file__).resolve().parents[2]
_CASES_PATH = _ROOT / "tests" / "fixtures" / "lang" / "sentence-cases.json"
_CASES = json.loads(_CASES_PATH.read_text(encoding="utf-8"))["cases"]


def test_the_shared_case_file_holds_the_edge_cases():
    names = {case["name"] for case in _CASES}
    for required in (
        "zh_consecutive_ends",
        "zh_closing_quote",
        "en_closing_bracket",
        "empty",
        "zh_no_sentence_end",
        "zh_surrogate_pairs_hard_split",
        "en_combining_marks_hard_split",
        "zh_ascii_full_stop_inside",
        "it_accented_vowels_packed",
    ):
        assert required in names


@pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
def test_python_matches_the_shared_case(case: dict) -> None:
    segments = split_sentences(case["text"], case["language"], case["budget_tokens"])
    assert segments == case["expect_segments"]
    if case["budget_tokens"] is not None:
        for segment in segments:
            assert count_tokens(segment) <= case["budget_tokens"]


def test_sentence_ends_come_from_the_registry_and_semicolons_never_end_a_sentence():
    assert splitter_for("zh").split("甲句；仍在甲句。乙句！丙句？") == ["甲句；仍在甲句。", "乙句！", "丙句？"]
    assert splitter_for("en").split("One; still one. Two! Three? Four") == ["One; still one.", "Two!", "Three?", "Four"]
    assert splitter_for("it").split("Uno; ancora uno. Due! Tre?") == ["Uno; ancora uno.", "Due!", "Tre?"]


def test_joiners_follow_the_script():
    assert splitter_for("zh").join("甲句") == ""
    assert splitter_for("en").join("One") == " "
    assert splitter_for("it").join("Uno") == " "


def test_an_unknown_code_gets_the_legacy_splitter():
    assert splitter_for("xx") is LEGACY_SPLITTER
    assert LEGACY_SPLITTER.split("One; two. 三。四") == ["One;", "two.", "三。", "四"]
    assert LEGACY_SPLITTER.join("三。") == ""
    assert LEGACY_SPLITTER.join("two.") == " "


def test_a_long_text_without_sentence_ends_is_hard_split_within_the_budget():
    text = "词" * 4000
    segments = split_sentences(text, "zh", 50)
    assert "".join(segments) == text
    assert all(count_tokens(segment) <= 50 for segment in segments)
