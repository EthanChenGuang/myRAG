import json
from pathlib import Path

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


# --- Task 2: claims, judge, thresholds and output caps ---

from rag_sidecar.contracts.claims import (  # noqa: E402
    MAX_CLAIMS,
    ClaimCheckRequest,
    ClaimCheckResult,
    ClaimJudgement,
    ClaimVerdict,
    GroundednessJudgeThresholds,
)
from rag_sidecar.contracts.groundedness import GroundednessResult, GroundednessThresholds  # noqa: E402
from rag_sidecar.contracts.output_guard import OutputCaps  # noqa: E402


def _claim_request(claims=None, premises=None):
    return {
        "request_id": "req-1",
        "language": "en",
        "premises": premises if premises is not None else [{"ref": "S1", "text": "A neutral premise."}],
        "claims": claims if claims is not None else [{"index": 0, "hypothesis": "A claim.", "premise_refs": ["S1"]}],
        "allow_vectara": False,
    }


def test_claims_request_caps_and_refs():
    assert MAX_CLAIMS == 40
    ClaimCheckRequest.model_validate(_claim_request())
    forty = [{"index": i, "hypothesis": "A claim.", "premise_refs": ["S1"]} for i in range(40)]
    assert len(ClaimCheckRequest.model_validate(_claim_request(claims=forty)).claims) == 40
    bad_cases = [
        _claim_request(claims=forty + [{"index": 40, "hypothesis": "A claim.", "premise_refs": ["S1"]}]),
        _claim_request(claims=[{"index": 0, "hypothesis": "A claim.", "premise_refs": ["S9"]}]),
        _claim_request(
            claims=[
                {"index": 0, "hypothesis": "A claim.", "premise_refs": ["S1"]},
                {"index": 0, "hypothesis": "Another claim.", "premise_refs": ["S1"]},
            ]
        ),
        _claim_request(premises=[{"ref": "S1", "text": "One."}, {"ref": "S1", "text": "Two."}]),
        _claim_request(premises=[{"ref": f"S{i + 1}", "text": "p"} for i in range(65)]),
        _claim_request(claims=[]),
    ]
    for bad in bad_cases:
        with pytest.raises(ValidationError):
            ClaimCheckRequest.model_validate(bad)


def test_claims_verdict_status_rules():
    ClaimVerdict.model_validate({"index": 0, "status": "scored", "scorer": "hhem_2_1_open", "score": 0.7})
    ClaimVerdict.model_validate({"index": 1, "status": "not_checked", "scorer": "none", "reason": "too_many"})
    for reason in [
        "timeout",
        "too_many",
        "unsupported_language",
        "judge_not_configured",
        "judge_same_family",
        "judge_uncalibrated",
        "error",
    ]:
        ClaimVerdict.model_validate({"index": 0, "status": "not_checked", "scorer": "none", "reason": reason})
    for bad in [
        {"index": 0, "status": "scored", "scorer": "hhem_2_1_open"},
        {"index": 0, "status": "scored", "scorer": "hhem_2_1_open", "score": 1.5},
        {"index": 0, "status": "scored", "scorer": "none", "score": 0.5},
        {"index": 0, "status": "not_checked", "scorer": "none"},
        {"index": 0, "status": "not_checked", "scorer": "none", "reason": "something_else"},
        {"index": 0, "status": "not_checked", "scorer": "none", "reason": "timeout", "score": 0.1},
    ]:
        with pytest.raises(ValidationError):
            ClaimVerdict.model_validate(bad)
    with pytest.raises(ValidationError):
        ClaimCheckResult.model_validate(
            {
                "claims": [
                    {"index": 0, "status": "not_checked", "scorer": "none", "reason": "timeout"},
                    {"index": 0, "status": "not_checked", "scorer": "none", "reason": "timeout"},
                ],
                "latency_ms": 3,
            }
        )


def test_claims_judgement_verdicts():
    judgement = ClaimJudgement.model_validate(
        {
            "judgements": [
                {"index": 0, "verdict": "supported", "evidence_ref": "S1"},
                {"index": 1, "verdict": "not_enough_info", "evidence_ref": None},
                {"index": 2, "verdict": "unsupported"},
            ]
        }
    )
    assert judgement.judgements[2].evidence_ref is None
    with pytest.raises(ValidationError):
        ClaimJudgement.model_validate({"judgements": [{"index": 0, "verdict": "partly", "evidence_ref": None}]})
    with pytest.raises(ValidationError):
        ClaimJudgement.model_validate(
            {"judgements": [{"index": 0, "verdict": "supported"}, {"index": 0, "verdict": "unsupported"}]}
        )


