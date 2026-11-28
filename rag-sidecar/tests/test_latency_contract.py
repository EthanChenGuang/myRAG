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


class TestQueryGroupBudgets:
    def test_query_group_validates(self):
        budgets = LatencyBudgets.model_validate(
            _budgets(
                profiles={
                    "chat": {
                        "total_p50_ms": 1000,
                        "total_p95_ms": 2000,
                        "groups": {"query": {"p50_ms": 600, "p95_ms": 1200}},
                    },
                    "voice": {"total_p50_ms": 400, "total_p95_ms": 800, "groups": {"query": {"p95_ms": 300}}},
                }
            )
        )
        assert budgets.profiles["chat"].groups["query"].p95_ms == 1200
        assert budgets.profiles["voice"].groups["query"].p50_ms is None

    def test_groups_are_optional(self):
        assert LatencyBudgets.model_validate(_budgets()).profiles["chat"].groups == {}

    @pytest.mark.parametrize(
        "group",
        [
            {"p50_ms": 1300, "p95_ms": 1200},
            {"p50_ms": 0, "p95_ms": 1200},
            {"p50_ms": 600, "p95_ms": 0},
            {"p95_ms": -1},
            {"p50_ms": 600},
            {"p50_ms": 600, "p95_ms": 1200, "p99_ms": 1500},
        ],
    )
    def test_invalid_group_rejected(self, group):
        bad = _budgets(profiles={"chat": {"total_p50_ms": 1, "total_p95_ms": 2, "groups": {"query": group}}})
        with pytest.raises(ValidationError):
            LatencyBudgets.model_validate(bad)

    def test_committed_config_has_the_d29_query_budgets(self):
        budgets = LatencyBudgets.model_validate(json.loads(BUDGETS_PATH.read_text(encoding="utf-8")))
        d27 = {"condense": 600, "translate": 600, "expand": 700, "decompose": 800, "hyde": 900, "semantic_cache": 150}
        for name in ("chat", "embed"):
            profile = budgets.profiles[name]
            query = profile.groups["query"]
            assert (query.p50_ms, query.p95_ms) == (600, 1200)
            assert {key: profile.stages[key] for key in d27} == d27
        voice = budgets.profiles["voice"]
        assert (voice.groups["query"].p50_ms, voice.groups["query"].p95_ms) == (None, 300)
        assert voice.stages["condense"] == 300
        for transform in ("expand", "hyde", "decompose", "semantic_cache"):
            assert transform not in voice.stages


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


def _query_layer_payload(**overrides):
    base = {
        "items": 4,
        "items_with_plan": 4,
        "gate_rules": {"R1_PRONOUN": 3, "R9_KEYWORDS": 1},
        "transforms": {
            "condense": {"run": 3, "disabled": 0, "skipped": 0},
            "expand": {"run": 0, "disabled": 0, "skipped": 1, "skip_reasons": {"timeout": 1}},
        },
        "llm_transform_share": {"value": 0.5, "n": 4},
        "protected_token_losses": 1,
        "budget_profile": "chat",
        "query_budget": {"p50_ms": 600, "p95_ms": 1200},
        "query_latency": {"latency": {"p50_ms": 300.0, "p95_ms": 900.0, "n": 4}, "status": "within"},
        "query_latency_by_language": {"en": {"latency": {"p50_ms": 300.0, "p95_ms": 1300.0, "n": 2}, "status": "over"}},
        "query_latency_by_category": {},
    }
    base.update(overrides)
    return base


def _cache_payload(**overrides):
    base = {
        "checks": 4,
        "hits": 1,
        "misses": 3,
        "failures": 1,
        "bypasses": {"protected_tokens": 2},
        "hit_rate": {"value": 0.25, "n": 4},
        "hit_latency": {"p50_ms": 20.0, "p95_ms": 20.0, "n": 1},
        "miss_latency": {"p50_ms": 400.0, "p95_ms": 800.0, "n": 3},
        "near_miss_checks": 2,
        "near_miss_wrong_hits": 0,
        "near_miss_wrong_hit_rate": {"value": 0.0, "n": 2},
    }
    base.update(overrides)
    return base


class TestEvalReportQuerySections:
    def test_report_written_before_the_sections_still_parses(self):
        report = EvalReport(**_report_payload())
        assert report.query_layer is None and report.semantic_cache is None

    def test_filled_sections_round_trip(self):
        report = EvalReport(**_report_payload(query_layer=_query_layer_payload(), semantic_cache=_cache_payload()))
        assert report.query_layer.gate_rules["R1_PRONOUN"] == 3
        assert report.query_layer.transforms["expand"].skip_reasons == {"timeout": 1}
        assert report.semantic_cache.bypasses == {"protected_tokens": 2}
        assert EvalReport.model_validate(report.model_dump(mode="json")) == report

    @pytest.mark.parametrize(
        "section, payload",
        [
            ("query_layer", _query_layer_payload(protected_token_losses=-1)),
            ("query_layer", _query_layer_payload(query_latency={"latency": {"p50_ms": 1, "p95_ms": 2, "n": 1}, "status": "late"})),
            ("query_layer", _query_layer_payload(smuggled=1)),
            ("semantic_cache", _cache_payload(hits=-1)),
            ("semantic_cache", _cache_payload(query_text="x")),
        ],
    )
    def test_invalid_sections_rejected(self, section, payload):
        with pytest.raises(ValidationError):
            EvalReport(**_report_payload(**{section: payload}))

    def test_empty_sections_validate(self):
        report = EvalReport(
            **_report_payload(
                query_layer=_query_layer_payload(
                    items_with_plan=0,
                    gate_rules={},
                    transforms={},
                    llm_transform_share={"value": None, "n": 0},
                    protected_token_losses=0,
                    query_latency=None,
                    query_latency_by_language={},
                ),
                semantic_cache=_cache_payload(
                    checks=0, hits=0, misses=0, failures=0, bypasses={}, hit_rate={"value": None, "n": 0},
                    hit_latency=None, miss_latency=None, near_miss_checks=0, near_miss_wrong_hits=0,
                    near_miss_wrong_hit_rate=None,
                ),
            )
        )
        assert report.query_layer.items_with_plan == 0 and report.semantic_cache.checks == 0

    def test_samples_carry_both_sections_and_the_query_group(self):
        samples = build_samples()["samples"]
        report = EvalReport.model_validate(samples["EvalReport"])
        budgets = LatencyBudgets.model_validate(samples["LatencyBudgets"])
        assert report.query_layer is not None and report.semantic_cache is not None
        assert budgets.profiles["chat"].groups["query"].p95_ms == 1200
