import json
from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig, PairedReport
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.paired import RESAMPLES, SEED, item_metrics, main, paired_report

METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"


def _item(item_id: str, language="en", answerable=True, refused=False, span_count=1, hit5=0, hit10=0, rank=None, split="dev", category="general", provenance="synthetic_fixture") -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        split=split,
        provenance=provenance,
        answerable=answerable,
        refused=refused,
        span_count=span_count,
        spans_hit_at_5=hit5,
        spans_hit_at_10=hit10,
        first_hit_rank=rank,
    )


def _items() -> list[ItemResult]:
    return [
        _item("a1", span_count=4, hit5=2, hit10=2, rank=2),
        _item("a2", span_count=1, hit5=1, hit10=1, rank=1),
        _item("a3", language="zh"),
        _item("a4", language="zh", span_count=2, hit5=0, hit10=1, rank=7),
        _item("u1", language="zh", answerable=False, refused=True, span_count=0),
        _item("u2", language="en", answerable=False, refused=False, span_count=0),
        _item("t1", split="test", rank=1, hit5=1, hit10=1),
    ]


def _slice() -> dict:
    return {metric: {"value": 0.5, "n": 1} for metric in METRICS}


def _report(items: list[ItemResult], gate_population: str = "all") -> EvalReport:
    return EvalReport.model_validate(
        {
            "gate_population": gate_population,
            "run_id": "run-x",
            "tier": "smoke",
            "run_config_hash": "r" * 64,
            "corpus_sha256": "c" * 64,
            "golden_sha256": "g" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-embedder",
            "embedder_version": 3,
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            "overall": _slice(),
            "by_language": {"en": _slice(), "zh": _slice()},
            "by_category": {"general": _slice()},
            "by_language_category": {},
            "by_split": {},
            "items": [item.model_dump() for item in items],
        }
    )


def _baseline(rows: dict | None, **fields) -> Baseline:
    stat = {"mean": 0.5, "spread": 0.0, "runs": [0.5, 0.5, 0.5], "n": 1}
    data = {
        "spread_kind": "stdev_ddof1",
        "tier": "smoke",
        "deployment_mode": "single-tenant",
        "request_options": {},
        "corpus_sha256": "c" * 64,
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fixture-embedder",
        "embedder_version": 3,
        "run_config_hash": "r" * 64,
        "runs": [
            {"run_id": f"run-{i}", "run_config_hash": "r" * 64, "git_sha": None, "created_at": "2026-01-01T00:00:00Z"}
            for i in range(3)
        ],
        "slices": {"overall": {metric: stat for metric in METRICS}},
        "items": rows,
    }
    data.update(fields)
    return Baseline.model_validate(data)


def _rows(items: list[ItemResult], runs: int = 3) -> dict[str, dict[str, list[float | None]]]:
    return {item.item_id: {metric: [value] * runs for metric, value in item_metrics(item).items()} for item in items}


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def test_answerable_item_with_partial_hits_scores_recall_and_mrr():
    metrics = item_metrics(_item("a", span_count=4, hit5=2, hit10=3, rank=2))
    assert metrics == {
        "recall_at_5": 0.5,
        "recall_at_10": 0.75,
        "mrr": 0.5,
        "correct_refusal_rate": None,
        "false_refusal_rate": 0.0,
    }


def test_unanswerable_refused_item_scores_only_the_refusal_metric():
    metrics = item_metrics(_item("u", answerable=False, refused=True, span_count=0))
    assert metrics["correct_refusal_rate"] == 1.0
    assert metrics["false_refusal_rate"] is None
    assert [metrics[name] for name in ("recall_at_5", "recall_at_10", "mrr")] == [None, None, None]


def test_answerable_refused_item_counts_as_a_false_refusal_with_zero_recall():
    metrics = item_metrics(_item("a", span_count=2, refused=True))
    assert metrics["false_refusal_rate"] == 1.0
    assert (metrics["recall_at_5"], metrics["recall_at_10"], metrics["mrr"]) == (0.0, 0.0, 0.0)
    assert metrics["correct_refusal_rate"] is None


def test_report_equal_to_baseline_is_all_zero_with_a_degenerate_interval():
    items = _items()
    paired = paired_report(_report(items), _baseline(_rows(items)), _noise())
    assert isinstance(paired, PairedReport)
    assert (paired.seed, paired.resamples) == (SEED, RESAMPLES) == (20261123, 10000)
    assert paired.all_zero is True
    assert set(paired.slices) == {"overall", "language:en", "language:zh"}
    for metrics in paired.slices.values():
        assert set(metrics) == set(METRICS)
        for stat in metrics.values():
            assert stat.n_nonzero == 0
            if stat.n:
                assert (stat.mean_d, stat.ci_low, stat.ci_high) == (0.0, 0.0, 0.0)