def _judge_cell(**overrides):
    base = {
        "judge_model": "judge/model-j",
        "judge_version": "jv-1",
        "language": "it",
        "max_unsupported_share": 0.2,
        "recall": 0.8,
        "precision": 0.9,
        "source": "fixture",
        "run_ids": ["run-1"],
        "config_hash": "c" * 64,
    }
    base.update(overrides)
    return base


def test_claims_judge_thresholds_cells():
    GroundednessJudgeThresholds.model_validate({"cells": [_judge_cell(), _judge_cell(language="en")]})
    with pytest.raises(ValidationError):
        GroundednessJudgeThresholds.model_validate({"cells": [_judge_cell(), _judge_cell(recall=0.5)]})
    for bad in [
        {"max_unsupported_share": 1.2},
        {"recall": -0.1},
        {"precision": 2},
        {"source": "default"},
        {"run_ids": []},
        {"config_hash": ""},
    ]:
        with pytest.raises(ValidationError):
            GroundednessJudgeThresholds.model_validate({"cells": [_judge_cell(**bad)]})


def test_output_caps_one_cell_per_mode():
    caps = OutputCaps.model_validate(
        {"cells": [{"mode": "strict", "limit": None, "source": "default"}, {"mode": "balanced", "limit": None, "source": "default"}]}
    )
    assert caps.schema_version == 1
    OutputCaps.model_validate(
        {
            "cells": [
                {"mode": "strict", "limit": 600, "source": "sweep", "run_ids": ["run-1"], "config_hash": "h"},
                {"mode": "balanced", "limit": None, "source": "default"},
            ]
        }
    )
    for cells in [
        [{"mode": "strict", "limit": None, "source": "default"}],
        [{"mode": "strict", "limit": None, "source": "default"}, {"mode": "strict", "limit": 100, "source": "default"}],
        [{"mode": "strict", "limit": 0, "source": "default"}, {"mode": "balanced", "limit": None, "source": "default"}],
        [{"mode": "flexible", "limit": None, "source": "default"}, {"mode": "balanced", "limit": None, "source": "default"}],
        [{"mode": "strict", "limit": 10, "source": "sweep"}, {"mode": "balanced", "limit": None, "source": "default"}],
    ]:
        with pytest.raises(ValidationError):
            OutputCaps.model_validate({"cells": cells})


def test_claims_llm_judge_scorer_and_hhem_cells_unchanged():
    result = GroundednessResult.model_validate({"status": "scored", "scorer": "llm_judge", "score": 0.75, "latency_ms": 9})
    assert result.scorer == "llm_judge"
    path = Path(__file__).resolve().parents[2] / "eval" / "config" / "groundedness-thresholds.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    GroundednessThresholds.model_validate(data)
    with pytest.raises(ValidationError):
        GroundednessThresholds.model_validate(
            {"cells": [{"scorer": "llm_judge", "language": "it", "threshold": 0.5, "source": "default"}]}
        )


# --- Task 3: guard rules, security events, review reasons and registration ---

from typing import get_args  # noqa: E402

from rag_sidecar.contracts.output_guard import OutputGuardRules  # noqa: E402
from rag_sidecar.contracts.review import ReviewReason  # noqa: E402
from rag_sidecar.contracts.security_events import (  # noqa: E402
    LinkPreviewStatus,
    SecurityAlert,
    SecurityEvent,
    SecurityUploaderView,
)


def _guard_rules(**overrides):
    base = {
        "version": "1",
        "credential_rules": [
            {"id": "cred-en-01", "language": "en", "request_terms": ["send me"], "secret_terms": ["password"]}
        ],
        "obfuscation_patterns": [{"id": "obf-01", "pattern": r"h\s*t\s*t\s*p"}],
        "opaque_schemes": ["data", "javascript"],
    }
    base.update(overrides)
    return base


def test_security_guard_rules_shape():
    rules = OutputGuardRules.model_validate(_guard_rules())
    assert rules.schema_version == 1
    for bad in [
        {"credential_rules": [{"id": "cred-en-01", "language": "en", "request_terms": [], "secret_terms": ["x"]}]},
        {"credential_rules": [{"id": "cred-en-01", "language": "en", "request_terms": [""], "secret_terms": ["x"]}]},
        {"credential_rules": [{"id": "cred-en-01", "language": "en", "request_terms": ["x"], "secret_terms": []}]},
        {"obfuscation_patterns": [{"id": "obf-01", "pattern": r"(a)\1"}]},
        {"obfuscation_patterns": [{"id": "obf-01", "pattern": r"(?P<n>a)(?P=n)"}]},
        {"obfuscation_patterns": [{"id": "obf-01", "pattern": "a"}, {"id": "obf-01", "pattern": "b"}]},
        {"opaque_schemes": ["Not A Scheme"]},
        {"version": ""},
    ]:
        with pytest.raises(ValidationError):
            OutputGuardRules.model_validate(_guard_rules(**bad))


