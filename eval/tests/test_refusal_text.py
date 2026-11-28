import json

import pytest

from rag_eval.refusal_text import REFUSAL_TEXTS_PATH, is_refusal_answer, load_refusal_texts

FAKE_GENERATOR_REFUSAL = "The provided documents do not contain this information."


def test_fixture_file_holds_one_text_per_fixture_language_and_the_fake_generator_text():
    raw = json.loads(REFUSAL_TEXTS_PATH.read_text(encoding="utf-8"))
    assert sorted(raw) == ["en", "it", "zh"]
    assert FAKE_GENERATOR_REFUSAL in load_refusal_texts()["en"]
    assert all(texts and all(t.strip() for t in texts) for texts in load_refusal_texts().values())


@pytest.mark.parametrize(
    "answer",
    [FAKE_GENERATOR_REFUSAL, FAKE_GENERATOR_REFUSAL.upper(), f"\n  {FAKE_GENERATOR_REFUSAL}  ", FAKE_GENERATOR_REFUSAL[:-1]],
)
def test_whole_answer_match_after_normalisation(answer: str):
    assert is_refusal_answer(answer, "en") is True


@pytest.mark.parametrize(
    "answer",
    [None, "", "   ", f"Section two answers it. {FAKE_GENERATOR_REFUSAL}", f"{FAKE_GENERATOR_REFUSAL} See section two."],
)
def test_none_empty_and_embedded_refusals_are_not_refusals(answer: str | None):
    assert is_refusal_answer(answer, "en") is False


def test_match_is_per_language():
    zh = load_refusal_texts()["zh"][0]
    assert is_refusal_answer(zh, "zh") is True
    assert is_refusal_answer(zh, "it") is False
    assert is_refusal_answer(FAKE_GENERATOR_REFUSAL, "zh") is False


def test_unknown_language_has_no_refusal_text():
    assert is_refusal_answer(FAKE_GENERATOR_REFUSAL, "fr") is False
