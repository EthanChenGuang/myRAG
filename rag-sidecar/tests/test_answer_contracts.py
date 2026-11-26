import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.answers import (
    AnswerFeedback,
    AnswerFeedbackRequest,
    AnswerGroundedness,
    AnswerRecord,
    CitationRecord,
)
from rag_sidecar.contracts.groundedness import (
    GroundednessRequest,
    GroundednessResult,
    GroundednessThresholds,
)

HASH = "a" * 64


def _citation(**overrides):
    base = {
        "n": 1,
        "alias": "S1",
        "chunkIds": ["c-1", "c-2"],
        "documentId": "d-1",
        "documentName": "report.pdf",
        "documentVersion": 2,
        "page": 4,
        "sectionPath": ["Terms", "Payment"],
        "quote": "text",
        "quoteHash": HASH,
        "strategy": "chunk-alias",
    }
    base.update(overrides)
    return base


def test_citation_record_accepts_the_d01_shape():
    record = CitationRecord.model_validate(_citation())
    assert record.model_dump(mode="json") == _citation()


def test_citation_record_accepts_empty_chunk_ids_and_absent_optionals():
    CitationRecord.model_validate(_citation(chunkIds=[]))
    base = _citation()
    for key in ("page", "sectionPath", "documentVersion"):
        base.pop(key)
    record = CitationRecord.model_validate(base)
    assert record.page is None and record.sectionPath is None and record.documentVersion is None
    CitationRecord.model_validate(_citation(page=None, sectionPath=None, documentVersion=None))
    CitationRecord.model_validate(_citation(alias="S12", strategy="claude-citations"))


def test_citation_record_field_names_are_exactly_d01():
    assert set(CitationRecord.model_fields) == {
        "n",
        "alias",
        "chunkIds",
        "documentId",
        "documentName",
        "documentVersion",
        "page",
        "sectionPath",
        "quote",
        "quoteHash",
        "strategy",
        "isCurrent",
        "effectiveFrom",
        "effectiveTo",
        "alsoIn",
    }


@pytest.mark.parametrize(
    "overrides",
    [
        {"alias": "S0"},
        {"alias": "S01"},
        {"alias": "s1"},
        {"alias": "X1"},
        {"n": 0},
        {"quoteHash": "a" * 63},
        {"quoteHash": "A" * 64},
        {"strategy": "claude_citations"},
        {"quote": ""},
        {"unexpected": 1},
    ],
)
def test_citation_record_rejects(overrides):
    with pytest.raises(ValidationError):
        CitationRecord.model_validate(_citation(**overrides))


def _request(**overrides):
    base = {
        "request_id": "req-1",
        "language": "en",
        "premise_texts": ["Employees receive twenty days of leave."],
        "hypothesis": "Employees get twenty days.",
        "allow_vectara": False,
    }
    base.update(overrides)
    return base


def test_groundedness_request_accepts_the_d11_shape():
    request = GroundednessRequest.model_validate(_request())
    assert request.model_dump(mode="json") == _request()
    assert set(GroundednessRequest.model_fields) == {
        "request_id",
        "language",
        "premise_texts",
        "hypothesis",
        "allow_vectara",
    }


@pytest.mark.parametrize(
    "overrides",
    [
        {"premise_texts": []},
        {"premise_texts": [""]},
        {"hypothesis": ""},
        {"language": ""},
        {"unexpected": 1},
    ],
)
def test_groundedness_request_rejects(overrides):
    with pytest.raises(ValidationError):
        GroundednessRequest.model_validate(_request(**overrides))


def test_groundedness_request_requires_allow_vectara():
    base = _request()
    base.pop("allow_vectara")
    with pytest.raises(ValidationError):
        GroundednessRequest.model_validate(base)


