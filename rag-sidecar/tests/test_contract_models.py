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
    MetricValue,
    NoiseConfig,
    RagRunOptions,
    SliceMetrics,
)

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
        "embedder_id": "fake-hash-embedder",
        "embedder_version": 1,
        "deployment_mode": "single",
        "request_options": RagRunOptions(max_results=None),
        "k_values": [5, 10],
        "overall": _slice_metrics(),
        "by_language": {"en": _slice_metrics()},
        "by_category": {"general": _slice_metrics()},
        "by_language_category": {"en/general": _slice_metrics()},
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
