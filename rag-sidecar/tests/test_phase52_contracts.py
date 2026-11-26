import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.answer_checks import (
    AnswerChecks,
    AnswerNotice,
    AnswerSentence,
    BlockedRange,
    ClaimsSummary,
    OutputGuardSummary,
    VersionConflict,
)
from rag_sidecar.contracts.answers import AnswerRecord, CitationRecord

HASH = "b" * 64


def _sentence(**overrides):
    base = {
        "index": 0,
        "part": 0,
        "start": 0,
        "end": 12,
        "kind": "sentence",
        "text_hash": HASH,
        "factual": True,
        "cited": True,
        "support": "supported",
        "scorer": "hhem_2_1_open",
    }
    base.update(overrides)
    return base


def _citation(**overrides):
    base = {
        "n": 1,
        "alias": "S1",
        "chunkIds": ["chunk-1"],
        "documentId": "doc-1",
        "documentName": "document-a.pdf",
        "quote": "A neutral sentence.",
        "quoteHash": HASH,
        "strategy": "chunk-alias",
    }
    base.update(overrides)
    return base


def _record(**overrides):
    base = {
        "answerId": "00000000-0000-4000-8000-0000000000a1",
        "traceId": "trace-1",
        "modelId": "generator/model-a",
        "ragMode": "strict",
        "groundedness": {"status": "pending"},
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }
    base.update(overrides)
    return base


def test_checks_empty_object_validates_with_defaults():
    checks = AnswerChecks.model_validate({})
    assert checks.sentences == []
    assert checks.output_guard is None
    assert checks.version_conflict is None
    assert checks.claims is None
    assert checks.truncated is False
    assert checks.finish_reason is None
    assert checks.text_language is None


def test_checks_sentence_accepts_a_scored_record():
    sentence = AnswerSentence.model_validate(_sentence())
    assert sentence.part == 0 and sentence.support == "supported"


@pytest.mark.parametrize(
    "overrides",
    [
        {"start": 10, "end": 4},
        {"start": -1},
        {"end": -2},
        {"part": -1},
        {"kind": "paragraph"},
        {"text_hash": "B" * 64},
        {"text_hash": "b" * 63},
        {"support": "unsupported", "scorer": None},
        {"support": "supported", "scorer": "none"},
        {"support": "not_checked", "scorer": None, "reason": None},
        {"extra_field": 1},
    ],
)
def test_checks_sentence_rejects_invalid_records(overrides):
    with pytest.raises(ValidationError):
        AnswerSentence.model_validate(_sentence(**overrides))


def test_checks_sentence_defaults_to_not_checked_with_reason():
    sentence = AnswerSentence.model_validate(
        _sentence(support="not_checked", scorer=None, reason="too_many") | {}
    )
    assert sentence.reason == "too_many"
    raw = _sentence(scorer=None, reason="claim_check_off")
    del raw["support"]
    assert AnswerSentence.model_validate(raw).support == "not_checked"


def test_checks_output_guard_rules():
    summary = OutputGuardSummary.model_validate(
        {
            "mode": "enforce",
            "rules_version": "1",
            "links_checked": 2,
            "links_removed": 1,
            "blocked_ranges": [{"part": 0, "start": 3, "end": 9, "text_hash": HASH}],
        }
    )
    assert summary.credential_blocked == 0 and summary.rule_ids == []
    with pytest.raises(ValidationError):
        OutputGuardSummary.model_validate({"mode": "off", "rules_version": "1"})
    with pytest.raises(ValidationError):
        OutputGuardSummary.model_validate({"mode": "flag", "rules_version": "1", "links_removed": -1})
    with pytest.raises(ValidationError):
        BlockedRange.model_validate({"part": 0, "start": 9, "end": 3, "text_hash": HASH})
    with pytest.raises(ValidationError):
        BlockedRange.model_validate({"part": 0, "start": 0, "end": 3, "text_hash": "x"})


def test_checks_version_conflict_rules():
    conflict = VersionConflict.model_validate(
        {"document_ids": ["doc-1", "doc-2"], "latest_document_id": "doc-2", "group_rule": "title_match"}
    )
    assert conflict.mixed_versions is False
    for bad in [
        {"document_ids": ["doc-1"], "latest_document_id": "doc-1", "group_rule": "title_match"},
        {"document_ids": ["doc-1", "doc-1"], "latest_document_id": "doc-1", "group_rule": "title_match"},
        {"document_ids": ["doc-1", "doc-2"], "latest_document_id": "doc-3", "group_rule": "title_match"},
        {"document_ids": ["doc-1", "doc-2"], "latest_document_id": "doc-2", "group_rule": "filename"},
    ]:
        with pytest.raises(ValidationError):
            VersionConflict.model_validate(bad)


def test_checks_notice_kind_is_an_open_reason_code():
    for kind in ["uncited", "credential_request_blocked", "calc_corrected", "calc_not_verified"]:
        assert AnswerNotice.model_validate({"kind": kind, "text": "A notice.", "language": "en"}).kind == kind
    with pytest.raises(ValidationError):
        AnswerNotice.model_validate({"kind": "Not-A-Code", "text": "A notice.", "language": "en"})


def test_checks_claims_summary_counts():
    summary = ClaimsSummary.model_validate(
        {"total": 3, "unsupported": 1, "not_checked": 1, "reasons": {"too_many": 1}, "scorer": "hhem_2_1_open"}
    )
    assert summary.judge_version is None
    with pytest.raises(ValidationError):
        ClaimsSummary.model_validate({"total": 1, "unsupported": 1, "not_checked": 1})
    with pytest.raises(ValidationError):
        ClaimsSummary.model_validate({"total": 1, "reasons": {"too_many": -1}})


def test_checks_sentence_indexes_are_unique():
    with pytest.raises(ValidationError):
        AnswerChecks.model_validate({"sentences": [_sentence(), _sentence()]})


def test_record_without_new_fields_still_validates():
    record = AnswerRecord.model_validate(_record())
    assert record.checks == AnswerChecks()
    assert record.textsSource is None
    dumped = record.model_dump(mode="json")
    assert "checks" not in dumped and "textsSource" not in dumped


def test_record_with_checks_and_texts_source():
    record = AnswerRecord.model_validate(
        _record(checks={"sentences": [_sentence()], "truncated": True, "finish_reason": "length"}, textsSource="registry")
    )
    assert record.checks.truncated is True
    dumped = record.model_dump(mode="json")
    assert dumped["textsSource"] == "registry" and dumped["checks"]["sentences"][0]["part"] == 0
    with pytest.raises(ValidationError):
        AnswerRecord.model_validate(_record(textsSource="other"))


def test_citation_with_and_without_version_fields():
    plain = CitationRecord.model_validate(_citation())
    assert plain.versionLabel is None
    assert "versionLabel" not in plain.model_dump(mode="json")
    labelled = CitationRecord.model_validate(_citation(versionLabel="v2", effectiveFrom="2025-03-01"))
    assert labelled.model_dump(mode="json")["versionLabel"] == "v2"
    assert labelled.model_dump(mode="json")["effectiveFrom"] == "2025-03-01"
    for bad in [{"effectiveFrom": "03/01/2025"}, {"effectiveFrom": "2025-13-01"}, {"versionLabel": "x" * 41}]:
        with pytest.raises(ValidationError):
            CitationRecord.model_validate(_citation(**bad))
