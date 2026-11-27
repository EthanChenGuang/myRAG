from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.baseline import record_baseline
from rag_eval.gate import evaluate_gate
from rag_eval.metrics import aggregate, score_items
from rag_eval.paired import item_metrics, paired_report

DOC = "alpha.en.md"
NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"
BASE_METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
QUOTES = ("the first marker sentence", "the second marker sentence")
FILLER = "an unrelated filler sentence"
SUBQ_METRICS = ("all_evidence_recall_at_5", "all_evidence_recall_at_10", "subq_coverage_at_5", "subq_coverage_at_10")


def _span(quote: str) -> dict:
    return {"document": DOC, "section": "s", "quote": quote}


def _compound(item_id: str, *, language: str = "en", category: str = "scoped_compound") -> GoldenItem:
    return GoldenItem.model_validate(
        {
            "id": item_id,
            "question": "question",
            "language": language,
            "category": category,
            "answerable": True,
            "expected_answer": "answer",
            "gold_evidence": [_span(quote) for quote in QUOTES],
            "sub_questions": [{"index": index, "gold_spans": [_span(quote)]} for index, quote in enumerate(QUOTES)],
            "review_status": "approved",
            "provenance": "synthetic_fixture",
            "split": "dev",
        }
    )


def _plain(item_id: str) -> GoldenItem:
    return GoldenItem.model_validate(
        {
            "id": item_id,
            "question": "question",
            "language": "en",
            "category": "general",
            "answerable": True,
            "expected_answer": "answer",
            "gold_evidence": [_span(QUOTES[0])],
            "review_status": "approved",
            "provenance": "synthetic_fixture",
            "split": "dev",
        }
    )


def _trace(item_id: str, contents: list[str], *, refused: bool = False) -> RagTrace:
    return RagTrace.model_validate(
        {
            "item_id": item_id,
            "query": "q",
            "query_context": {
                "is_temporal_query": False,
                "is_financial_query": False,
                "required_precision": "low",
                "suggested_threshold": 0.3,
                "search_strategy": "semantic_only",
            },
            "retrieval_strategy": "standard",
            "candidates": [],
            "kept": [
                {
                    "rank": index,
                    "chunk_id": f"c{index}",
                    "document_id": "d-alpha",
                    "document_name": DOC,
                    "content": content,
                    "similarity": 0.5,
                    "kept_by": "similarity",
                }
                for index, content in enumerate(contents, start=1)
            ],
            "used_documents": [],
            "context": "",
            "refused": refused,
            "refusal_reason": "no_relevant_context" if refused else None,
            "citations": [],
            "stage_latency_ms": {},
            "effective_config": {
                "rag_env": {},
                "rag_prompt_sha256": {},
                "deployment_mode": "single",
                "embedding_model": "fixture",
                "endpoint_version": "1",
            },
            "config_hash": "0" * 64,
        }
    )


def _both_in_top5() -> list[str]:
    return [QUOTES[0], QUOTES[1], FILLER]


def _one_at_rank_7() -> list[str]:
    return [FILLER] * 6 + [QUOTES[1]]


def test_both_sub_questions_in_top5_hit_all_evidence_at_5_and_10():
    (result,) = score_items([_trace("sq-1", _both_in_top5())], [_compound("sq-1")])
    assert (result.subq_total, result.subq_hit_at_5, result.subq_hit_at_10) == (2, 2, 2)
    metrics = item_metrics(result)
    assert metrics.get("all_evidence_recall_at_5") == metrics.get("all_evidence_recall_at_10") == 1.0
    assert metrics.get("subq_coverage_at_5") == metrics.get("subq_coverage_at_10") == 1.0


def test_one_span_only_in_top10_misses_all_evidence_and_covers_one_at_10():
    (result,) = score_items([_trace("sq-1", _one_at_rank_7())], [_compound("sq-1")])
    assert (result.subq_total, result.subq_hit_at_5, result.subq_hit_at_10) == (2, 0, 1)
    metrics = item_metrics(result)
    assert (metrics.get("all_evidence_recall_at_5"), metrics.get("all_evidence_recall_at_10")) == (0.0, 0.0)
    assert (metrics.get("subq_coverage_at_5"), metrics.get("subq_coverage_at_10")) == (0.0, 0.5)


def test_refused_item_retrieves_no_sub_question():
    (result,) = score_items([_trace("sq-1", _both_in_top5(), refused=True)], [_compound("sq-1")])
    assert (result.subq_total, result.subq_hit_at_5, result.subq_hit_at_10) == (2, 0, 0)