def test_groundedness_result_scored_and_not_checked():
    scored = GroundednessResult.model_validate(
        {"status": "scored", "scorer": "hhem_2_1_open", "score": 0.73, "latency_ms": 120}
    )
    assert scored.truncated is False and scored.reason is None
    not_checked = GroundednessResult.model_validate(
        {"status": "not_checked", "scorer": "none", "reason": "unsupported_language", "latency_ms": 0}
    )
    assert not_checked.score is None
    assert set(GroundednessResult.model_fields) == {
        "status",
        "scorer",
        "score",
        "reason",
        "truncated",
        "latency_ms",
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "scored", "scorer": "hhem_2_1_open", "latency_ms": 1},
        {"status": "scored", "scorer": "hhem_2_1_open", "score": 1.2, "latency_ms": 1},
        {"status": "scored", "scorer": "none", "score": 0.5, "latency_ms": 1},
        {"status": "not_checked", "scorer": "none", "score": 0.5, "reason": "timeout", "latency_ms": 1},
        {"status": "not_checked", "scorer": "none", "latency_ms": 1},
        {"status": "scored", "scorer": "hhem_2_1_open", "score": 0.5, "latency_ms": -1},
        {"status": "scored", "scorer": "hhem_2_1_open", "score": 0.5, "latency_ms": 1, "extra": 1},
    ],
)
def test_groundedness_result_rejects(payload):
    with pytest.raises(ValidationError):
        GroundednessResult.model_validate(payload)


def _cell(**overrides):
    base = {"scorer": "hhem_2_1_open", "language": "en", "threshold": 0.5, "source": "default"}
    base.update(overrides)
    return base


def test_groundedness_thresholds_accepts_distinct_cells():
    thresholds = GroundednessThresholds.model_validate(
        {
            "schema_version": 1,
            "cells": [
                _cell(),
                _cell(scorer="hhem_2_3_vectara"),
                _cell(scorer="hhem_2_3_vectara", language="zh-Hans", source="calibrated", fitted_at="2026-11-25"),
            ],
        }
    )
    assert len(thresholds.cells) == 3
    assert thresholds.cells[0].fitted_at is None


@pytest.mark.parametrize(
    "cells",
    [
        [_cell(), _cell(threshold=0.6)],
        [_cell(threshold=1.5)],
        [_cell(threshold=-0.1)],
        [_cell(source="fixture")],
    ],
)
def test_groundedness_thresholds_rejects(cells):
    with pytest.raises(ValidationError):
        GroundednessThresholds.model_validate({"schema_version": 1, "cells": cells})


def _scored(**overrides):
    base = {
        "status": "scored",
        "scorer": "hhem_2_1_open",
        "score": 0.8,
        "label": "verified",
        "threshold": 0.5,
        "thresholdSource": "default",
        "latencyMs": 210,
        "checkedAt": "2026-11-25T00:00:00.000Z",
    }
    base.update(overrides)
    return base


def test_answer_groundedness_per_status_shapes():
    pending = AnswerGroundedness.model_validate({"status": "pending"})
    assert pending.label is None and pending.score is None and pending.scorer is None
    AnswerGroundedness.model_validate(_scored())
    AnswerGroundedness.model_validate(_scored(score=0.2, label="possibly_unreliable"))
    not_checked = AnswerGroundedness.model_validate(
        {"status": "not_checked", "scorer": "none", "label": "not_checked", "reason": "expired"}
    )
    assert not_checked.truncated is False


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "pending", "label": "verified"},
        {"status": "pending", "score": 0.5},
        _scored(label="not_checked"),
        _scored(label=None),
        _scored(score=None),
        _scored(threshold=None),
        _scored(thresholdSource=None),
        _scored(scorer="none"),
        _scored(score=0.2),
        _scored(score=0.9, label="possibly_unreliable"),
        _scored(score=1.5),
        {"status": "not_checked", "label": "not_checked"},
        {"status": "not_checked", "label": "verified", "reason": "timeout"},
        {"status": "not_checked", "label": "not_checked", "reason": "timeout", "score": 0.4},
        {"status": "not_checked", "label": "not_checked", "reason": "Not A Code"},
        {"status": "pending", "unexpected": 1},
    ],
)
def test_answer_groundedness_rejects(payload):
    with pytest.raises(ValidationError):
        AnswerGroundedness.model_validate(payload)


def _feedback_request(**overrides):
    base = {"vote": "not_helpful", "reasons": ["wrong"], "comment": "It cited the wrong page."}
    base.update(overrides)
    return base