def _event(**overrides):
    base = {
        "tenant_key": "s:default",
        "source": "output_guard",
        "action": "removed",
        "detector": "rules",
        "rule_ids": ["rule-1"],
        "document_id": "doc-1",
        "chunk_id": "chunk-1",
        "uploader_id": "00000000-0000-4000-8000-0000000000c1",
        "trace_id": "trace-1",
    }
    base.update(overrides)
    return base


def test_security_event_has_no_text_field():
    event = SecurityEvent.model_validate(_event())
    assert event.id is None
    assert not {"text", "snippet", "content", "quote"} & set(SecurityEvent.model_fields)
    for bad in [{"text": "anything"}, {"source": "chat"}, {"action": "deleted"}, {"tenant_key": ""}]:
        with pytest.raises(ValidationError):
            SecurityEvent.model_validate(_event(**bad))
    SecurityEvent.model_validate(_event(chunk_id=None, uploader_id=None, trace_id=None, source="ingest_injection", action="quarantined"))


def test_security_alert_rules():
    alert = {
        "tenant_key": "s:default",
        "uploader_id": "00000000-0000-4000-8000-0000000000c1",
        "event_count": 3,
        "window_start": "2026-01-01T00:00:00+00:00",
        "window_end": "2026-01-02T00:00:00Z",
        "status": "open",
    }
    assert SecurityAlert.model_validate(alert).held is False
    for bad in [
        {"event_count": 0},
        {"status": "closed"},
        {"window_end": "2026-01-01T00:00:00Z"},
        {"window_start": "not a time"},
    ]:
        with pytest.raises(ValidationError):
            SecurityAlert.model_validate(alert | bad)


def test_security_uploader_view_and_link_previews():
    view = SecurityUploaderView.model_validate(
        {"user_id": "00000000-0000-4000-8000-0000000000c1", "display_name": "Uploader A", "tenant_key": "s:default"}
    )
    assert view.email is None
    LinkPreviewStatus.model_validate({"state": "unknown"})
    LinkPreviewStatus.model_validate({"state": "subset", "preview_hosts": ["host.example"]})
    LinkPreviewStatus.model_validate(
        {"state": "mismatch", "preview_hosts": ["host.example", "other.example"], "hosts_not_allowlisted": ["other.example"]}
    )
    for bad in [
        {"state": "partial"},
        {"state": "subset", "preview_hosts": ["https://host.example/path"]},
        {"state": "mismatch", "preview_hosts": ["host.example"]},
        {"state": "subset", "preview_hosts": ["host.example"], "hosts_not_allowlisted": ["host.example"]},
        {"state": "none", "preview_hosts": ["host.example"]},
    ]:
        with pytest.raises(ValidationError):
            LinkPreviewStatus.model_validate(bad)


def test_security_review_reasons_extended_by_three():
    assert set(get_args(ReviewReason)) >= {
        "sampled",
        "feedback_negative",
        "groundedness_flagged",
        "claim_unsupported",
        "output_guard",
        "version_conflict",
    }
    assert not {"calc_mismatch", "calc_unverified"} & set(get_args(ReviewReason))


PHASE52_MODELS = [
    "AnswerChecks",
    "AnswerSentence",
    "AnswerNotice",
    "OutputGuardSummary",
    "VersionConflict",
    "ClaimCheckRequest",
    "ClaimCheckResult",
    "ClaimJudgement",
    "GroundednessJudgeThresholds",
    "OutputCaps",
    "OutputGuardRules",
    "SecurityEvent",
    "SecurityAlert",
    "UploaderHold",
    "SecurityEventView",
    "SecurityAlertView",
    "SecurityUploaderView",
    "LinkPreviewStatus",
]


def test_security_every_phase52_model_is_registered_with_a_neutral_sample():
    from rag_sidecar.contracts.samples import build_samples  # noqa: PLC0415
    from rag_sidecar.export_schemas import CONTRACTS  # noqa: PLC0415

    registered = {model.__name__: model for model, _ in CONTRACTS}
    samples = build_samples()["samples"]
    for name in PHASE52_MODELS:
        assert name in registered, name
        assert name in samples, name
        registered[name].model_validate(samples[name])
    blob = json.dumps({name: samples[name] for name in PHASE52_MODELS}).lower()
    for word in ("leave", "salary", "vpn", "travel", "hotel", "restaurant", "branch"):
        assert word not in blob, word