def test_slice_reports_shares_over_sub_question_items_only():
    golden = [_compound("sq-1"), _compound("sq-2"), _compound("sq-3"), _plain("plain-1")]
    traces = [
        _trace("sq-1", _both_in_top5()),
        _trace("sq-2", _one_at_rank_7()),
        _trace("sq-3", [FILLER]),
        _trace("plain-1", [QUOTES[0]]),
    ]
    summary = aggregate(score_items(traces, golden))
    overall = summary["overall"]
    assert (overall.all_evidence_recall_at_5.value, overall.all_evidence_recall_at_5.n) == (1 / 3, 3)
    assert overall.all_evidence_recall_at_10.value == 1 / 3
    assert (overall.subq_coverage_at_5.value, overall.subq_coverage_at_5.n) == (2 / 6, 6)
    assert overall.subq_coverage_at_10.value == 3 / 6
    scoped = summary["by_category"]["scoped_compound"]
    assert scoped.all_evidence_recall_at_5.value == 1 / 3
    general = summary["by_category"]["general"]
    for field in SUBQ_METRICS:
        assert getattr(general, field) is None
    assert summary["by_language"]["en"].subq_coverage_at_10.value == 3 / 6


def test_slice_without_sub_question_items_reports_none_not_zero():
    summary = aggregate(score_items([_trace("plain-1", [QUOTES[0]])], [_plain("plain-1")]))
    for field in SUBQ_METRICS:
        assert getattr(summary["overall"], field) is None


def test_items_without_sub_questions_keep_their_old_fields_and_dump():
    (result,) = score_items([_trace("plain-1", [QUOTES[0]])], [_plain("plain-1")])
    assert (result.subq_total, result.subq_hit_at_5, result.subq_hit_at_10) == (None, None, None)
    assert not any(key.startswith("subq_") for key in result.model_dump())
    assert set(item_metrics(result)) == set(BASE_METRICS)
    overall = aggregate([result])["overall"].model_dump(mode="json")
    assert not any(key.startswith(("subq_", "all_evidence_")) for key in overall)


def test_report_tables_add_sub_question_columns_only_when_measured():
    from rag_eval.report import _table

    with_subq = aggregate(score_items([_trace("sq-1", _both_in_top5())], [_compound("sq-1")]))
    header = _table("Category", with_subq["by_category"])[0]
    assert "All-evidence@10" in header and "Sub-q coverage@5" in header
    plain = aggregate(score_items([_trace("plain-1", [QUOTES[0]])], [_plain("plain-1")]))
    assert "All-evidence" not in _table("Category", plain["by_category"])[0]


def _slice_values(**extra: dict | None) -> dict:
    values = {metric: {"value": 0.6, "n": 3} for metric in BASE_METRICS}
    values.update(extra)
    return values


def _report(items: list[ItemResult], categories: dict[str, dict]) -> EvalReport:
    return EvalReport.model_validate(
        {
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
            "overall": _slice_values(),
            "by_language": {},
            "by_category": categories,
            "by_language_category": {},
            "by_split": {},
            "items": [item.model_dump() for item in items],
        }
    )


def _stat(mean: float) -> dict:
    return {"mean": mean, "spread": 0.0, "runs": [mean, mean, mean], "n": 3}


def _baseline(slices: dict[str, dict], items: dict | None = None) -> Baseline:
    return Baseline.model_validate(
        {
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
            "slices": slices,
            "items": items,
        }
    )


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def _subq_cells(value: float) -> dict:
    return {metric: {"value": value, "n": 3} for metric in SUBQ_METRICS}


def _scoped_item(item_id: str, hit5: int, hit10: int) -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language="en",
        category="scoped_compound",
        split="dev",
        provenance="synthetic_fixture",
        answerable=True,
        refused=False,
        span_count=2,
        spans_hit_at_5=hit5,
        spans_hit_at_10=hit10,
        first_hit_rank=1 if hit10 else None,
        subq_total=2,
        subq_hit_at_5=hit5,
        subq_hit_at_10=hit10,
    )


def test_noise_config_gates_the_sub_question_metrics_and_categories():
    noise = _noise()
    for metric in SUBQ_METRICS:
        assert noise.metrics[metric] == "higher"
    assert "category:version_compare" in noise.gated_slice_prefixes
    assert "category:scoped_compound" in noise.gated_slice_prefixes
    assert "category:glossary" not in noise.gated_slice_prefixes


