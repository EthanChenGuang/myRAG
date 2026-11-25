import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import (
    DraftedItemBatch,
    DraftedItemProposal,
    GoldenItem,
    GoldenSplitManifest,
    GoldSpan,
)
from rag_sidecar.export_schemas import CONTRACTS

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


SPLIT_RULE = "sha256-first8hex-mod100-lt70-dev"


def _proposal(**overrides):
    base = {
        "question": "How many leave days do employees get?",
        "language": "en",
        "category": "general",
        "answerable": True,
        "expected_answer": "Twenty days per year.",
        "gold_evidence": [_span()],
    }
    base.update(overrides)
    return base


def test_split_manifest_valid_and_defaults():
    manifest = GoldenSplitManifest.model_validate(
        {"rule": SPLIT_RULE, "assignments": {"en-general-001": "dev", "en-general-002": "test"}}
    )
    assert manifest.schema_version == 1
    assert manifest.assignments["en-general-002"] == "test"


def test_split_manifest_rejects_other_split_value():
    with pytest.raises(ValidationError):
        GoldenSplitManifest.model_validate({"rule": SPLIT_RULE, "assignments": {"x": "validation"}})


def test_split_manifest_rejects_other_rule_name():
    with pytest.raises(ValidationError):
        GoldenSplitManifest.model_validate({"rule": "sha256-mod10", "assignments": {}})


def test_split_manifest_rejects_unknown_key():
    with pytest.raises(ValidationError):
        GoldenSplitManifest.model_validate({"rule": SPLIT_RULE, "assignments": {}, "extra": 1})


def test_drafted_proposal_valid():
    proposal = DraftedItemProposal.model_validate(_proposal())
    assert proposal.conversation == []


@pytest.mark.parametrize("key,value", [("id", "en-general-001"), ("review_status", "draft"), ("split", "dev")])
def test_drafted_proposal_rejects_assigned_fields(key, value):
    with pytest.raises(ValidationError):
        DraftedItemProposal.model_validate(_proposal(**{key: value}))


def test_drafted_proposal_has_no_assigned_fields():
    for key in ("id", "review_status", "split", "provenance"):
        assert key not in DraftedItemProposal.model_fields


def test_drafted_batch_wraps_proposals():
    batch = DraftedItemBatch.model_validate({"items": [_proposal(), _proposal(question="Another?")]})
    assert len(batch.items) == 2


def test_drafted_batch_rejects_chunk_id_in_span():
    with pytest.raises(ValidationError):
        DraftedItemBatch.model_validate({"items": [_proposal(gold_evidence=[_span(chunk_id="x")])]})


def test_golden_contracts_registered_in_serialization_mode():
    registered = {model.__name__: mode for model, mode in CONTRACTS}
    for name in ("GoldenItem", "GoldenSplitManifest", "DraftedItemBatch"):
        assert registered[name] == "serialization"


def test_golden_item_schema_forbids_additional_properties():
    schema = GoldenItem.model_json_schema(mode="serialization")
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["GoldSpan"]["additionalProperties"] is False


@pytest.mark.parametrize("category", ["colloquial", "ambiguous", "typo"])
def test_user_phrasing_categories_validate(category):
    item = GoldenItem(**_item(category))
    assert item.category == category


def test_production_provenance_validates():
    assert GoldenItem(**_item("typo", provenance="production")).provenance == "production"


def test_unknown_category_slang_rejected():
    with pytest.raises(ValidationError):
        GoldenItem(**{**_item("general"), "category": "slang"})


def test_unknown_provenance_rejected():
    with pytest.raises(ValidationError):
        GoldenItem(**_item("general", provenance="crowd"))


def _cross_lingual(**overrides):
    base = _item(
        "cross_lingual",
        id="xl-en-zh-01",
        question="How many days of annual leave does a new employee get?",
        language="en",
        evidence_language="zh",
    )
    base.update(overrides)
    return base


def test_cross_lingual_item_with_a_different_evidence_language_validates():
    item = GoldenItem.model_validate(_cross_lingual())
    assert item.category == "cross_lingual"
    assert item.language == "en"
    assert item.evidence_language == "zh"