def test_answer_feedback_request_accepts():
    request = AnswerFeedbackRequest.model_validate({"vote": "helpful"})
    assert request.reasons == [] and request.comment is None and request.chatId is None
    AnswerFeedbackRequest.model_validate(_feedback_request(comment="x" * 500))
    AnswerFeedbackRequest.model_validate(
        _feedback_request(
            reasons=["wrong", "incomplete", "not_from_documents", "bad_citation"],
            chatId="00000000-0000-4000-8000-000000000001",
        )
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"vote": "maybe"},
        {"reasons": ["rude"]},
        {"reasons": ["wrong", "wrong"]},
        {"reasons": ["wrong", "incomplete", "not_from_documents", "bad_citation", "wrong"]},
        {"comment": "x" * 501},
        {"chatId": "not-a-uuid"},
        {"unexpected": 1},
    ],
)
def test_answer_feedback_request_rejects(overrides):
    with pytest.raises(ValidationError):
        AnswerFeedbackRequest.model_validate(_feedback_request(**overrides))


def _answer_record():
    return {
        "answerId": "00000000-0000-4000-8000-000000000002",
        "chatId": None,
        "traceId": "0123456789abcdef0123456789abcdef",
        "modelId": "generator/model-b",
        "citationStrategy": "chunk-alias",
        "ragMode": "strict",
        "answerLanguage": "en",
        "invalidCitations": 0,
        "citations": [_citation()],
        "groundedness": {**_scored(), "reason": None, "truncated": False},
        "feedback": {
            "vote": "not_helpful",
            "reasons": ["incomplete"],
            "comment": None,
            "updatedAt": "2026-11-25T00:00:05.000Z",
        },
        "documents": {"d-1": "current", "d-2": "unavailable"},
        "feedbackEnabled": True,
        "createdAt": "2026-11-25T00:00:00.000Z",
        "updatedAt": "2026-11-25T00:00:05.000Z",
    }


def test_answer_record_round_trips_unchanged():
    record = AnswerRecord.model_validate(_answer_record())
    dumped = record.model_dump(mode="json")
    assert dumped == _answer_record()
    assert AnswerRecord.model_validate(dumped) == record
    assert "review_reasons" not in AnswerRecord.model_fields
    assert "reviewReasons" not in AnswerRecord.model_fields


def test_answer_record_defaults():
    base = _answer_record()
    for key in ("invalidCitations", "documents", "feedbackEnabled", "feedback", "citationStrategy"):
        base.pop(key)
    record = AnswerRecord.model_validate(base)
    assert record.invalidCitations == 0
    assert record.documents == {}
    assert record.feedbackEnabled is False
    assert record.feedback is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"documents": {"d-1": "gone"}},
        {"ragMode": "loose"},
        {"invalidCitations": -1},
        {"answerId": "not-a-uuid"},
        {"reviewReasons": ["feedback_negative"]},
    ],
)
def test_answer_record_rejects(overrides):
    with pytest.raises(ValidationError):
        AnswerRecord.model_validate({**_answer_record(), **overrides})


def test_answer_feedback_rejects_unknown_vote():
    with pytest.raises(ValidationError):
        AnswerFeedback.model_validate({"vote": "meh", "reasons": [], "updatedAt": "2026-11-25T00:00:00.000Z"})


def test_committed_thresholds_file_holds_the_vendor_default_for_every_scorable_cell():
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "eval" / "config" / "groundedness-thresholds.json"
    thresholds = GroundednessThresholds.model_validate(json.loads(path.read_text(encoding="utf-8")))
    assert {(cell.scorer, cell.language) for cell in thresholds.cells} == {
        ("hhem_2_3_vectara", "en"),
        ("hhem_2_3_vectara", "zh-Hans"),
        ("hhem_2_1_open", "en"),
    }
    assert all(cell.threshold == 0.5 and cell.source == "default" and cell.fitted_at is None for cell in thresholds.cells)


# --- 05-07: Phase 5 extensions of existing contracts (D-05, D-12, D-19, D-22, D-23, D-24)

import json
from pathlib import Path

from rag_sidecar.contracts import eval_run
from rag_sidecar.contracts.baseline import Baseline
from rag_sidecar.contracts.eval_run import RagRunOptions, RagRunRequest, RagTrace
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.report import EvalReport
from rag_sidecar.contracts.review import ReviewQueueItem
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.contracts.sidecar import SidecarReady

REPO_ROOT = Path(__file__).resolve().parents[2]


def _trace(**overrides):
    base = dict(build_samples()["samples"]["RagTrace"])
    for key in ("citation_strategy", "invalid_citations", "groundedness"):
        base.pop(key, None)
    base["citations"] = []
    base.update(overrides)
    return base


