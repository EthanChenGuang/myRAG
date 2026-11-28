import json
import uuid
from datetime import date
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.eval_run import RunManifest
from rag_sidecar.contracts.ingest import DocType
from rag_sidecar.contracts.retrieval import (
    CHUNKING_VALIDATION_CASES,
    ChunkingDecision,
    ChunkingProfile,
    ChunkingSweepReport,
    RefusalCalibrationConfig,
    RefusalCell,
    RefusalThresholds,
    RetrievalFilters,
    RetrievalLegWeights,
    RetrievalOverrides,
    RetrievalParams,
    chunking_profile_findings,
    write_chunking_cases,
)

_DEFAULT_CONTEXT = {"max_child_tokens": 8191, "top_k": 8, "context_budget": 6000}


def test_retrieval_params_defaults():
    params = RetrievalParams()
    assert params.candidate_pool_size == 75
    assert params.rerank_input_cap == 75
    assert params.final_top_k == 8
    assert params.rrf_k == 60
    assert params.leg_weights == RetrievalLegWeights(dense=1.0, lexical=1.0, exact_id=1.0)
    assert params.provenance.source == "defaults"


@pytest.mark.parametrize("cap", [24, 101])
def test_retrieval_params_rejects_rerank_cap_out_of_range(cap):
    with pytest.raises(ValidationError):
        RetrievalParams(rerank_input_cap=cap)


def test_retrieval_overrides_accepts_single_fields_and_rejects_extra():
    assert RetrievalOverrides(candidate_pool_size=50).candidate_pool_size == 50
    with pytest.raises(ValidationError):
        RetrievalOverrides(candidate_pool_size=50, extra=1)


def test_retrieval_overrides_carries_rerank_model():
    assert RetrievalOverrides(rerank_model="fake-quality-v1").rerank_model == "fake-quality-v1"
    assert RetrievalOverrides().rerank_model is None
    with pytest.raises(ValidationError):
        RetrievalOverrides(rerank_model="")


def test_run_manifest_records_optional_run_config():
    from rag_sidecar.contracts.samples import build_samples

    base = dict(build_samples()["samples"]["RunManifest"])
    assert base.get("run_config") is None
    base["run_config"] = {
        "name": "v2-all-off",
        "env": {"RAG_PIPELINE": "v2"},
        "overrides": {"final_top_k": 5, "rerank_model": "fake-quality-v1"},
    }
    manifest = RunManifest.model_validate(base)
    assert manifest.run_config is not None
    assert manifest.run_config.env == {"RAG_PIPELINE": "v2"}
    base["run_config"]["extra"] = 1
    with pytest.raises(ValidationError):
        RunManifest.model_validate(base)


def test_retrieval_filters_accepts_valid_shapes():
    doc_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    filt = RetrievalFilters(
        date_range={"from": date(2024, 1, 1), "to": date(2024, 6, 1)},
        sources=["manual"],
        document_ids=[doc_id],
        doc_types=["general"],
        languages=["en"],
        invoice={"supplier": "Acme", "amount_min": "10.00", "amount_max": "99.99", "currency": "EUR"},
    )
    assert filt.invoice is not None
    assert filt.invoice.amount_min == "10.00"


@pytest.mark.parametrize(
    "payload",
    [
        {"sources": []},
        {"document_ids": []},
        {"doc_types": []},
        {"languages": []},
        {"date_range": {"from": date(2024, 6, 1), "to": date(2024, 1, 1)}},
        {"invoice": {"supplier": "x", "amount_min": "20", "amount_max": "10", "currency": "EUR"}},
    ],
)
def test_retrieval_filters_rejects_invalid(payload):
    with pytest.raises(ValidationError):
        RetrievalFilters(**payload)


def _sample_cell(**changes) -> dict:
    base = {
        "key": "cohere|rerank-v5.0-pro|en|same",
        "provider": "cohere",
        "model": "rerank-v5.0-pro",
        "query_language": "en",
        "pairing": "same",
        "threshold": 0.42,
        "status": "calibrated",
        "tokenizer_version": 1,
        "rerank_text_version": 1,
        "config_hash": "a" * 64,
        "source": "fixture",
        "recorded_at": "2026-01-01T00:00:00Z",
        "holdout_evaluations": 1,
        "dev": {
            "no_answer_count": 3,
            "answerable_count": 5,
            "false_refusal_rate": 0.0,
            "false_refusal_rate_upper_bound": 0.2,
            "correct_refusal_rate": 1.0,
        },
        "holdout": {
            "no_answer_count": 1,
            "answerable_count": 2,
            "false_refusal_rate": 0.0,
            "false_refusal_rate_upper_bound": 0.3,
            "correct_refusal_rate": 1.0,
        },
    }
    base.update(changes)
    return base


def test_refusal_thresholds_rejects_calibrated_without_threshold():
    cell = _sample_cell(threshold=None, status="calibrated")
    with pytest.raises(ValidationError):
        RefusalThresholds(cells=[RefusalCell.model_validate(cell)])


def test_refusal_thresholds_rejects_duplicate_cell_keys():
    cell = RefusalCell.model_validate(_sample_cell())
    with pytest.raises(ValidationError):
        RefusalThresholds(cells=[cell, cell])