def test_cross_lingual_item_without_evidence_language_fails():
    with pytest.raises(ValidationError, match="cross_lingual items need an evidence_language"):
        GoldenItem.model_validate(_cross_lingual(evidence_language=None))


def test_cross_lingual_item_with_evidence_language_equal_to_question_language_fails():
    with pytest.raises(ValidationError, match="evidence_language must differ from the question language"):
        GoldenItem.model_validate(_cross_lingual(evidence_language="en"))


@pytest.mark.parametrize("evidence_language", [None, "en"])
def test_evidence_language_on_other_categories_must_be_null_or_the_question_language(evidence_language):
    item = GoldenItem.model_validate(_item("general", evidence_language=evidence_language))
    assert item.evidence_language == evidence_language


def test_evidence_language_on_another_category_in_a_different_language_fails():
    with pytest.raises(ValidationError, match="evidence_language must equal the question language"):
        GoldenItem.model_validate(_item("general", evidence_language="zh"))


def test_evidence_language_defaults_to_none():
    assert GoldenItem.model_validate(_item("general")).evidence_language is None


def test_evidence_language_rejects_unknown_language():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_cross_lingual(evidence_language="fr"))


def test_drafted_batch_accepts_the_cross_lingual_category():
    proposal = _proposal(category="cross_lingual", language="en", evidence_language="zh")
    batch = DraftedItemBatch.model_validate({"items": [proposal]})
    assert batch.items[0].category == "cross_lingual"
    assert batch.items[0].evidence_language == "zh"


GOLDEN_FIXTURE = Path(__file__).resolve().parents[2] / "eval" / "fixtures" / "golden.jsonl"


def _small_talk(**overrides):
    base = {
        "id": "en-small-talk-001",
        "question": "Hello there, thanks!",
        "conversation": [],
        "language": "en",
        "category": "small_talk",
        "answerable": False,
        "expected_answer": None,
        "gold_evidence": [],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize("category", ["cache_paraphrase", "cache_near_miss"])
def test_cache_pair_items_need_pair_of(category):
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(category))
    item = GoldenItem.model_validate(_item(category, pair_of="en-general-001"))
    assert item.pair_of == "en-general-001"
    assert item.category == category


@pytest.mark.parametrize("pair_of", ["Bad Id", "ab", "-x-y"])
def test_pair_of_uses_the_item_id_pattern(pair_of):
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("cache_paraphrase", pair_of=pair_of))


def test_pair_of_cannot_point_at_the_item_itself():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("cache_paraphrase", pair_of="en-cache-paraphrase-001"))


@pytest.mark.parametrize("category", ["general", "no_answer", "multi_turn", "cross_lingual"])
def test_pair_of_on_other_categories_fails(category):
    overrides = {"pair_of": "en-general-002"}
    if category == "cross_lingual":
        overrides["evidence_language"] = "zh"
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item(category, **overrides))


def test_pair_of_defaults_to_none():
    assert GoldenItem.model_validate(_item()).pair_of is None


def test_small_talk_is_not_answerable_and_has_no_evidence():
    item = GoldenItem.model_validate(_small_talk())
    assert item.answerable is False
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_small_talk(answerable=True, expected_answer="Hi!", gold_evidence=[_span()]))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_small_talk(gold_evidence=[_span()]))


def test_no_answer_still_requires_answerable_false():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("no_answer", answerable=True, expected_answer="x", gold_evidence=[_span()]))
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_item("general", answerable=False, expected_answer=None, gold_evidence=[]))


def test_drafted_batch_accepts_the_cache_and_small_talk_categories():
    proposal = DraftedItemProposal.model_validate(
        {"question": "Hi", "language": "en", "category": "small_talk", "answerable": False}
    )
    assert proposal.category == "small_talk"


def test_every_fixture_golden_item_still_validates():
    lines = [line for line in GOLDEN_FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert lines
    for line in lines:
        GoldenItem.model_validate(json.loads(line))


# --- Phase 3.2 golden additions (plan 03.2-06, D-45) ---------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_GOLDEN_FILES = [
    _REPO_ROOT / "eval" / "fixtures" / "golden.jsonl",
    _REPO_ROOT / "eval" / "fixtures" / "ingest" / "golden-ingest.jsonl",
]