def test_baseline_without_the_new_metrics_passes_and_lists_them_as_not_gated():
    report = _report([], {"scoped_compound": _slice_values(**_subq_cells(0.1))})
    baseline = _baseline({"overall": {m: _stat(0.6) for m in BASE_METRICS}, "category:scoped_compound": {m: _stat(0.6) for m in BASE_METRICS}})
    result = evaluate_gate(report, baseline, _noise())
    assert result.passed and not result.offenders
    for metric in SUBQ_METRICS:
        assert f"category:scoped_compound:{metric} (not gated: no baseline)" in result.skipped


def test_baseline_with_the_new_metrics_fails_on_a_drop_beyond_the_band():
    slices = {
        "overall": {m: _stat(0.6) for m in BASE_METRICS},
        "category:scoped_compound": {**{m: _stat(0.6) for m in BASE_METRICS}, **{m: _stat(0.8) for m in SUBQ_METRICS}},
    }
    inside = _report([], {"scoped_compound": _slice_values(**_subq_cells(0.79))})
    assert evaluate_gate(inside, _baseline(slices), _noise()).passed
    dropped = _report([], {"scoped_compound": _slice_values(**_subq_cells(0.5))})
    result = evaluate_gate(dropped, _baseline(slices), _noise())
    assert not result.passed
    assert sorted((o.slice, o.metric) for o in result.offenders) == sorted(
        ("category:scoped_compound", metric) for metric in SUBQ_METRICS
    )


def test_other_category_slices_stay_report_only_for_the_new_metrics():
    slices = {
        "overall": {m: _stat(0.6) for m in BASE_METRICS},
        "category:compound": {**{m: _stat(0.6) for m in BASE_METRICS}, **{m: _stat(0.8) for m in SUBQ_METRICS}},
    }
    report = _report([], {"compound": _slice_values(**_subq_cells(0.1))})
    assert evaluate_gate(report, _baseline(slices), _noise()).passed


def test_no_sub_question_values_anywhere_adds_nothing_to_the_gate_output():
    report = _report([], {"general": _slice_values()})
    baseline = _baseline({"overall": {m: _stat(0.6) for m in BASE_METRICS}, "category:general": {m: _stat(0.6) for m in BASE_METRICS}})
    result = evaluate_gate(report, baseline, _noise())
    assert result.passed
    assert not any("subq" in entry or "all_evidence" in entry for entry in result.skipped)


def test_paired_report_pairs_sub_question_metrics_when_both_sides_carry_them():
    items = [_scoped_item("s1", 2, 2), _scoped_item("s2", 0, 1)]
    rows = {item.item_id: {m: [v] * 3 for m, v in item_metrics(item).items()} for item in items}
    report = _report(items, {"scoped_compound": _slice_values(**_subq_cells(0.5))})
    paired = paired_report(report, _baseline({}, rows), _noise())
    assert paired is not None and paired.all_zero
    cell = paired.slices["category:scoped_compound"]["subq_coverage_at_10"]
    assert (cell.n, cell.n_nonzero) == (2, 0)


def test_paired_report_omits_sub_question_cells_without_sub_question_items():
    item = ItemResult(
        item_id="g1", language="en", category="general", split="dev", provenance="synthetic_fixture",
        answerable=True, refused=False, span_count=1, spans_hit_at_5=1, spans_hit_at_10=1, first_hit_rank=1,
    )
    rows = {item.item_id: {m: [v] * 3 for m, v in item_metrics(item).items()}}
    paired = paired_report(_report([item], {"general": _slice_values()}), _baseline({}, rows), _noise())
    assert paired is not None
    assert set(paired.slices["overall"]) == set(BASE_METRICS)


def test_recorded_baseline_carries_sub_question_metrics_only_when_measured():
    scoped = [_scoped_item("s1", 2, 2)]
    with_subq = _report(scoped, {"scoped_compound": _slice_values(**_subq_cells(1.0))})
    baseline = record_baseline([with_subq] * 3)
    assert baseline.slices["category:scoped_compound"]["subq_coverage_at_5"].mean == 1.0
    assert baseline.items is not None and baseline.items["s1"]["all_evidence_recall_at_10"] == [1.0, 1.0, 1.0]
    assert "subq_coverage_at_5" not in baseline.slices["overall"]

    plain = _report([], {"general": _slice_values()})
    recorded = record_baseline([plain] * 3)
    for metrics in recorded.slices.values():
        assert set(metrics) == set(BASE_METRICS)
