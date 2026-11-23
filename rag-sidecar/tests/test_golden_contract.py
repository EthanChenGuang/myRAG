import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import GoldenItem, GoldSpan

CATEGORIES = ["multi_turn", "compound", "exact_term", "table", "scanned", "no_answer", "general"]


def _span(**overrides):
    base = {"document": "handbook.md", "section": "Leave policy", "quote": "twenty days"}
    base.update(overrides)
    return base


def _item(category: str = "general", **overrides):
    if category == "no_answer":
        base = {
            "id": "en-no-answer-001",
            "question": "What is the CEO's favourite colour?",
            "conversation": [],
            "language": "en",
            "category": "no_answer",
            "answerable": False,
            "expected_answer": None,
            "gold_evidence": [],
            "review_status": "approved",
            "provenance": "synthetic_fixture",
            "split": "dev",
        }
    else:
        base = {
            "id": f"en-{category.replace('_', '-')}-001",
            "question": "How many leave days do employees get?",
            "conversation": [],
            "language": "en",
            "category": category,
            "answerable": True,
            "expected_answer": "Twenty days per year.",
            "gold_evidence": [_span()],
            "review_status": "approved",
            "provenance": "synthetic_fixture",
            "split": "dev",
        }
        if category == "multi_turn":
            base["conversation"] = [
                {"role": "user", "content": "Tell me about leave."},
                {"role": "assistant", "content": "Which kind of leave?"},
            ]
    base.update(overrides)
    return base


@pytest.mark.parametrize("category", CATEGORIES)
def test_valid_item_for_each_category(category):
    item = GoldenItem.model_validate(_item(category))
    assert item.category == category


def test_rejects_chunk_id_on_item():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(chunk_id="abc"))


def test_rejects_chunk_ids_on_item():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(chunk_ids=["abc"]))


def test_rejects_chunk_id_on_span():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(gold_evidence=[_span(chunk_id="abc")]))
    with pytest.raises(ValidationError):
        GoldSpan.model_validate(_span(chunk_ids=["abc"]))


@pytest.mark.parametrize(
    "field,value",
    [
        ("language", "fr"),
        ("category", "summary"),
        ("review_status", "pending"),
        ("provenance", "gpt_draft"),
        ("split", "validation"),
    ],
)
def test_rejects_unknown_enum_values(field, value):
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(**{field: value}))


def test_no_answer_marked_answerable_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("no_answer", answerable=True))


def test_answerable_flag_false_with_non_no_answer_category_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("general", answerable=False, gold_evidence=[], expected_answer=None))


def test_answerable_without_spans_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(gold_evidence=[]))


@pytest.mark.parametrize("answer", [None, "", "   "])
def test_answerable_without_expected_answer_fails(answer):
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(expected_answer=answer))


def test_no_answer_with_spans_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("no_answer", gold_evidence=[_span()]))


def test_multi_turn_without_conversation_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("multi_turn", conversation=[]))


def test_one_character_quote_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(gold_evidence=[_span(quote="x")]))


def test_two_character_quote_is_valid():
    GoldenItem.model_validate(_item("exact_term", gold_evidence=[_span(quote="x1")]))


def test_identical_spans_fail():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(gold_evidence=[_span(), _span()]))


def test_distinct_spans_are_valid():
    GoldenItem.model_validate(
        _item("compound", gold_evidence=[_span(), _span(quote="thirty days")])
    )


@pytest.mark.parametrize("bad_id", ["A b", "ab", "-abc", "ABC-001", "a" * 65])
def test_rejects_bad_ids(bad_id):
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(id=bad_id))


def test_item_is_frozen():
    item = GoldenItem.model_validate(_item())
    with pytest.raises(ValidationError):
        item.split = "test"