_PRE_PHASE32_ITEM_KEYS = {
    "id", "question", "conversation", "language", "category", "answerable", "expected_answer", "gold_evidence",
    "evidence_language", "review_status", "provenance", "split", "retrieval_filters", "tags", "attack", "pair_of",
}
_PRE_PHASE32_FILTER_KEYS = {
    "date_range", "sources", "document_ids", "doc_types", "languages", "invoice", "current_only",
}


def _golden_lines() -> list[tuple[str, int, str]]:
    lines = []
    for path in _GOLDEN_FILES:
        for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
            if line.strip():
                lines.append((path.name, number, line))
    return lines


def test_every_committed_golden_line_still_validates_and_dumps_without_new_keys():
    lines = _golden_lines()
    assert len(lines) >= 192
    for name, number, line in lines:
        item = GoldenItem.model_validate_json(line)
        dumped = item.model_dump(mode="json")
        assert "table_answer" not in dumped, f"{name}:{number}"
        assert "native_review" not in dumped, f"{name}:{number}"
        assert set(dumped) == _PRE_PHASE32_ITEM_KEYS, f"{name}:{number}"
        if dumped["retrieval_filters"] is not None:
            assert set(dumped["retrieval_filters"]) == _PRE_PHASE32_FILTER_KEYS, f"{name}:{number}"
        assert GoldenItem.model_validate(dumped) == item, f"{name}:{number}"


def _table_item(**overrides):
    base = _item(
        "general",
        id="en-table-split-001",
        question="Which value does the synthetic table list in column B for row key K-17?",
        expected_answer="Column B lists 418 for row key K-17.",
        gold_evidence=[_span(document="synthetic-table.en.pdf", section="Table 1", quote="K-17 | 205 | 418")],
    )
    base.update({"category": "table_split", "table_answer": {"value": "418", "column": "B", "distractor_values": ["205"]}})
    base.update(overrides)
    return base


def test_table_split_item_with_table_answer_validates():
    item = GoldenItem.model_validate(_table_item())
    dumped = item.model_dump(mode="json")
    assert dumped["category"] == "table_split"
    assert dumped["table_answer"] == {"value": "418", "column": "B", "distractor_values": ["205"]}


def test_table_split_item_without_table_answer_fails():
    item = _table_item()
    del item["table_answer"]
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(item)


def test_table_answer_outside_table_split_fails():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_table_item(category="table"))


def test_table_answer_rejects_distractor_equal_to_value_and_empty_fields():
    for table_answer in (
        {"value": "418", "column": "B", "distractor_values": ["418"]},
        {"value": "", "column": "B", "distractor_values": []},
        {"value": "418", "column": "", "distractor_values": []},
        {"value": "418", "column": "B", "distractor_values": ["205", "205"]},
    ):
        with pytest.raises(ValidationError):
            GoldenItem.model_validate(_table_item(table_answer=table_answer))


def test_native_review_pending_and_approved():
    pending = {"origin": "llm_drafted", "status": "pending", "reviewer": None, "reviewed_at": None}
    item = GoldenItem.model_validate(_table_item(native_review=pending))
    assert item.model_dump(mode="json")["native_review"] == pending
    approved = {"origin": "machine_translated", "status": "approved", "reviewer": "reviewer-01", "reviewed_at": "2026-01-02T00:00:00Z"}
    assert GoldenItem.model_validate(_item("general", native_review=approved)).native_review is not None
    assert GoldenItem.model_validate(_item("general", native_review={**approved, "origin": "native"})).native_review


def test_native_review_approved_without_reviewer_fails():
    for missing in ("reviewer", "reviewed_at"):
        review = {"origin": "llm_drafted", "status": "approved", "reviewer": "reviewer-01", "reviewed_at": "2026-01-02T00:00:00Z"}
        review[missing] = None
        with pytest.raises(ValidationError):
            GoldenItem.model_validate(_item("general", native_review=review))


def test_native_review_rejects_unknown_values():
    for review in (
        {"origin": "human", "status": "pending"},
        {"origin": "native", "status": "rejected"},
        {"origin": "native", "status": "pending", "note": "x"},
    ):
        with pytest.raises(ValidationError):
            GoldenItem.model_validate(_item("general", native_review=review))


def test_provenance_is_unchanged_for_new_items():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(_table_item(provenance="llm_drafted"))
