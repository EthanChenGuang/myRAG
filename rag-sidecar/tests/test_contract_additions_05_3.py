"""Phase 5.3 D-03, D-05, D-18, D-46: additive Literal values and optional fields on existing contracts."""

import copy

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts.baseline import Baseline, GateResult
from rag_sidecar.contracts.eval_run import RagRunOptions, RunManifest
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from rag_sidecar.contracts.golden import UNANSWERABLE_CATEGORIES, GoldenItem
from rag_sidecar.contracts.report import EvalReport, SliceMetrics
from rag_sidecar.contracts.retrieval import RefusalCell
from rag_sidecar.contracts.review import ReviewQueueItem
from rag_sidecar.contracts.samples import build_samples

SAMPLES = build_samples()["samples"]


def _answerable(**overrides):
    base = {
        "id": "en-general-901",
        "question": "Which colour is the sample widget?",
        "language": "en",
        "category": "general",
        "answerable": True,
        "expected_answer": "The sample widget is blue.",
        "gold_evidence": [{"document": "widgets.md", "section": "Colours", "quote": "the sample widget is blue"}],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize("provenance", ["historical", "paraphrased"])
def test_new_provenances_validate(provenance):
    assert GoldenItem.model_validate(_answerable(provenance=provenance)).provenance == provenance


def test_implicit_condition_is_an_answerable_category():
    assert "implicit_condition" not in UNANSWERABLE_CATEGORIES
    item = GoldenItem.model_validate(_answerable(id="en-implicit-901", category="implicit_condition"))
    assert item.category == "implicit_condition"


def test_implicit_condition_cannot_be_unanswerable():
    with pytest.raises(ValidationError):
        GoldenItem.model_validate(
            _answerable(category="implicit_condition", answerable=False, expected_answer=None, gold_evidence=[])
        )


@pytest.mark.parametrize("reason", ["representative", "re_review"])
def test_new_review_reasons(reason):
    payload = {**SAMPLES["ReviewQueueItem"], "reasons": [reason]}
    assert ReviewQueueItem.model_validate(payload).reasons == [reason]


def test_slice_metrics_false_answer_rate_is_optional_and_omitted_when_unset():
    base = SAMPLES["EvalReport"]["overall"]
    without = SliceMetrics.model_validate(base)
    assert without.false_answer_rate is None
    assert "false_answer_rate" not in without.model_dump(mode="json")
    with_value = SliceMetrics.model_validate({**base, "false_answer_rate": {"value": 0.15, "n": 20}})
    assert with_value.false_answer_rate is not None and with_value.false_answer_rate.value == 0.15
    assert SliceMetrics.model_validate(with_value.model_dump(mode="json")) == with_value


def test_eval_report_new_fields_default_and_round_trip():
    report = EvalReport.model_validate(SAMPLES["EvalReport"])
    assert report.rag_mode == "strict"
    assert report.golden_set_version is None
    assert report.golden_manifest_sha256 is None
    assert report.stale_count == 0
    assert report.stale_share == 0.0
    dumped = report.model_dump(mode="json")
    assert "golden_set_version" not in dumped and "golden_manifest_sha256" not in dumped
    full = EvalReport.model_validate(
        {
            **SAMPLES["EvalReport"],
            "rag_mode": "balanced",
            "golden_set_version": 3,
            "golden_manifest_sha256": "c" * 64,
            "stale_count": 2,
            "stale_share": 0.05,
        }
    )
    assert EvalReport.model_validate(full.model_dump(mode="json")) == full


def test_eval_report_rejects_unknown_rag_mode():
    with pytest.raises(ValidationError):
        EvalReport.model_validate({**SAMPLES["EvalReport"], "rag_mode": "turbo"})


def test_run_manifest_rag_mode_defaults_to_strict_and_stays_out_of_run_options():
    manifest = RunManifest.model_validate(SAMPLES["RunManifest"])
    assert manifest.rag_mode == "strict"
    assert "rag_mode" not in RagRunOptions.model_fields
    assert RunManifest.model_validate({**SAMPLES["RunManifest"], "rag_mode": "flexible"}).rag_mode == "flexible"


def test_gate_result_absolute_is_optional_and_omitted_when_unset():
    payload = SAMPLES["GateResult"]
    result = GateResult.model_validate(payload)
    assert result.absolute is None
    assert "absolute" not in result.model_dump(mode="json")
    absolute = {
        "passed": True,
        "mode": "enforce",
        "rag_mode": "strict",
        "checks": [],
        "composition": {"languages": [], "missing_required_kinds": []},
        "stale_result": "passed",
        "exit_code": 0,
    }
    with_absolute = GateResult.model_validate({**payload, "absolute": absolute})
    assert with_absolute.absolute is not None and with_absolute.absolute.rag_mode == absolute["rag_mode"]


def test_baseline_golden_version_fields_are_optional_and_omitted_when_unset():
    baseline = Baseline.model_validate(SAMPLES["Baseline"])
    assert baseline.golden_set_version is None and baseline.golden_manifest_sha256 is None
    dumped = baseline.model_dump(mode="json")
    assert "golden_set_version" not in dumped and "golden_manifest_sha256" not in dumped
    versioned = Baseline.model_validate(
        {**SAMPLES["Baseline"], "golden_set_version": 1, "golden_manifest_sha256": "d" * 64}
    )
    assert versioned.golden_set_version == 1


def test_refusal_cell_embedding_model_is_optional_and_omitted_when_unset():
    block = {
        "no_answer_count": 3,
        "answerable_count": 5,
        "false_refusal_rate": 0.0,
        "false_refusal_rate_upper_bound": 0.2,
        "correct_refusal_rate": 1.0,
    }
    cell_payload = {
        "key": "local_bm25|bm25-v1|en|same",
        "provider": "local_bm25",
        "model": "bm25-v1",
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
        "dev": block,
        "holdout": copy.deepcopy(block),
    }
    cell = RefusalCell.model_validate(cell_payload)
    assert cell.embedding_model is None
    assert "embedding_model" not in cell.model_dump(mode="json")
    with_model = RefusalCell.model_validate({**cell_payload, "embedding_model": "embedder-a"})
    assert with_model.model_dump(mode="json")["embedding_model"] == "embedder-a"


def test_gate_population_accepts_historical():
    config = GatePopulationConfig.model_validate({"mode": "real", "provenances": ["production", "human", "historical"]})
    assert "historical" in config.provenances
    with pytest.raises(ValidationError):
        GatePopulationConfig.model_validate({"provenances": ["paraphrased"]})


def test_default_rag_mode_and_zero_stale_counts_are_omitted_so_old_reports_stay_byte_identical():
    report = EvalReport.model_validate(SAMPLES["EvalReport"])
    dumped = report.model_dump(mode="json")
    assert not {"rag_mode", "stale_count", "stale_share"} & set(dumped)
    balanced = EvalReport.model_validate({**SAMPLES["EvalReport"], "rag_mode": "balanced", "stale_count": 1, "stale_share": 0.1})
    assert {"rag_mode", "stale_count", "stale_share"} <= set(balanced.model_dump(mode="json"))
    assert "rag_mode" not in RunManifest.model_validate(SAMPLES["RunManifest"]).model_dump(mode="json")