def test_refusal_calibration_config_defaults():
    cfg = RefusalCalibrationConfig()
    assert cfg.target_false_refusal == 0.05
    assert cfg.dev_minimums.fixture.no_answer == 3
    assert cfg.dev_minimums.fixture.answerable == 5
    assert cfg.dev_minimums.live.no_answer == 10
    assert cfg.dev_minimums.live.answerable == 20
    assert cfg.holdout_minimums.fixture.no_answer == 1
    assert cfg.holdout_minimums.fixture.answerable == 2
    assert cfg.holdout_minimums.live.no_answer == 3
    assert cfg.holdout_minimums.live.answerable == 6
    assert "false_refusal_test" in cfg.pass_rule


def test_chunking_profile_default_preset_warns_on_budget():
    profile = {
        "id": "general@256x1024",
        "doc_type": "general",
        "child_tokens": 256,
        "parent_mode": "structure",
        "parent_tokens": 1024,
        "status": "ready",
        "preset": "256/1024",
    }
    errors, warnings = chunking_profile_findings(profile, _DEFAULT_CONTEXT)
    assert errors == []
    assert "top_k_parent_over_budget" in warnings
    ChunkingProfile.model_validate(profile, context=_DEFAULT_CONTEXT)


@pytest.mark.parametrize(
    "profile,expected_error",
    [
        ({"child_tokens": 9000, "parent_tokens": 12000, "parent_mode": "structure", "preset": "custom"}, "child_exceeds_embedding_input"),
        ({"child_tokens": 256, "parent_tokens": 400, "parent_mode": "fixed", "preset": "custom"}, "parent_below_twice_child"),
    ],
)
def test_chunking_profile_hard_errors(profile, expected_error):
    base = {
        "id": "general@custom",
        "doc_type": "general",
        "status": "ready",
        **profile,
    }
    errors, warnings = chunking_profile_findings(base, _DEFAULT_CONTEXT)
    assert expected_error in errors
    with pytest.raises(ValidationError):
        ChunkingProfile.model_validate(base, context=_DEFAULT_CONTEXT)


def test_chunking_profile_ratio_warning():
    profile = {
        "id": "general@128x1536",
        "doc_type": "general",
        "child_tokens": 128,
        "parent_mode": "fixed",
        "parent_tokens": 1536,
        "status": "ready",
        "preset": "custom",
    }
    errors, warnings = chunking_profile_findings(profile, _DEFAULT_CONTEXT)
    assert errors == []
    assert "ratio_outside_4_8" in warnings
    assert "top_k_parent_over_budget" in warnings


def test_chunking_profile_fixed_mode_requires_parent_tokens():
    profile = {
        "id": "general@broken",
        "doc_type": "general",
        "child_tokens": 256,
        "parent_mode": "fixed",
        "parent_tokens": None,
        "status": "ready",
        "preset": "custom",
    }
    errors, _ = chunking_profile_findings(profile, _DEFAULT_CONTEXT)
    assert "parent_tokens_required" in errors


def test_chunking_validation_case_table_matches_findings():
    for row in CHUNKING_VALIDATION_CASES:
        errors, warnings = chunking_profile_findings(row["input"], row.get("context", _DEFAULT_CONTEXT))
        assert sorted(errors) == sorted(row["errors"])
        assert sorted(warnings) == sorted(row["warnings"])


def test_write_chunking_cases_round_trip(tmp_path: Path):
    target = tmp_path / "chunking-profile-cases.json"
    write_chunking_cases(target)
    data = json.loads(target.read_text(encoding="utf-8"))
    assert len(data["cases"]) == len(CHUNKING_VALIDATION_CASES)
    for expected, actual in zip(CHUNKING_VALIDATION_CASES, data["cases"], strict=True):
        assert actual["errors"] == expected["errors"]
        assert actual["warnings"] == expected["warnings"]


def test_chunking_decision_requires_gate_passed():
    with pytest.raises(ValidationError):
        ChunkingDecision(
            doc_type="general",
            profile_id="general@256x1024",
            chosen_on={"recall_at_5": 0.5},
            regressions=[],
            build_run_id=None,
            report_hash="b" * 64,
            decided_by="admin",
            recorded_at="2026-01-01",
            source="fixture",
        )


def test_chunking_decision_rejects_passed_with_regressions():
    with pytest.raises(ValidationError):
        ChunkingDecision(
            doc_type="general",
            profile_id="general@256x1024",
            chosen_on={"recall_at_5": 0.5},
            gate_passed=True,
            regressions=[{"slice": "overall", "metric": "mrr", "diff": -0.1, "band": 0.02}],
            build_run_id="run-1",
            report_hash="b" * 64,
            decided_by="admin",
            recorded_at="2026-01-01",
            source="fixture",
        )


def test_chunking_sweep_report_allows_null_gate_on_legacy():
    report = ChunkingSweepReport(
        profiles=[
            {
                "profile_id": "legacy",
                "metrics": {
                    "overall": _empty_chunking_metrics(),
                },
                "gate": None,
            }
        ],
        provenance={"source": "defaults"},
    )
    assert report.profiles[0].gate is None


def _empty_chunking_metrics() -> dict:
    metric = {"value": None, "n": 0}
    return {
        "recall_at_k": metric,
        "mrr": metric,
        "correct_refusal_rate": metric,
        "false_refusal_rate": metric,
        "judge_correctness": metric,
        "judge_skipped": True,
        "context_tokens": metric,
        "latency_p50_ms": metric,
        "latency_p95_ms": metric,
    }