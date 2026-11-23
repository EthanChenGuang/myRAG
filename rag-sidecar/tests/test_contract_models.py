import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import (
    Baseline,
    BaselineMetricStat,
    BaselineRun,
    EvalReport,
    GateOffender,
    GateResult,
    ItemResult,
    JudgeConfig,
    JudgeItemScore,
    JudgeReport,
    MetricValue,
    NoiseConfig,
    RagRunOptions,
    SidecarError,
    SidecarHealth,
    SidecarInfo,
    SidecarReady,
    SliceMetrics,
)
from rag_sidecar.export_schemas import CONTRACTS

METRICS = ["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]


def _metric(value=0.5, n=10):
    return {"value": value, "n": n}


def _slice_metrics():
    return {name: _metric() for name in METRICS}


def _item_result(**overrides):
    base = {
        "item_id": "en-general-001",
        "language": "en",
        "category": "general",
        "split": "dev",
        "answerable": True,
        "refused": False,
        "span_count": 2,
        "spans_hit_at_5": 1,
        "spans_hit_at_10": 2,
        "first_hit_rank": 3,
    }
    base.update(overrides)
    return base


def _report(**overrides):
    base = {
        "schema_version": 1,
        "run_id": "run-001",
        "tier": "smoke",
        "run_config_hash": "a" * 64,
        "corpus_sha256": "b" * 64,
        "golden_sha256": "c" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fake-hash-embedder",
        "embedder_version": 1,
        "deployment_mode": "single",
        "request_options": RagRunOptions(max_results=None),
        "k_values": [5, 10],
        "overall": _slice_metrics(),
        "by_language": {"en": _slice_metrics()},
        "by_category": {"general": _slice_metrics()},
        "by_language_category": {"en/general": _slice_metrics()},
        "by_split": {"dev": _slice_metrics()},
        "items": [_item_result()],
        "notes": [],
    }
    base.update(overrides)
    return base


def _stat(mean=0.8):
    return {"mean": mean, "spread": 0.0, "runs": [mean, mean, mean], "n": 10}


def _baseline_run(index=1):
    return {
        "run_id": f"run-{index}",
        "run_config_hash": "a" * 64,
        "git_sha": None,
        "created_at": "2026-01-01T00:00:00Z",
    }


def _baseline(runs=3, **overrides):
    base = {
        "schema_version": 1,
        "spread_kind": "stdev_ddof1",
        "corpus_sha256": "b" * 64,
        "golden_sha256": "c" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fake-hash-embedder",
        "embedder_version": 1,
        "run_config_hash": "a" * 64,
        "runs": [_baseline_run(i) for i in range(runs)],
        "slices": {"overall": {name: _stat() for name in METRICS}},
    }
    base.update(overrides)
    return base


class TestMetricValue:
    def test_empty_slice_is_representable_without_zero_or_nan(self):
        metric = MetricValue(value=None, n=0)
        assert metric.value is None
        assert metric.n == 0

    def test_negative_count_rejected(self):
        with pytest.raises(ValidationError):
            MetricValue(value=None, n=-1)

    def test_regular_value_accepted(self):
        assert MetricValue(value=0.25, n=4).value == 0.25


class TestEvalReport:
    def test_valid_report_accepted(self):
        report = EvalReport(**_report())
        assert report.overall.recall_at_5.n == 10
        assert report.by_language_category["en/general"].mrr.value == 0.5
        assert report.items[0].first_hit_rank == 3

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            EvalReport(**_report(smuggled="x"))

    def test_unknown_key_in_nested_slice_rejected(self):
        bad = _slice_metrics()
        bad["extra_metric"] = _metric()
        with pytest.raises(ValidationError):
            EvalReport(**_report(overall=bad))

    def test_report_is_frozen(self):
        report = EvalReport(**_report())
        with pytest.raises(ValidationError):
            report.run_id = "other"

    def test_unknown_tier_rejected(self):
        with pytest.raises(ValidationError):
            EvalReport(**_report(tier="weekly"))

    def test_item_result_first_hit_rank_optional_and_positive(self):
        assert ItemResult(**_item_result(first_hit_rank=None)).first_hit_rank is None
        with pytest.raises(ValidationError):
            ItemResult(**_item_result(first_hit_rank=0))

    def test_item_result_rejects_unknown_language(self):
        with pytest.raises(ValidationError):
            ItemResult(**_item_result(language="fr"))

    def test_slice_metrics_requires_all_five_metrics(self):
        partial = _slice_metrics()
        del partial["mrr"]
        with pytest.raises(ValidationError):
            SliceMetrics(**partial)


class TestBaseline:
    def test_three_runs_validate(self):
        baseline = Baseline(**_baseline(runs=3))
        assert len(baseline.runs) == 3
        assert baseline.slices["overall"]["mrr"].mean == 0.8

    def test_two_runs_rejected(self):
        with pytest.raises(ValidationError):
            Baseline(**_baseline(runs=2))

    def test_spread_kind_must_be_stdev_ddof1(self):
        with pytest.raises(ValidationError):
            Baseline(**_baseline(spread_kind="stdev_ddof0"))

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            Baseline(**_baseline(smuggled=True))

    def test_baseline_is_frozen(self):
        baseline = Baseline(**_baseline())
        with pytest.raises(ValidationError):
            baseline.golden_sha256 = "d" * 64

    def test_metric_stat_allows_empty_slice_and_rejects_negative_spread(self):
        stat = BaselineMetricStat(mean=None, spread=0.0, runs=[None, None, None], n=0)
        assert stat.mean is None
        with pytest.raises(ValidationError):
            BaselineMetricStat(mean=0.5, spread=-0.1, runs=[0.5], n=1)

    def test_baseline_run_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            BaselineRun(**_baseline_run(), smuggled=1)


class TestNoiseConfig:
    def test_defaults_are_the_decided_values(self):
        noise = NoiseConfig()
        assert noise.k == 3.0
        assert noise.floor == 0.02
        assert noise.gated_slice_prefixes == ["overall", "language:"]
        assert noise.schema_version == 1

    def test_false_refusal_rate_is_lower_is_better_by_default(self):
        noise = NoiseConfig()
        assert noise.metrics["false_refusal_rate"] == "lower"
        assert noise.metrics["recall_at_5"] == "higher"

    def test_unknown_direction_rejected(self):
        with pytest.raises(ValidationError):
            NoiseConfig(metrics={"mrr": "sideways"})

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            NoiseConfig(smuggled=1)


class TestGateResult:
    def test_passed_result_with_no_offenders(self):
        result = GateResult(passed=True, offenders=[], skipped=[], mismatches=[])
        assert result.passed is True

    def test_offender_round_trip(self):
        offender = GateOffender(
            slice="overall",
            metric="recall_at_5",
            baseline_mean=0.8,
            threshold=0.78,
            observed=0.5,
            direction="higher",
        )
        result = GateResult(passed=False, offenders=[offender], skipped=["category:table"], mismatches=[])
        assert result.offenders[0].observed == 0.5

    def test_offender_direction_rejected_when_unknown(self):
        with pytest.raises(ValidationError):
            GateOffender(
                slice="overall",
                metric="mrr",
                baseline_mean=0.8,
                threshold=0.78,
                observed=0.5,
                direction="up",
            )


def _judge_config(**overrides):
    base = {
        "judge_model": "vendor/judge-model",
        "judge_family": "vendor",
        "provider": "openrouter",
        "base_url": "https://openrouter.ai/api/v1",
        "temperature": 0,
        "embedding_model": "vendor/embedding-model",
    }
    base.update(overrides)
    return base


def _judge_item(**overrides):
    base = {
        "item_id": "en-general-001",
        "language": "en",
        "category": "general",
        "library": "deepeval",
        "metric": "faithfulness",
        "score": 0.9,
        "skipped_reason": None,
    }
    base.update(overrides)
    return base


def _judge_report(**overrides):
    base = {
        "schema_version": 1,
        "run_id": "run-001",
        "run_config_hash": "a" * 64,
        "judge_model": "vendor/judge-model",
        "judge_family": "vendor",
        "generator_model": "other/generator-model",
        "generator_family": "other",
        "items": [_judge_item()],
        "overall": {"deepeval.faithfulness": _metric(0.9, 1)},
        "by_language": {"en": {"deepeval.faithfulness": _metric(0.9, 1)}},
        "by_category": {"general": {"deepeval.faithfulness": _metric(0.9, 1)}},
    }
    base.update(overrides)
    return base


class TestJudgeConfig:
    def test_temperature_zero_validates_with_default_concurrency(self):
        config = JudgeConfig(**_judge_config())
        assert config.temperature == 0
        assert config.max_concurrency == 4

    def test_non_zero_temperature_rejected(self):
        with pytest.raises(ValidationError):
            JudgeConfig(**_judge_config(temperature=0.2))

    def test_provider_other_than_openrouter_rejected(self):
        with pytest.raises(ValidationError):
            JudgeConfig(**_judge_config(provider="openai"))

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            JudgeConfig(**_judge_config(seed=1))

    def test_frozen(self):
        config = JudgeConfig(**_judge_config())
        with pytest.raises(ValidationError):
            config.judge_model = "other"


class TestJudgeScores:
    def test_score_in_range_and_skipped_item_accepted(self):
        assert JudgeItemScore(**_judge_item(score=1.0)).score == 1.0
        skipped = JudgeItemScore(**_judge_item(score=None, skipped_reason="no_answer item"))
        assert skipped.score is None

    @pytest.mark.parametrize("score", [1.2, -0.1])
    def test_score_out_of_range_rejected(self, score):
        with pytest.raises(ValidationError):
            JudgeItemScore(**_judge_item(score=score))

    def test_metric_outside_the_three_rejected(self):
        with pytest.raises(ValidationError):
            JudgeItemScore(**_judge_item(metric="toxicity"))

    def test_library_outside_deepeval_ragas_rejected(self):
        with pytest.raises(ValidationError):
            JudgeItemScore(**_judge_item(library="trulens"))

    def test_report_valid_and_strict(self):
        report = JudgeReport(**_judge_report())
        assert report.overall["deepeval.faithfulness"].n == 1
        with pytest.raises(ValidationError):
            JudgeReport(**_judge_report(smuggled=1))

    def test_report_empty_slice_is_none_with_zero_count(self):
        report = JudgeReport(**_judge_report(overall={"ragas.context_recall": _metric(None, 0)}))
        assert report.overall["ragas.context_recall"].value is None


class TestSidecarContracts:
    def test_health_status_must_be_ok(self):
        assert SidecarHealth(status="ok").status == "ok"
        with pytest.raises(ValidationError):
            SidecarHealth(status="degraded")

    @pytest.mark.parametrize("status", ["ready", "not_ready"])
    def test_ready_accepts_ready_and_not_ready(self, status):
        assert SidecarReady(status=status).reason is None

    def test_ready_rejects_other_status(self):
        with pytest.raises(ValidationError):
            SidecarReady(status="starting")

    def test_info_service_must_be_rag_sidecar(self):
        info = SidecarInfo(service="rag-sidecar", version="0.1.0", contracts_schema_version=1)
        assert info.contracts_schema_version == 1
        with pytest.raises(ValidationError):
            SidecarInfo(service="other", version="0.1.0", contracts_schema_version=1)

    def test_error_requires_error_string_and_forbids_extras(self):
        assert SidecarError(error="boom").error == "boom"
        with pytest.raises(ValidationError):
            SidecarError(error="boom", detail="x")

    def test_sidecar_models_are_frozen(self):
        ready = SidecarReady(status="ready")
        with pytest.raises(ValidationError):
            ready.status = "not_ready"


class TestRegistry:
    @pytest.mark.parametrize(
        "name",
        [
            "EvalReport",
            "Baseline",
            "NoiseConfig",
            "GateResult",
            "JudgeConfig",
            "JudgeReport",
            "SidecarHealth",
            "SidecarReady",
            "SidecarInfo",
            "SidecarError",
        ],
    )
    def test_model_registered_in_serialization_mode(self, name):
        registered = {model.__name__: mode for model, mode in CONTRACTS}
        assert registered.get(name) == "serialization"