def test_rag_trace_without_phase5_fields_validates_with_defaults():
    trace = RagTrace.model_validate(_trace())
    assert trace.citations == []
    assert trace.citation_strategy is None
    assert trace.invalid_citations == 0
    assert trace.groundedness is None
    assert trace.schema_version == 1


def test_rag_trace_accepts_chunk_alias_citation_record():
    trace = RagTrace.model_validate(
        _trace(citations=[_citation()], citation_strategy="chunk-alias", invalid_citations=1)
    )
    assert isinstance(trace.citations[0], CitationRecord)
    assert trace.citation_strategy == "chunk-alias"
    assert trace.invalid_citations == 1


def test_rag_trace_accepts_groundedness_for_eval_runs():
    groundedness = {
        "status": "scored",
        "scorer": "hhem_2_1_open",
        "score": 0.8,
        "label": "verified",
        "threshold": 0.5,
        "thresholdSource": "default",
    }
    trace = RagTrace.model_validate(_trace(groundedness=groundedness))
    assert trace.groundedness is not None and trace.groundedness.label == "verified"


@pytest.mark.parametrize(
    "overrides",
    [
        {"citations": [{"document_id": "doc-001", "chunk_id": "chunk-001"}]},
        {"citations": [{"document_id": "doc-001"}]},
        {"citation_strategy": "inline"},
        {"invalid_citations": -1},
    ],
)
def test_rag_trace_rejects_old_citation_shape_and_bad_fields(overrides):
    with pytest.raises(ValidationError):
        RagTrace.model_validate(_trace(**overrides))


def test_trace_citation_is_citation_record():
    assert eval_run.TraceCitation is CitationRecord


def test_rag_run_options_citations_and_groundedness_default_false():
    options = RagRunOptions()
    assert options.citations is False
    assert options.groundedness is False
    request = RagRunRequest.model_validate(
        {"query": "q", "options": {"citations": True, "groundedness": True}}
    )
    assert request.options.citations is True
    assert request.options.groundedness is True
    assert RagRunRequest.model_validate({"query": "q"}).options.citations is False


def _review(**overrides):
    base = {
        "trace_id": "t-1",
        "observation_id": "o-1",
        "captured_at": "2026-01-01T00:00:00Z",
        "tenant_key": "tenant-a",
        "query_masked": "q",
        "answer_masked": "a",
        "context_masked": "c",
        "model": "m",
    }
    base.update(overrides)
    return base


def test_review_queue_item_reasons():
    assert ReviewQueueItem.model_validate(_review()).reasons == []
    item = ReviewQueueItem.model_validate(_review(reasons=["feedback_negative", "groundedness_flagged"]))
    assert item.reasons == ["feedback_negative", "groundedness_flagged"]
    assert ReviewQueueItem.model_validate(_review(reasons=["sampled"])).reasons == ["sampled"]


@pytest.mark.parametrize("reasons", [["spam"], ["sampled", "sampled"]])
def test_review_queue_item_rejects_bad_reasons(reasons):
    with pytest.raises(ValidationError):
        ReviewQueueItem.model_validate(_review(reasons=reasons))


def _budgets(**extra):
    base = json.loads((REPO_ROOT / "eval" / "config" / "latency-budgets.json").read_text())
    base.pop("groundedness", None)
    base.update(extra)
    return base


GROUNDEDNESS_BUDGETS = {
    "hhem_2_1_open": {"p50_ms": 2500, "p95_ms": 5000},
    "hhem_2_3_vectara": {"p50_ms": 4000, "p95_ms": 8000},
    "report_only": True,
}


def test_latency_budgets_groundedness_section_is_optional_and_report_only():
    assert LatencyBudgets.model_validate(_budgets()).groundedness is None
    budgets = LatencyBudgets.model_validate(_budgets(groundedness=GROUNDEDNESS_BUDGETS))
    assert budgets.groundedness is not None
    assert budgets.groundedness.report_only is True
    assert budgets.groundedness.hhem_2_1_open is not None
    assert budgets.groundedness.hhem_2_1_open.p95_ms == 5000
    assert budgets.profiles["chat"].total_p95_ms == 2000