def test_only_gate_split_items_are_paired():
    items = _items()
    paired = paired_report(_report(items), _baseline(_rows(items)), _noise())
    assert paired is not None
    assert paired.slices["overall"]["mrr"].n == 4
    assert paired.slices["overall"]["correct_refusal_rate"].n == 2
    assert paired.slices["language:zh"]["recall_at_5"].n == 2


def test_one_moved_item_gives_mean_difference_and_a_reproducible_interval():
    items = _items()
    baseline = _baseline(_rows(items))
    moved = [_item("a3", language="zh", span_count=1, hit5=1, hit10=1, rank=1) if item.item_id == "a3" else item for item in items]
    first = paired_report(_report(moved), baseline, _noise())
    second = paired_report(_report(moved), baseline, _noise())
    assert first is not None and first == second
    assert first.all_zero is False
    stat = first.slices["overall"]["mrr"]
    assert (stat.n, stat.n_nonzero, stat.mean_d) == (4, 1, 0.25)
    assert stat.ci_low is not None and stat.ci_high is not None
    assert 0.0 <= stat.ci_low <= 0.25 <= stat.ci_high <= 1.0
    assert first.slices["language:en"]["mrr"].n_nonzero == 0


def test_baseline_value_is_the_mean_over_recorded_runs():
    items = _items()
    rows = _rows(items)
    rows["a3"]["mrr"] = [0.0, 0.5, 0.25]
    moved = [_item("a3", language="zh", span_count=1, hit5=1, hit10=1, rank=2) if item.item_id == "a3" else item for item in items]
    paired = paired_report(_report(moved), _baseline(rows), _noise())
    assert paired is not None
    stat = paired.slices["language:zh"]["mrr"]
    assert (stat.n, stat.n_nonzero) == (2, 1)
    assert stat.mean_d == 0.125


def test_slice_without_applicable_items_reports_n_zero_and_no_interval():
    items = [item for item in _items() if item.answerable]
    paired = paired_report(_report(items), _baseline(_rows(items)), _noise())
    assert paired is not None
    stat = paired.slices["overall"]["correct_refusal_rate"]
    assert (stat.n, stat.n_nonzero, stat.mean_d, stat.ci_low, stat.ci_high) == (0, 0, None, None, None)
    assert paired.all_zero is True


def test_production_gate_population_pairs_only_production_items():
    items = [
        _item("p1", provenance="production", span_count=1, hit5=1, hit10=1, rank=1),
        _item("p2", provenance="production", language="zh", span_count=1, hit5=0, hit10=1, rank=6),
        _item("f1", provenance="synthetic_fixture", span_count=1, hit5=1, hit10=1, rank=1),
        _item("f2", provenance="synthetic_fixture", language="zh", span_count=1, hit5=1, hit10=1, rank=2),
        _item("f3", provenance="synthetic_fixture", answerable=False, refused=True, span_count=0),
    ]
    baseline = _baseline(_rows(items))

    production = paired_report(_report(items, "production"), baseline, _noise())
    everything = paired_report(_report(items, "all"), baseline, _noise())

    assert production is not None and everything is not None
    assert production.slices["overall"]["recall_at_5"].n == 2
    assert everything.slices["overall"]["recall_at_5"].n == 4
    assert production.slices["overall"]["correct_refusal_rate"].n == 0
    assert "language:en" in production.slices and production.slices["language:en"]["recall_at_5"].n == 1


def test_baseline_without_items_gives_no_paired_report():
    assert paired_report(_report(_items()), _baseline(None), _noise()) is None


def test_cli_writes_the_paired_report_json(tmp_path):
    items = _items()
    report_path = tmp_path / "report.json"
    baseline_path = tmp_path / "baseline.json"
    out_path = tmp_path / "out" / "paired.json"
    report_path.write_text(_report(items).model_dump_json(), encoding="utf-8")
    baseline_path.write_text(_baseline(_rows(items)).model_dump_json(), encoding="utf-8")

    code = main(["--report", str(report_path), "--baseline", str(baseline_path), "--noise", str(NOISE_PATH), "--out", str(out_path)])

    assert code == 0
    written = PairedReport.model_validate(json.loads(out_path.read_text(encoding="utf-8")))
    assert written.all_zero is True and written.seed == SEED
