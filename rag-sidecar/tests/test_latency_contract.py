import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import EvalReport, LatencyBudgets, StageLatency
from rag_sidecar.contracts.samples import build_samples
from rag_sidecar.export_schemas import CONTRACTS

REPO_ROOT = Path(__file__).resolve().parents[2]
BUDGETS_PATH = REPO_ROOT / "eval" / "config" / "latency-budgets.json"
METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]


def _budgets(**overrides):
    base = {
        "schema_version": 1,
        "profiles": {
            "chat": {"total_p50_ms": 1000, "total_p95_ms": 2000, "stages": {"embed": 200, "search": 400}},
            "voice": {"total_p50_ms": 400, "total_p95_ms": 800},
        },
    }
    base.update(overrides)
    return base


def _report_payload(**overrides):
    slice_metrics = {name: {"value": 0.5, "n": 10} for name in METRICS}
    base = {
        "run_id": "run-001",
        "tier": "smoke",
        "run_config_hash": "a" * 64,
        "golden_sha256": "c" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "deployment_mode": "single",
        "request_options": {},
        "k_values": [5, 10],
        "overall": slice_metrics,
        "by_language": {"en": slice_metrics},
        "by_category": {"general": slice_metrics},
        "by_language_category": {"en/general": slice_metrics},
        "by_split": {"dev": slice_metrics},
        "items": [],
    }
    base.update(overrides)
    return base


class TestLatencyBudgets:
    def test_valid_budgets_accepted_and_stages_are_optional(self):
        budgets = LatencyBudgets.model_validate(_budgets())
        assert budgets.profiles["chat"].stages["embed"] == 200
        assert budgets.profiles["voice"].stages == {}

    def test_negative_budget_rejected(self):
        bad = _budgets(profiles={"chat": {"total_p50_ms": -1, "total_p95_ms": 2000}})
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate(bad)

    def test_negative_stage_budget_rejected(self):
        bad = _budgets(profiles={"chat": {"total_p50_ms": 1, "total_p95_ms": 2, "stages": {"embed": -5}}})
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate(bad)

    def test_unknown_profile_rejected(self):
        bad = _budgets(profiles={"batch": {"total_p50_ms": 1, "total_p95_ms": 2}})
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate(bad)

    def test_p50_above_p95_rejected(self):
        bad = _budgets(profiles={"chat": {"total_p50_ms": 3000, "total_p95_ms": 2000}})
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate(bad)

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate({**_budgets(), "smuggled": 1})

    def test_registered_in_serialization_mode_with_a_sample(self):
        registered = {model.__name__: mode for model, mode in CONTRACTS}
        assert registered.get("LatencyBudgets") == "serialization"
        assert "LatencyBudgets" in build_samples()["samples"]

    def test_committed_config_matches_the_decided_budgets(self):
        budgets = LatencyBudgets.model_validate(json.loads(BUDGETS_PATH.read_text(encoding="utf-8")))
        for name in ("chat", "embed"):
            profile = budgets.profiles[name]
            assert (profile.total_p50_ms, profile.total_p95_ms) == (1000, 2000)
            assert {key: profile.stages[key] for key in ("embed", "search", "assemble")} == {
                "embed": 200,
                "search": 400,
                "assemble": 100,
            }
            assert profile.stages["rerank"] == 600
        voice = budgets.profiles["voice"]
        assert (voice.total_p50_ms, voice.total_p95_ms) == (400, 800)
        assert voice.stages["rerank"] == 250


class TestStageLatency:
    def test_p50_above_p95_rejected(self):
        with pytest.raises(ValidationError):
            StageLatency(p50_ms=5.0, p95_ms=4.0, n=3)

    def test_negative_count_rejected(self):
        with pytest.raises(ValidationError):
            StageLatency(p50_ms=1.0, p95_ms=2.0, n=-1)

    def test_negative_ms_rejected(self):
        with pytest.raises(ValidationError):
            StageLatency(p50_ms=-1.0, p95_ms=2.0, n=1)


class TestEvalReportLatency:
    def test_report_without_latency_still_parses(self):
        assert EvalReport(**_report_payload()).latency is None

    def test_report_with_latency_round_trips(self):
        latency = {"embed": {"p50_ms": 1.0, "p95_ms": 2.0, "n": 4}}
        report = EvalReport(**_report_payload(latency=latency))
        assert report.latency["embed"].n == 4
        assert EvalReport.model_validate(report.model_dump(mode="json")) == report