@pytest.mark.parametrize(
    "section",
    [
        {**GROUNDEDNESS_BUDGETS, "report_only": False},
        {**GROUNDEDNESS_BUDGETS, "hhem_2_1_open": {"p50_ms": 6000, "p95_ms": 5000}},
        {**GROUNDEDNESS_BUDGETS, "hhem_2_1_open": {"p50_ms": 0, "p95_ms": 5000}},
        {**GROUNDEDNESS_BUDGETS, "none": {"p50_ms": 1, "p95_ms": 2}},
    ],
)
def test_latency_budgets_groundedness_rejects(section):
    with pytest.raises(ValidationError):
        LatencyBudgets.model_validate(_budgets(groundedness=section))


def test_sidecar_ready_scorers():
    assert SidecarReady.model_validate({"status": "ready"}).scorers == []
    ready = SidecarReady.model_validate({"status": "ready", "scorers": ["hhem_2_1_open"]})
    assert ready.scorers == ["hhem_2_1_open"]


@pytest.mark.parametrize("scorers", [["hhem_9"], ["none"], ["hhem_2_1_open", "hhem_2_1_open"]])
def test_sidecar_ready_rejects_unknown_or_repeated_scorers(scorers):
    with pytest.raises(ValidationError):
        SidecarReady.model_validate({"status": "ready", "scorers": scorers})


def _report(**extra):
    base = dict(build_samples()["samples"]["EvalReport"])
    for key in (
        "invalid_citation_rate",
        "citation_coverage",
        "cited_gold_hit",
        "raw_invalid_markers",
        "groundedness_labels",
        "groundedness_latency",
        "by_strategy",
    ):
        base.pop(key, None)
    base.update(extra)
    return base


def test_eval_report_without_citation_fields_validates():
    report = EvalReport.model_validate(_report())
    assert report.invalid_citation_rate is None
    assert report.citation_coverage is None
    assert report.cited_gold_hit is None
    assert report.raw_invalid_markers is None
    assert report.groundedness_labels == {}
    assert report.groundedness_latency == {}
    assert report.by_strategy == {}


def test_eval_report_accepts_citation_metrics_label_counts_and_strategy_slices():
    metric = {"value": 0.5, "n": 4}
    report = EvalReport.model_validate(
        _report(
            invalid_citation_rate={"value": 0.0, "n": 4},
            citation_coverage=metric,
            cited_gold_hit=metric,
            raw_invalid_markers=2,
            groundedness_labels={
                "hhem_2_1_open": {"en": {"verified": 2, "possibly_unreliable": 1}},
                "none": {"it": {"not_checked": 1}},
            },
            groundedness_latency={"hhem_2_1_open": {"p50_ms": 100, "p95_ms": 200, "n": 3}},
            by_strategy={
                "chunk-alias": {
                    "items": 4,
                    "invalid_citation_rate": {"value": 0.0, "n": 4},
                    "citation_coverage": metric,
                    "cited_gold_hit": metric,
                    "generation_latency": {"p50_ms": 300, "p95_ms": 900, "n": 4},
                },
                "none": {"items": 1},
            },
        )
    )
    counts = report.groundedness_labels["hhem_2_1_open"]["en"]
    assert (counts.verified, counts.possibly_unreliable, counts.not_checked) == (2, 1, 0)
    assert report.by_strategy["chunk-alias"].items == 4
    assert report.by_strategy["none"].citation_coverage is None


@pytest.mark.parametrize(
    "extra",
    [
        {"groundedness_labels": {"hhem_9": {"en": {"verified": 1}}}},
        {"groundedness_labels": {"hhem_2_1_open": {"en": {"verified": -1}}}},
        {"groundedness_labels": {"hhem_2_1_open": {"en": {"unknown": 1}}}},
        {"by_strategy": {"inline": {"items": 1}}},
        {"raw_invalid_markers": -1},
        {"groundedness_latency": {"none": {"p50_ms": 1, "p95_ms": 2, "n": 1}}},
    ],
)
def test_eval_report_rejects_bad_citation_fields(extra):
    with pytest.raises(ValidationError):
        EvalReport.model_validate(_report(**extra))


def test_committed_configs_and_baselines_still_load():
    LatencyBudgets.model_validate_json((REPO_ROOT / "eval" / "config" / "latency-budgets.json").read_text())
    baselines = sorted((REPO_ROOT / "eval" / "baselines").glob("*.json"))
    assert baselines
    for path in baselines:
        Baseline.model_validate_json(path.read_text())
