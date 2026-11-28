import json

import pytest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.finetune import decontam
from rag_eval.finetune.decontam import (
    golden_overlap,
    golden_test_document_ids,
    golden_test_documents,
    load_golden_questions,
)
from rag_eval.golden_io import load_golden
from rag_eval.paths import REPO_ROOT

FIXTURE_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"
DOC_ID = "00000000-0000-4000-8000-0000000000d1"


def _item(**overrides) -> GoldenItem:
    base = json.loads(FIXTURE_GOLDEN.read_text(encoding="utf-8").splitlines()[0])
    base.update(overrides)
    return GoldenItem.model_validate(base)


def _span(document: str, document_id: str | None = None) -> dict:
    span = {"document": document, "section": "Section", "quote": "a neutral quote"}
    if document_id:
        span["document_id"] = document_id
    return span


def test_overlap_matches_case_and_punctuation_variants():
    golden = ["what is the warranty period"]
    assert golden_overlap("What is the warranty period?", golden) is True
    assert golden_overlap("How do I configure the export schedule?", golden) is False


def test_overlap_works_on_chinese_without_spaces():
    golden = ["退货期限是多少天"]
    assert golden_overlap("退货期限是多少天？", golden) is True
    assert golden_overlap("退货 期限 是 多少 天", golden) is True
    assert golden_overlap("如何更改账户的显示语言", golden) is False


def test_overlap_threshold_is_jaccard_0_8_on_character_trigrams():
    golden = ["abcdefghij"]
    # 8 trigrams; one changed end character keeps 7 of 9 in the union: 0.778 < 0.8
    assert golden_overlap("abcdefghiX", golden) is False
    assert golden_overlap("abcdefghij", golden) is True
    assert golden_overlap("abcdefghiX", golden, threshold=0.7) is True


def test_load_golden_questions_reads_the_fixture_and_the_private_file(tmp_path):
    fixture_questions = load_golden_questions([FIXTURE_GOLDEN])
    assert len(fixture_questions) == len(load_golden(FIXTURE_GOLDEN))
    private = tmp_path / "golden.jsonl"
    private.write_text(
        json.dumps(_item(id="en-ambiguous-901", question="A private neutral question about item seven").model_dump(mode="json"))
        + "\n",
        encoding="utf-8",
    )
    both = load_golden_questions([FIXTURE_GOLDEN, private])
    assert "A private neutral question about item seven" in both
    assert len(both) == len(fixture_questions) + 1


def test_default_golden_paths_include_the_private_file_only_when_present(tmp_path, monkeypatch):
    monkeypatch.setattr(decontam, "PRIVATE_GOLDEN_PATH", tmp_path / "missing.jsonl")
    assert decontam.default_golden_paths() == [FIXTURE_GOLDEN]
    present = tmp_path / "golden.jsonl"
    present.write_text("", encoding="utf-8")
    monkeypatch.setattr(decontam, "PRIVATE_GOLDEN_PATH", present)
    assert decontam.default_golden_paths() == [FIXTURE_GOLDEN, present]


def test_overlap_default_uses_every_fixture_golden_question():
    question = load_golden(FIXTURE_GOLDEN)[0].question
    assert golden_overlap(question.upper() + " ") is True


def test_golden_test_documents_returns_evidence_names_of_test_items_only():
    items = [
        _item(id="en-ambiguous-801", split="test", gold_evidence=[_span("alpha.en.md"), _span("beta.en.md", DOC_ID)]),
        _item(id="en-ambiguous-802", split="dev", gold_evidence=[_span("gamma.en.md")]),
    ]
    assert golden_test_documents(items) == {"alpha.en.md", "beta.en.md"}
    assert golden_test_document_ids(items) == {DOC_ID}


def test_golden_test_documents_on_the_fixture_set_covers_every_test_item():
    items = load_golden(FIXTURE_GOLDEN)
    names = golden_test_documents(items)
    for item in items:
        if item.split == "test":
            assert {span.document for span in item.gold_evidence} <= names
    assert names


def test_overlap_refuses_an_out_of_range_threshold():
    with pytest.raises(ValueError):
        golden_overlap("x", ["x"], threshold=1.5)
