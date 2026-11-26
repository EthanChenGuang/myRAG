import json
import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult, MetricValue

from rag_eval.metrics import aggregate, score_items

DOC = "refund-policy.en.md"


def _item(
    item_id: str,
    spans: list[tuple[str, str]] | None = None,
    *,
    language: str = "en",
    category: str | None = None,
    answerable: bool | None = None,
) -> GoldenItem:
    if answerable is None:
        answerable = spans is not None
    if category is None:
        category = "general" if answerable else "no_answer"
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category,
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": doc, "section": "s", "quote": quote} for doc, quote in (spans or [])],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _trace(item_id: str, kept: list[tuple[str, str]], *, refused: bool = False) -> RagTrace:
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
                    "document_id": f"d-{doc}",
                    "document_name": doc,
                    "content": content,
                    "similarity": 0.5,
                    "kept_by": "similarity",
                }
                for index, (doc, content) in enumerate(kept, start=1)
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


def _filler(count: int) -> list[tuple[str, str]]:
    return [(DOC, f"unrelated filler paragraph number {i}") for i in range(count)]


def test_two_spans_at_rank_5_and_6():
    item = _item("en-a-001", [(DOC, "alpha fact"), (DOC, "beta fact")])
    kept = _filler(4) + [(DOC, "the alpha fact holds")] + [(DOC, "and the beta fact too")]
    (result,) = score_items([_trace("en-a-001", kept)], [item])
    assert (result.span_count, result.spans_hit_at_5, result.spans_hit_at_10) == (2, 1, 2)
    assert result.first_hit_rank == 5
    metrics = aggregate([result])["overall"]
    assert metrics.recall_at_5.value == 0.5
    assert metrics.recall_at_10.value == 1.0
    assert metrics.mrr.value == 0.2


def test_rank_boundary_is_inclusive_at_k_and_exclusive_after():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    at_five = _trace("en-a-001", _filler(4) + [(DOC, "a gold sentence here")])
    at_six = _trace("en-a-001", _filler(5) + [(DOC, "a gold sentence here")])
    at_ten = _trace("en-a-001", _filler(9) + [(DOC, "a gold sentence here")])
    at_eleven = _trace("en-a-001", _filler(10) + [(DOC, "a gold sentence here")])
    got = {
        name: score_items([trace], [item])[0]
        for name, trace in {"5": at_five, "6": at_six, "10": at_ten, "11": at_eleven}.items()
    }
    assert (got["5"].spans_hit_at_5, got["5"].spans_hit_at_10) == (1, 1)
    assert (got["6"].spans_hit_at_5, got["6"].spans_hit_at_10) == (0, 1)
    assert (got["10"].spans_hit_at_5, got["10"].spans_hit_at_10) == (0, 1)
    assert (got["11"].spans_hit_at_5, got["11"].spans_hit_at_10) == (0, 0)
    assert got["11"].first_hit_rank == 11


def test_fewer_than_k_kept_chunks_are_scored_over_what_exists():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    (result,) = score_items([_trace("en-a-001", _filler(2) + [(DOC, "gold sentence")])], [item])
    assert result.first_hit_rank == 3
    metrics = aggregate([result])["overall"]
    assert metrics.recall_at_10.value == 1.0
    assert metrics.recall_at_5.value == 1.0


def test_span_order_does_not_change_the_result():
    spans = [(DOC, "alpha fact"), (DOC, "beta fact"), (DOC, "gamma fact")]
    kept = _filler(2) + [(DOC, "beta fact")] + _filler(3) + [(DOC, "alpha fact")]
    forward = score_items([_trace("en-a-001", kept)], [_item("en-a-001", spans)])
    backward = score_items([_trace("en-a-001", kept)], [_item("en-a-001", list(reversed(spans)))])
    assert forward == backward
    assert forward[0].spans_hit_at_5 == 1 and forward[0].spans_hit_at_10 == 2


def test_a_span_is_counted_once_even_if_several_chunks_match():
    item = _item("en-a-001", [(DOC, "gold sentence"), (DOC, "other fact")])
    kept = [(DOC, "gold sentence"), (DOC, "gold sentence again"), (DOC, "gold sentence a third time")]
    (result,) = score_items([_trace("en-a-001", kept)], [item])
    assert result.spans_hit_at_10 == 1
    assert aggregate([result])["overall"].recall_at_10.value == 0.5


def test_wrong_document_name_is_not_a_hit():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    (result,) = score_items([_trace("en-a-001", [("other.md", "gold sentence")])], [item])
    assert result.first_hit_rank is None


def test_refusal_rates_are_separate_and_refused_answerable_scores_zero():
    answerable = _item("en-a-001", [(DOC, "gold sentence")])
    answerable_ok = _item("en-a-002", [(DOC, "gold sentence")])
    refuse_ok = _item("en-n-001")
    refuse_missed = _item("en-n-002")
    traces = [
        _trace("en-a-001", [(DOC, "gold sentence")], refused=True),
        _trace("en-a-002", [(DOC, "gold sentence")]),
        _trace("en-n-001", [], refused=True),
        _trace("en-n-002", _filler(2)),
    ]
    results = score_items(traces, [answerable, answerable_ok, refuse_ok, refuse_missed])
    refused_answerable = results[0]
    assert refused_answerable.refused and refused_answerable.first_hit_rank is None
    assert (refused_answerable.spans_hit_at_5, refused_answerable.spans_hit_at_10) == (0, 0)
    overall = aggregate(results)["overall"]
    assert overall.false_refusal_rate.value == 0.5 and overall.false_refusal_rate.n == 2
    assert overall.correct_refusal_rate.value == 0.5 and overall.correct_refusal_rate.n == 2
    assert overall.recall_at_5.value == 0.5 and overall.recall_at_5.n == 2
    assert overall.mrr.value == 0.5 and overall.mrr.n == 2


def test_unrefused_no_answer_item_counts_toward_neither_numerator():
    results = score_items([_trace("en-n-001", _filler(3))], [_item("en-n-001")])
    overall = aggregate(results)["overall"]
    assert overall.correct_refusal_rate.value == 0.0 and overall.correct_refusal_rate.n == 1
    assert overall.false_refusal_rate.value is None and overall.false_refusal_rate.n == 0
    assert overall.recall_at_5.value is None and overall.recall_at_5.n == 0


def test_slice_with_no_unanswerable_items_reports_none_not_zero():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    result = score_items([_trace("en-a-001", [(DOC, "gold sentence")])], [item])
    for metrics in (aggregate(result)["overall"], aggregate(result)["by_language"]["en"]):
        assert metrics.correct_refusal_rate.value is None
        assert metrics.correct_refusal_rate.n == 0


def test_empty_results_give_none_everywhere():
    overall = aggregate([])["overall"]
    for metric in (overall.recall_at_5, overall.recall_at_10, overall.mrr, overall.correct_refusal_rate):
        assert metric.value is None and metric.n == 0


def test_chinese_italian_and_fullwidth_digit_chunks_are_hits():
    golds = [
        _item("zh-a-001", [("退款.zh.md", "七天内,无理由退货")], language="zh"),
        _item("it-a-001", [("garanzia.it.md", "perché la garanzia")], language="it"),
        _item("en-a-001", [(DOC, "12 days")]),
    ]
    traces = [
        _trace("zh-a-001", [("退款.zh.md", "退款政策：七天内，无理由退货。")]),
        _trace("it-a-001", [("garanzia.it.md", "PERCHÉ la garanzia dura due anni")]),
        _trace("en-a-001", [(DOC, "The window is １２ days.")]),
    ]
    results = score_items(traces, golds)
    assert [r.first_hit_rank for r in results] == [1, 1, 1]


def test_aggregate_keeps_full_float_precision():
    items = [_item(f"en-a-00{i}", [(DOC, "gold sentence")]) for i in range(1, 4)]
    traces = [
        _trace("en-a-001", [(DOC, "gold sentence")]),
        _trace("en-a-002", _filler(1)),
        _trace("en-a-003", _filler(1)),
    ]
    overall = aggregate(score_items(traces, items))["overall"]
    assert overall.recall_at_5.value == 1 / 3
    assert overall.mrr.value == 1 / 3
    assert overall.recall_at_5.n == 3


def test_mrr_averages_reciprocal_ranks_with_zero_for_misses():
    items = [_item(f"en-a-00{i}", [(DOC, "gold sentence")]) for i in range(1, 4)]
    traces = [
        _trace("en-a-001", [(DOC, "gold sentence")]),
        _trace("en-a-002", _filler(2) + [(DOC, "gold sentence")]),
        _trace("en-a-003", _filler(2)),
    ]
    overall = aggregate(score_items(traces, items))["overall"]
    assert overall.mrr.value == (1 + 1 / 3 + 0) / 3


def test_slices_by_language_category_and_their_cross_product():
    items = [
        _item("en-a-001", [(DOC, "gold sentence")], category="general"),
        _item("en-a-002", [(DOC, "gold sentence")], category="exact_term"),
        _item("zh-a-001", [("退款.zh.md", "七天无理由")], language="zh", category="general"),
        _item("zh-n-001", language="zh"),
    ]
    traces = [
        _trace("en-a-001", [(DOC, "gold sentence")]),
        _trace("en-a-002", _filler(1)),
        _trace("zh-a-001", [("退款.zh.md", "七天无理由")]),
        _trace("zh-n-001", [], refused=True),
    ]
    out = aggregate(score_items(traces, items))
    assert set(out["by_language"]) == {"en", "zh"}
    assert set(out["by_category"]) == {"general", "exact_term", "no_answer"}
    assert set(out["by_language_category"]) == {"en/general", "en/exact_term", "zh/general", "zh/no_answer"}
    assert out["by_language"]["en"].recall_at_5.value == 0.5
    assert out["by_language"]["zh"].correct_refusal_rate.value == 1.0
    assert out["by_language"]["en"].correct_refusal_rate.value is None
    assert out["by_language_category"]["zh/no_answer"].recall_at_5.value is None
    assert out["overall"].recall_at_5.n == 3


def test_results_follow_golden_order_and_are_item_results():
    items = [_item("en-b-002", [(DOC, "x1")]), _item("en-a-001", [(DOC, "x1")])]
    traces = [_trace("en-a-001", [(DOC, "x1")]), _trace("en-b-002", [(DOC, "x1")])]
    results = score_items(traces, items)
    assert [r.item_id for r in results] == ["en-b-002", "en-a-001"]
    assert all(isinstance(r, ItemResult) for r in results)


def test_missing_or_duplicate_trace_is_an_error_not_a_silent_skip():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    with pytest.raises(ValueError, match="en-a-001"):
        score_items([], [item])
    with pytest.raises(ValueError, match="en-a-001"):
        score_items([_trace("en-a-001", []), _trace("en-a-001", [])], [item])


def test_unsupported_k_values_are_rejected():
    with pytest.raises(ValueError):
        aggregate([], k_values=(3,))


def _result(item_id: str, provenance: str, *, category: str = "general", language: str = "en", split: str = "dev",
            answerable: bool = True, refused: bool = False, rank: int | None = 1) -> ItemResult:
    hit = 1 if rank is not None and rank <= 5 else 0
    return ItemResult(
        item_id=item_id,
        language=language,
        category=category,
        split=split,
        provenance=provenance,
        answerable=answerable,
        refused=refused,
        span_count=1 if answerable else 0,
        spans_hit_at_5=hit if answerable else 0,
        spans_hit_at_10=hit if answerable else 0,
        first_hit_rank=rank if answerable else None,
    )


def _mixed_results() -> list[ItemResult]:
    return [
        _result("s1", "synthetic_fixture", rank=1),
        _result("s2", "synthetic_fixture", category="typo", rank=None),
        _result("h1", "human", category="typo", rank=2),
        _result("h2", "human", category="no_answer", answerable=False, refused=True),
        _result("t1", "synthetic_fixture", split="test", rank=1),
    ]


def test_score_items_copies_provenance_from_the_golden_item():
    item = _item("en-a-001", [(DOC, "gold sentence")]).model_copy(update={"provenance": "human"})
    [result] = score_items([_trace("en-a-001", [(DOC, "gold sentence")])], [item])
    assert result.provenance == "human"


def test_aggregate_splits_every_metric_by_provenance_and_provenance_category():
    out = aggregate(_mixed_results())
    assert set(out["by_provenance"]) == {"synthetic_fixture", "human"}
    assert set(out["by_provenance_category"]) == {
        "synthetic_fixture/general",
        "synthetic_fixture/typo",
        "human/typo",
        "human/no_answer",
    }
    assert out["by_provenance"]["synthetic_fixture"].recall_at_5.n == 2
    assert out["by_provenance"]["synthetic_fixture"].recall_at_5.value == 0.5
    assert out["by_provenance"]["human"].correct_refusal_rate.value == 1.0
    assert out["by_provenance_category"]["human/typo"].mrr.value == 0.5
    assert out["gate_population"] == "all"


def test_without_production_items_the_gated_slices_cover_the_whole_dev_split():
    results = _mixed_results()
    out = aggregate(results)
    dev = [r for r in results if r.split == "dev"]
    assert out["overall"].recall_at_5.n == len([r for r in dev if r.answerable])
    assert set(out["by_language"]) == {"en"}
    assert set(out["by_category"]) == {"general", "typo", "no_answer"}
    assert out["gate_population"] == "all"


def test_production_items_become_the_gated_population_and_others_stay_report_only():
    results = [
        *_mixed_results(),
        _result("p1", "production", category="colloquial", rank=1),
        _result("p2", "production", category="colloquial", language="zh", rank=4),
    ]
    out = aggregate(results)
    assert out["gate_population"] == "production"
    assert out["overall"].recall_at_5.n == 2
    assert out["overall"].mrr.value == (1 + 0.25) / 2
    assert set(out["by_language"]) == {"en", "zh"}
    assert out["by_language"]["en"].recall_at_5.n == 1
    assert set(out["by_category"]) == {"colloquial"}
    assert set(out["by_provenance"]) == {"synthetic_fixture", "human", "production"}
    assert out["by_provenance"]["synthetic_fixture"].recall_at_5.n == 2
    assert out["by_provenance_category"]["production/colloquial"].recall_at_5.n == 2


def test_production_items_outside_the_gated_split_do_not_switch_the_population():
    results = [*_mixed_results(), _result("p1", "production", split="test", rank=1)]
    out = aggregate(results)
    assert out["gate_population"] == "all"
    assert out["overall"].recall_at_5.n == 3
    assert "production" not in out["by_provenance"]


def test_only_approved_production_items_count_when_approved_ids_are_given():
    results = [
        _result("s1", "synthetic_fixture"),
        _result("p1", "production", rank=1),
        _result("p2", "production", rank=None),
    ]
    out = aggregate(results, approved_ids=frozenset({"s1", "p1"}))
    assert out["gate_population"] == "production"
    assert out["overall"].recall_at_5.n == 1
    none_approved = aggregate(results, approved_ids=frozenset({"s1"}))
    assert none_approved["gate_population"] == "all"
    assert none_approved["overall"].recall_at_5.n == 3


# --- table_split (D-46, EVAL-18) ---------------------------------------------------------------------------------------

from rag_sidecar.contracts.eval_run import RagTrace as _RagTrace  # noqa: E402

from rag_eval.metrics import table_split_report  # noqa: E402

TABLE_DOC = "long-table-fixture.pdf"
HEADER = "Station | Sample | First value (cm) | Second value (cm) | Note"


def _table_item(
    item_id: str,
    row: str,
    *,
    language: str = "en",
    split: str = "dev",
    value: str = "42.5",
    distractors: tuple[str, ...] = ("17.25",),
    pending: bool = False,
) -> GoldenItem:
    payload: dict[str, object] = {
        "id": item_id,
        "question": "Which first value is listed for the synthetic sample row?",
        "language": language,
        "category": "table_split",
        "answerable": True,
        "expected_answer": f"{value} cm",
        "gold_evidence": [
            {"document": TABLE_DOC, "section": "Synthetic readings", "quote": row},
            {"document": TABLE_DOC, "section": "Synthetic readings", "quote": HEADER},
        ],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": split,
        "table_answer": {"value": value, "column": "First value (cm)", "distractor_values": list(distractors)},
    }
    if pending:
        payload["native_review"] = {"origin": "llm_drafted", "status": "pending"}
    return GoldenItem.model_validate(payload)


def _table_trace(item_id: str, kept: list[tuple[str, str]], *, answer: str | None = None, refused: bool = False) -> _RagTrace:
    trace = _trace(item_id, kept, refused=refused)
    return trace.model_copy(update={"answer": answer}) if answer is not None else trace


def _table_filler(count: int) -> list[tuple[str, str]]:
    return [(TABLE_DOC, f"Station Z{i} | Sample {i:02d} | 1{i}.0 | 2{i}.0 | none") for i in range(count)]


ROW_A = "Station A | Sample 07 | 42.5 | 17.25 | steady"
ROW_B = "Station B | Sample 31 | 42.5 | 17.25 | steady"


def test_table_split_row_recall_counts_rank_k_and_not_rank_k_plus_one():
    items = [_table_item(f"t-{rank:02d}", ROW_A) for rank in (5, 6, 10, 11)]
    traces = [_table_trace(item.id, _table_filler(rank - 1) + [(TABLE_DOC, ROW_A)]) for item, rank in zip(items, (5, 6, 10, 11))]
    report = table_split_report(traces, items)
    assert report is not None
    rows = {row.item_id: row for row in report.items}
    assert [rows[item.id].row_rank for item in items] == [5, 6, 10, 11]
    assert report.overall.row_recall_at_5.value == 0.25 and report.overall.row_recall_at_5.n == 4
    assert report.overall.row_recall_at_10.value == 0.75 and report.overall.row_recall_at_10.n == 4


def test_table_split_header_in_context_needs_the_header_inside_the_row_chunk():
    with_header = _table_item("t-with", ROW_A)
    without_header = _table_item("t-without", ROW_B)
    missing_row = _table_item("t-missing", "Station C | Sample 44 | 42.5 | 17.25 | steady")
    traces = [
        _table_trace("t-with", [(TABLE_DOC, f"{HEADER}\n|---|---|---|---|---|\n{ROW_A}")]),
        _table_trace("t-without", [(TABLE_DOC, HEADER), (TABLE_DOC, ROW_B)]),
        _table_trace("t-missing", [(TABLE_DOC, HEADER)]),
    ]
    report = table_split_report(traces, [with_header, without_header, missing_row])
    assert report is not None
    rows = {row.item_id: row for row in report.items}
    assert rows["t-with"].header_in_context is True
    assert rows["t-without"].header_in_context is False
    assert rows["t-missing"].row_rank is None and rows["t-missing"].header_in_context is None
    assert report.overall.header_in_context_rate.value == 0.5
    assert report.overall.header_in_context_rate.n == 2
    assert report.overall.row_recall_at_10.value == 2 / 3 and report.overall.row_recall_at_10.n == 3


def test_table_split_refused_trace_scores_no_row_hit():
    item = _table_item("t-refused", ROW_A)
    report = table_split_report([_table_trace("t-refused", [(TABLE_DOC, ROW_A)], refused=True)], [item])
    assert report is not None
    assert report.items[0].row_rank is None
    assert report.overall.row_recall_at_5.value == 0.0 and report.overall.header_in_context_rate.n == 0


def test_table_split_shuffled_item_order_changes_nothing_and_rows_sort_by_language_then_id():
    items = [
        _table_item("t-zh-02", ROW_A, language="zh", pending=True),
        _table_item("t-en-02", ROW_B),
        _table_item("t-it-01", ROW_A, language="it", pending=True),
        _table_item("t-en-01", ROW_A),
        _table_item("t-zh-01", ROW_B, language="zh", pending=True),
    ]
    rows = {"t-zh-02": ROW_A, "t-en-02": ROW_B, "t-it-01": ROW_A, "t-en-01": ROW_A, "t-zh-01": ROW_B}
    traces = [_table_trace(item_id, _table_filler(2) + [(TABLE_DOC, f"{HEADER}\n{row}")]) for item_id, row in rows.items()]
    forward = table_split_report(traces, items)
    backward = table_split_report(list(reversed(traces)), list(reversed(items)))
    assert forward is not None and forward == backward
    assert [(row.language, row.item_id) for row in forward.items] == [
        ("en", "t-en-01"),
        ("en", "t-en-02"),
        ("it", "t-it-01"),
        ("zh", "t-zh-01"),
        ("zh", "t-zh-02"),
    ]


def test_table_split_languages_without_counting_items_are_report_only_with_no_division_by_zero():
    items = [_table_item("t-en-01", ROW_A), _table_item("t-zh-01", ROW_A, language="zh", pending=True)]
    traces = [_table_trace(item.id, [(TABLE_DOC, f"{HEADER}\n{ROW_A}")]) for item in items]
    report = table_split_report(traces, items)
    assert report is not None
    assert sorted(report.by_language) == ["en", "it", "zh"]
    english, italian, chinese = report.by_language["en"], report.by_language["it"], report.by_language["zh"]
    assert (english.status, english.items, english.counting_items) == ("gated", 1, 1)
    assert (chinese.status, chinese.items, chinese.counting_items) == ("report_only", 1, 0)
    assert (italian.status, italian.items, italian.counting_items) == ("report_only", 0, 0)
    assert italian.row_recall_at_5.value is None and italian.row_recall_at_5.n == 0
    assert italian.header_in_context_rate.value is None and italian.header_in_context_rate.n == 0
    assert report.overall.counting_items == 1 and report.overall.status == "gated"


def test_table_split_test_split_items_do_not_count_in_the_gate():
    item = _table_item("t-en-test", ROW_A, split="test")
    report = table_split_report([_table_trace(item.id, [(TABLE_DOC, ROW_A)])], [item])
    assert report is not None
    assert report.by_language["en"].counting_items == 0 and report.by_language["en"].status == "report_only"
    assert report.items[0].counts_in_gate is False


def test_table_split_report_is_absent_without_table_split_items():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    assert table_split_report([_trace("en-a-001", [(DOC, "gold sentence")])], [item]) is None


def test_table_split_block_is_in_the_report_and_its_markdown_rows_are_sorted():
    from test_report_runner import _manifest

    from rag_eval.report import _render_markdown, build_report

    items = [
        _table_item("t-zh-01", ROW_A, language="zh", pending=True),
        _table_item("t-en-01", ROW_A),
        _table_item("t-it-01", ROW_B, language="it", pending=True),
    ]
    traces = [_table_trace(item.id, [(TABLE_DOC, f"{HEADER}\n{ROW_A}\n{ROW_B}")]) for item in items]
    report = build_report(_manifest(), score_items(traces, items), items, traces, supported_languages=("zh", "en", "it"))
    assert report.table_split is not None
    assert report.table_split.answer_mode is False
    assert report.table_split.overall.answer_correct_rate is None
    markdown = _render_markdown(report)
    section = markdown.split("## Table split", 1)[1].split("\n## ", 1)[0]
    assert "| overall | gated |" in section
    assert "| en | gated |" in section and "| zh | report-only |" in section and "| it | report-only |" in section
    assert "1.0000 (n=3)" in section
    assert "not run" in section
    order = [section.index(f"| {item_id} |") for item_id in ("t-en-01", "t-it-01", "t-zh-01")]
    assert order == sorted(order)


def test_report_without_table_split_items_has_no_table_split_key():
    from test_report_runner import _four_items, _manifest

    from rag_eval.report import build_report

    golden, traces = _four_items()
    report = build_report(_manifest(), score_items(traces, golden), golden, traces)
    assert report.table_split is None
    assert "table_split" not in report.model_dump(mode="json")


def test_table_split_answer_correct_rate_counts_ambiguous_and_empty_as_not_correct():
    items = [_table_item(f"t-en-{index}", ROW_A) for index in range(1, 6)]
    answers = {
        "t-en-1": "The first value is 42.5 cm.",
        "t-en-2": "The first value is 42,50.",
        "t-en-3": "It is 42.5 or 17.25.",
        "t-en-4": "It is 17.25.",
        "t-en-5": "",
    }
    traces = [_table_trace(item_id, [(TABLE_DOC, ROW_A)], answer=answer) for item_id, answer in answers.items()]
    report = table_split_report(traces, items)
    assert report is not None and report.answer_mode is True
    verdicts = {row.item_id: row.answer_verdict for row in report.items}
    assert verdicts == {"t-en-1": "correct", "t-en-2": "correct", "t-en-3": "ambiguous", "t-en-4": "wrong", "t-en-5": "wrong"}
    assert report.overall.answer_correct_rate is not None
    assert report.overall.answer_correct_rate.value == 0.4 and report.overall.answer_correct_rate.n == 5


def test_table_split_answer_mode_scores_a_refused_or_unanswered_item_as_wrong():
    items = [_table_item("t-en-1", ROW_A), _table_item("t-en-2", ROW_A), _table_item("t-en-3", ROW_A)]
    traces = [
        _table_trace("t-en-1", [(TABLE_DOC, ROW_A)], answer="42.5"),
        _table_trace("t-en-2", [(TABLE_DOC, ROW_A)], answer="42.5", refused=True),
        _table_trace("t-en-3", [(TABLE_DOC, ROW_A)]),
    ]
    report = table_split_report(traces, items)
    assert report is not None and report.answer_mode is True
    assert [row.answer_verdict for row in report.items] == ["correct", "wrong", "wrong"]
    assert report.overall.answer_correct_rate == report.by_language["en"].answer_correct_rate
    assert report.by_language["it"].answer_correct_rate is not None
    assert report.by_language["it"].answer_correct_rate.value is None and report.by_language["it"].answer_correct_rate.n == 0


def test_table_split_without_answers_reports_the_answer_check_as_not_run():
    item = _table_item("t-en-1", ROW_A)
    report = table_split_report([_table_trace("t-en-1", [(TABLE_DOC, ROW_A)])], [item])
    assert report is not None and report.answer_mode is False
    assert report.overall.answer_correct_rate is None
    assert all(row.answer_verdict is None for row in report.items)


# --- table_split gate and re-baseline (D-45, D-46) ---------------------------------------------------------------------

def test_table_split_is_gated_and_the_re_recorded_ingest_baseline_leaves_every_old_slice_and_item_unchanged():
    from pathlib import Path

    from rag_sidecar.contracts.baseline import Baseline, NoiseConfig

    from rag_eval.native_review import counts_in_gated_slices
    from rag_eval.paired import is_gated_slice

    root = Path(__file__).resolve().parents[1]
    noise = NoiseConfig.model_validate_json((root / "config" / "noise.json").read_text(encoding="utf-8"))
    assert is_gated_slice("category:table_split", noise)
    assert not is_gated_slice("category:table", noise)

    previous = Baseline.model_validate_json(
        (root / "baselines" / "history" / "fixture-ingest-baseline.pre-03.2-32.json").read_text(encoding="utf-8")
    )
    # The 03.2-67 record, kept in history when plan 04.1.1-10 added the term items; test_the_04_1_1_10_baseline_adds_only_term_items_and_moves_no_old_item
    # compares it with the committed baseline.
    current = Baseline.model_validate_json(
        (root / "baselines" / "history" / "fixture-ingest-baseline.pre-04.1.1-10.json").read_text(encoding="utf-8")
    )
    assert len(current.runs) >= 3
    assert {run.run_id for run in current.runs}.isdisjoint({run.run_id for run in previous.runs}), "not re-recorded"
    assert current.corpus_sha256 == previous.corpus_sha256
    assert previous.items is not None and current.items is not None
    # Plan 06-39 later added the cache pair golden items: they bring their own category slices and move only
    # the overall and language slices, so those are compared only while the golden set is the one 03.2-32 recorded.
    cache_categories = {"cache_paraphrase", "cache_near_miss"}
    golden_categories = {
        item.id: item.category
        for item in (
            GoldenItem.model_validate_json(line)
            for line in (root / "fixtures" / "golden.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    }
    added = set(current.items) - set(previous.items)
    golden_grew = current.golden_sha256 != previous.golden_sha256
    if golden_grew:
        assert added and {golden_categories.get(item_id) for item_id in added} <= cache_categories
    else:
        assert not added
    moved = {"overall"} | {name for name in previous.slices if name.startswith("language:")}
    # Plan 03.2-67 flipped the default of RAG_TABLE_HEADER_REPEAT to always: only table_split items moved, so the slices that hold
    # them and those items are compared by test_the_03_2_67_baseline_moves_only_table_split_items_and_none_drops.
    header_moved = moved | {"category:table_split"}
    table_split_ids = {item_id for item_id in previous.items if item_id.startswith("ingest-table-split-")}
    for name, stats in previous.slices.items():
        if (golden_grew and name in moved) or name in header_moved:
            continue
        assert current.slices[name] == stats, name
    unchanged = set(previous.items) - table_split_ids
    assert {item_id: current.items[item_id] for item_id in unchanged} == {item_id: previous.items[item_id] for item_id in unchanged}
    assert all(stat.spread == 0.0 for stats in current.slices.values() for stat in stats.values())

    golden = [
        GoldenItem.model_validate_json(line)
        for line in (root / "fixtures" / "ingest" / "golden-ingest.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    table_items = [item for item in golden if item.category == "table_split"]
    counting = [item for item in table_items if item.split == current.golden_filter.gate_split and counts_in_gated_slices(item)]
    assert counting and {item.language for item in counting} == {"en"}
    assert all(not counts_in_gated_slices(item) for item in table_items if item.language in {"zh", "it"})
    gated = current.slices["category:table_split"]
    assert gated["recall_at_5"].n == len(counting)


# --- Phase 4.2 plan 12: evidence groups, nDCG at context k, redundancy, intent coverage ---

FLOOD_DOC = "flood-copy-{index}.en.md"


def _grouped_item(item_id: str = "en-flood-001") -> GoldenItem:
    spans = [(FLOOD_DOC.format(index=index), "the shared passage statement") for index in range(30)]
    spans.append((DOC, "the single passage statement"))
    item = _item(item_id, spans, category="duplicate_flood")
    return item.model_copy(update={"evidence_groups": [list(range(30)), [30]]})


def _with_clusters(trace: RagTrace, clusters: list[str | None]) -> RagTrace:
    kept = [
        chunk.model_copy(update={"dup_cluster_id": cluster}) for chunk, cluster in zip(trace.kept, clusters, strict=True)
    ]
    return trace.model_copy(update={"kept": kept})


def test_evidence_groups_count_a_group_once_when_any_span_is_kept():
    item = _grouped_item()
    kept = [(FLOOD_DOC.format(index=7), "the shared passage statement"), (DOC, "the single passage statement")]
    (result,) = score_items([_trace(item.id, kept)], [item])
    assert result.group_count == 2
    assert (result.span_count, result.spans_hit_at_5, result.spans_hit_at_10) == (2, 2, 2)
    assert result.intent_coverage is True
    assert aggregate([result])["overall"].recall_at_10.value == 1.0


def test_evidence_groups_with_one_group_missing_halve_recall_and_lose_intent_coverage():
    item = _grouped_item()
    kept = [(FLOOD_DOC.format(index=3), "the shared passage statement")] + _filler(3)
    (result,) = score_items([_trace(item.id, kept)], [item])
    assert result.group_count == 2
    assert result.intent_coverage is False
    assert aggregate([result])["overall"].recall_at_10.value == 0.5
    assert aggregate([result])["overall"].mrr.value == 1.0


def test_item_without_evidence_groups_has_no_group_fields():
    item = _item("en-a-001", [(DOC, "alpha fact"), (DOC, "beta fact")])
    (result,) = score_items([_trace("en-a-001", [(DOC, "alpha fact")])], [item])
    assert result.group_count is None
    assert result.intent_coverage is None
    assert (result.span_count, result.spans_hit_at_5, result.first_hit_rank) == (2, 1, 1)


def test_ndcg_at_context_k_uses_the_kept_chunks():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    (first,) = score_items([_trace("en-a-001", [(DOC, "gold sentence")] + _filler(3))], [item])
    assert (first.context_k, first.ndcg_at_context_k) == (4, 1.0)
    (second,) = score_items([_trace("en-a-001", _filler(1) + [(DOC, "gold sentence")])], [item])
    assert second.context_k == 2
    assert second.ndcg_at_context_k == pytest.approx(1 / __import__("math").log2(3))


def test_refused_or_empty_context_scores_ndcg_zero_and_counts_in_k_zero():
    golden = [_item("en-a-001", [(DOC, "gold sentence")]), _item("en-a-002", [(DOC, "gold sentence")])]
    traces = [_trace("en-a-001", [(DOC, "gold sentence")], refused=True), _trace("en-a-002", [])]
    results = score_items(traces, golden)
    assert [(r.context_k, r.ndcg_at_context_k) for r in results] == [(0, 0.0), (0, 0.0)]
    overall = aggregate(results)["overall"]
    assert overall.ndcg_at_context_k == MetricValue(value=0.0, n=2)
    assert overall.k_zero == MetricValue(value=2.0, n=2)


def test_unanswerable_items_carry_no_ndcg():
    (result,) = score_items([_trace("en-n-001", [], refused=True)], [_item("en-n-001")])
    assert result.ndcg_at_context_k is None
    overall = aggregate([result])["overall"]
    assert overall.ndcg_at_context_k is None and overall.k_zero is None


def test_topk_redundancy_is_the_largest_cluster_share_of_kept_chunks():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    clustered = _with_clusters(_trace("en-a-001", _filler(8)), ["c1"] * 5 + ["c2", None, None])
    (result,) = score_items([clustered], [item])
    assert result.topk_redundancy == 0.625
    (plain,) = score_items([_trace("en-a-001", _filler(8))], [item])
    assert plain.topk_redundancy == 0.125
    (empty,) = score_items([_trace("en-a-001", [])], [item])
    assert empty.topk_redundancy is None


def test_slice_means_redundancy_and_rates_intent_coverage():
    flood = _grouped_item("en-flood-001")
    flood_two = _grouped_item("en-flood-002")
    covered = [(FLOOD_DOC.format(index=1), "the shared passage statement"), (DOC, "the single passage statement")]
    missed = [(FLOOD_DOC.format(index=1), "the shared passage statement")] * 4
    traces = [
        _with_clusters(_trace(flood.id, covered), ["k1", None]),
        _with_clusters(_trace(flood_two.id, missed), ["k1"] * 4),
    ]
    overall = aggregate(score_items(traces, [flood, flood_two]))["overall"]
    assert overall.topk_redundancy == MetricValue(value=0.75, n=2)
    assert overall.intent_coverage == MetricValue(value=0.5, n=2)


def test_slice_without_group_items_has_no_intent_coverage():
    item = _item("en-a-001", [(DOC, "gold sentence")])
    overall = aggregate(score_items([_trace("en-a-001", [(DOC, "gold sentence")])], [item]))["overall"]
    assert overall.intent_coverage is None
    assert overall.topk_redundancy == MetricValue(value=1.0, n=1)


def _reference_ranks(item: GoldenItem, ranked) -> list[int]:
    """The span loop of score_items before plan 04.2-12, kept verbatim as the oracle for items without groups."""
    from rag_eval.matching import chunk_matches_span

    ranks: list[int] = []
    for span in item.gold_evidence:
        for position, chunk in enumerate(ranked, start=1):
            if chunk_matches_span(getattr(chunk, "document_name", None) or "", chunk.content, span):
                ranks.append(position)
                break
    return ranks


def _reference_gated(results: list[ItemResult], traces: list[RagTrace], golden: list[GoldenItem], rank_field: str):
    by_id = {trace.item_id: trace for trace in traces}
    for result, item in zip(results, golden, strict=True):
        trace = by_id[item.id]
        ranked = trace.kept if rank_field == "kept" else trace.candidates
        ranks = [] if trace.refused else _reference_ranks(item, ranked)
        assert result.span_count == len(item.gold_evidence), item.id
        assert result.spans_hit_at_5 == sum(1 for r in ranks if r <= 5), item.id
        assert result.spans_hit_at_10 == sum(1 for r in ranks if r <= 10), item.id
        assert result.first_hit_rank == (min(ranks) if ranks else None), item.id


@pytest.mark.parametrize("rank_field", ["kept", "candidates"])
def test_items_without_groups_score_exactly_as_before(rank_field):
    import random

    rng = random.Random(4212)
    words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    golden: list[GoldenItem] = []
    traces: list[RagTrace] = []
    for index in range(60):
        item_id = f"en-r-{index:03d}"
        spans = [(DOC, f"{word} fact") for word in rng.sample(words, rng.randint(1, 3))]
        answerable = index % 7 != 0
        golden.append(_item(item_id, spans if answerable else None))
        rows = [(DOC, f"{rng.choice(words)} fact") if rng.random() < 0.3 else _filler(1)[0] for _ in range(rng.randint(0, 14))]
        trace = _trace(item_id, rows, refused=index % 11 == 0)
        if rank_field == "candidates":
            candidates = [
                {**chunk.model_dump(mode="json", include={"rank", "chunk_id", "document_id", "document_name", "content", "similarity"}), "has_image": False}
                for chunk in reversed(trace.kept)
            ]
            trace = RagTrace.model_validate({**trace.model_dump(mode="json"), "candidates": candidates})
        traces.append(trace)
    results = score_items(traces, golden, rank_field=rank_field)
    _reference_gated(results, traces, golden, rank_field)


# --- Phase 4.2 plan 12: identifier precision and near-miss leakage (D-32) ---

ID_DOC = "identifiers.en.md"


def _identifier_item(item_id: str, asked: str | None, *, answerable: bool = True) -> GoldenItem:
    item = _item(item_id, [(ID_DOC, "the asked record")], category="identifier_near_miss")
    update: dict[str, object] = {"tags": [f"asked_identifier:{asked}"] if asked is not None else []}
    if not answerable:
        # D-32 no-answer identifier items; the GoldenItem category rule does not admit them yet (hand-off 04.2-12-golden-rule).
        update.update(answerable=False, expected_answer=None, gold_evidence=[])
    return item.model_copy(update=update)


def _identifier_trace(item_id: str, chunks: list[list[str] | None], *, refused: bool = False, cited: list[int] = ()):
    trace = _trace(item_id, [(ID_DOC, f"the asked record part {index}") for index in range(len(chunks))], refused=refused)
    kept = [chunk.model_copy(update={"identifiers_norm": ids}) for chunk, ids in zip(trace.kept, chunks, strict=True)]
    citations = [
        {
            "alias": f"S{position + 1}",
            "chunkIds": [kept[position].chunk_id],
            "documentId": kept[position].document_id,
            "documentName": ID_DOC,
            "n": position + 1,
            "quote": kept[position].content,
            "quoteHash": "a" * 64,
            "strategy": "chunk-alias",
        }
        for position in cited
    ]
    return RagTrace.model_validate(
        {**trace.model_dump(mode="json"), "kept": [k.model_dump(mode="json") for k in kept], "citations": citations}
    )


def test_answerable_identifier_item_is_precise_when_only_the_asked_identifier_is_kept():
    item = _identifier_item("en-id-001", "QX-4471")
    (result,) = score_items([_identifier_trace(item.id, [["qx4471"], ["other99"]], cited=[0])], [item])
    assert (result.identifier_precise, result.near_miss_leak) == (True, False)


def test_a_near_miss_chunk_without_the_asked_identifier_leaks():
    item = _identifier_item("en-id-001", "qx 4471")
    (result,) = score_items([_identifier_trace(item.id, [["qx4471"], ["qx4472"]])], [item])
    assert (result.identifier_precise, result.near_miss_leak) == (False, True)


def test_a_chunk_holding_both_the_asked_and_a_near_miss_identifier_does_not_leak():
    item = _identifier_item("en-id-001", "QX4471")
    (result,) = score_items([_identifier_trace(item.id, [["qx4471", "qx4472"]])], [item])
    assert (result.identifier_precise, result.near_miss_leak) == (True, False)


def test_citing_a_chunk_without_the_asked_identifier_is_not_precise():
    item = _identifier_item("en-id-001", "QX4471")
    (result,) = score_items([_identifier_trace(item.id, [["qx4471"], ["lm9902"]], cited=[0, 1])], [item])
    assert (result.identifier_precise, result.near_miss_leak) == (False, False)


def test_answerable_item_without_a_kept_asked_identifier_is_not_precise():
    item = _identifier_item("en-id-001", "QX4471")
    (result,) = score_items([_identifier_trace(item.id, [["lm9902"]])], [item])
    assert result.identifier_precise is False


def test_no_answer_identifier_item_is_precise_only_when_refused_without_leak():
    item = _identifier_item("en-id-002", "QX4479", answerable=False)
    (refused,) = score_items([_identifier_trace(item.id, [], refused=True)], [item])
    assert (refused.identifier_precise, refused.near_miss_leak) == (True, False)
    (answered,) = score_items([_identifier_trace(item.id, [["lm9902"]])], [item])
    assert answered.identifier_precise is False
    (leaked,) = score_items([_identifier_trace(item.id, [["qx4471"]], refused=True)], [item])
    assert (leaked.identifier_precise, leaked.near_miss_leak) == (False, True)


def test_identifier_item_without_the_asked_tag_is_a_scoring_error():
    item = _identifier_item("en-id-009", None)
    with pytest.raises(ValueError, match="en-id-009"):
        score_items([_identifier_trace(item.id, [["qx4471"]])], [item])


def test_traces_without_identifiers_norm_give_no_identifier_values():
    item = _identifier_item("en-id-001", "QX4471")
    (result,) = score_items([_identifier_trace(item.id, [["qx4471"], None])], [item])
    assert (result.identifier_precise, result.near_miss_leak) == (None, None)


def test_identifier_slices_count_identifier_items_only():
    golden = [
        _identifier_item("en-id-001", "QX4471"),
        _identifier_item("en-id-002", "QX4471"),
        _item("en-a-001", [(DOC, "gold sentence")]),
    ]
    traces = [
        _identifier_trace("en-id-001", [["qx4471"]]),
        _identifier_trace("en-id-002", [["qx4471"], ["qx4417"]]),
        _trace("en-a-001", [(DOC, "gold sentence")]),
    ]
    results = score_items(traces, golden)
    assert results[2].identifier_precise is None and results[2].near_miss_leak is None
    overall = aggregate(results)["overall"]
    assert overall.identifier_precision == MetricValue(value=0.5, n=2)
    assert overall.near_miss_leakage == MetricValue(value=0.5, n=2)


def test_the_03_2_67_baseline_moves_only_table_split_items_and_none_drops():
    """D-19 (plan 03.2-67): the ingest baseline re-recorded with RAG_TABLE_HEADER_REPEAT=always as the default."""
    from pathlib import Path

    from rag_sidecar.contracts.baseline import Baseline

    root = Path(__file__).resolve().parents[1]
    previous = Baseline.model_validate_json(
        (root / "baselines" / "history" / "fixture-ingest-baseline.pre-03.2-67.json").read_text(encoding="utf-8")
    )
    # The 03.2-67 record, kept in history when plan 04.1.1-10 added the term items; test_the_04_1_1_10_baseline_adds_only_term_items_and_moves_no_old_item
    # compares it with the committed baseline.
    current = Baseline.model_validate_json(
        (root / "baselines" / "history" / "fixture-ingest-baseline.pre-04.1.1-10.json").read_text(encoding="utf-8")
    )
    decision = json.loads((root / "decisions" / "03.2-table-header-default.json").read_text(encoding="utf-8"))
    assert decision["decision"] == "always"
    assert {run.run_id for run in current.runs}.isdisjoint({run.run_id for run in previous.runs}), "not re-recorded"
    assert current.corpus_sha256 == previous.corpus_sha256 and current.golden_sha256 == previous.golden_sha256
    assert previous.items is not None and current.items is not None
    assert set(current.items) == set(previous.items)
    moved = sorted(item_id for item_id in previous.items if current.items[item_id] != previous.items[item_id])
    assert moved and all(item_id.startswith("ingest-table-split-") for item_id in moved), moved
    lower_is_better = {"false_refusal_rate"}
    for item_id in moved:
        for metric, before in previous.items[item_id].items():
            after = current.items[item_id][metric]
            for old, new in zip(before, after):
                if old is None or new is None:
                    assert old == new, (item_id, metric)
                elif metric in lower_is_better:
                    assert new <= old, (item_id, metric)
                else:
                    assert new >= old, (item_id, metric)
    assert all(stat.spread == 0.0 for stats in current.slices.values() for stat in stats.values())


# The prechunked corpus hash before plan 04.1.1-10 added the three synthetic-terms files.
PRE_TERMS_CORPUS_SHA256 = "2d1e198f73a6aba71d94eac166fc21f92853113267cfe00be6659e6c6010ca04"
TERM_CORPUS_FILES = {"en/synthetic-terms.en.md", "it/synthetic-terms.it.md", "zh/synthetic-terms.zh.md"}


def test_the_04_1_1_10_baseline_adds_only_term_items_and_moves_no_old_item(tmp_path):
    """Plan 04.1.1-10: the ingest baseline re-recorded with the term fixtures; every earlier item and slice is unchanged."""
    import shutil
    from pathlib import Path

    from rag_sidecar.contracts.baseline import Baseline

    from rag_eval.corpus import corpus_sha256

    root = Path(__file__).resolve().parents[1]
    previous = Baseline.model_validate_json(
        (root / "baselines" / "history" / "fixture-ingest-baseline.pre-04.1.1-10.json").read_text(encoding="utf-8")
    )
    current = Baseline.model_validate_json((root / "baselines" / "fixture-ingest-baseline.json").read_text(encoding="utf-8"))
    assert len(current.runs) >= 3
    assert {run.run_id for run in current.runs}.isdisjoint({run.run_id for run in previous.runs}), "not re-recorded"

    corpus = root / "fixtures" / "corpus"
    for relpath in TERM_CORPUS_FILES:
        assert (corpus / relpath).is_file(), relpath
    without_terms = tmp_path / "corpus"
    shutil.copytree(corpus, without_terms)
    for relpath in TERM_CORPUS_FILES:
        (without_terms / relpath).unlink()
    assert corpus_sha256(without_terms) == PRE_TERMS_CORPUS_SHA256
    assert current.corpus_sha256 != previous.corpus_sha256 and current.golden_sha256 != previous.golden_sha256

    assert previous.items is not None and current.items is not None
    assert {item_id: current.items[item_id] for item_id in previous.items} == previous.items
    golden = {
        item.id: item
        for item in (
            GoldenItem.model_validate_json(line)
            for line in (root / "fixtures" / "golden.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    }
    added = set(current.items) - set(previous.items)
    assert added and all("-term-" in item_id for item_id in added), sorted(added)
    added_categories = {golden[item_id].category for item_id in added}
    assert added_categories == {"colloquial", "no_answer"}
    moved = {"overall"} | {name for name in previous.slices if name.startswith("language:")}
    moved |= {f"category:{category}" for category in added_categories}
    assert set(current.slices) == set(previous.slices)
    for name, stats in previous.slices.items():
        if name in moved:
            continue
        assert current.slices[name] == stats, name
    assert all(stat.spread == 0.0 for stats in current.slices.values() for stat in stats.values())


def _answer_trace(item_id: str, *, refused: bool = False, answer: str | None = None) -> RagTrace:
    trace = _trace(item_id, [], refused=refused)
    return trace.model_copy(update={"answer": answer})


def _no_answer_results(refused: int, total: int, *, language: str = "en") -> list[ItemResult]:
    golden = [_item(f"{language}-na-{i:03d}", language=language) for i in range(total)]
    traces = [_trace(item.id, [], refused=i < refused) for i, item in enumerate(golden)]
    return score_items(traces, golden)


def test_false_answer_rate_is_the_share_of_answered_unanswerable_items_with_its_n():
    out = aggregate(_no_answer_results(17, 20))
    overall = out["overall"]
    assert overall.correct_refusal_rate == MetricValue(value=0.85, n=20)
    assert overall.false_answer_rate is not None
    assert overall.false_answer_rate.n == 20
    assert overall.false_answer_rate.value == pytest.approx(0.15)
    assert overall.false_answer_rate.value == pytest.approx(1 - overall.correct_refusal_rate.value)


def test_false_answer_rate_is_none_on_a_slice_without_unanswerable_items():
    item = _item("en-a-001", [(DOC, "alpha fact")])
    results = score_items([_trace("en-a-001", [(DOC, "the alpha fact holds")])], [item])
    overall = aggregate(results)["overall"]
    assert overall.false_answer_rate == MetricValue(value=None, n=0)


def test_answer_equal_to_the_language_refusal_text_is_scored_refused():
    from rag_eval.refusal_text import load_refusal_texts

    text = load_refusal_texts()["en"][0]
    item = _item("en-na-001")
    for answer in (text, f"  {text.upper()}  \n"):
        (result,) = score_items([_answer_trace(item.id, refused=False, answer=answer)], [item])
        assert result.refused is True


def test_refusal_text_inside_a_longer_answer_is_not_a_refusal():
    from rag_eval.refusal_text import load_refusal_texts

    text = load_refusal_texts()["en"][0]
    item = _item("en-na-001")
    answer = f"The limit is twelve units. {text}"
    (result,) = score_items([_answer_trace(item.id, refused=False, answer=answer)], [item])
    assert result.refused is False


def test_trace_without_an_answer_is_scored_from_trace_refused_alone():
    item = _item("en-na-001")
    (kept,) = score_items([_answer_trace(item.id, refused=True, answer=None)], [item])
    (answered,) = score_items([_answer_trace(item.id, refused=False, answer=None)], [item])
    assert (kept.refused, answered.refused) == (True, False)


def test_retrieval_only_fixture_shape_keeps_the_five_noise_metrics():
    from rag_eval.golden_io import load_golden
    from rag_eval.paths import REPO_ROOT

    golden = [item for item in load_golden(REPO_ROOT / "eval" / "fixtures" / "golden.jsonl") if item.split == "dev"]
    traces = [_trace(item.id, [], refused=index % 3 == 0) for index, item in enumerate(golden)]
    results = score_items(traces, golden)
    assert [r.refused for r in results] == [t.refused for t in traces]
    expected = [
        ItemResult.model_validate({**r.model_dump(), "refused": t.refused}) for r, t in zip(results, traces, strict=True)
    ]
    noise = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
    got, want = aggregate(results)["overall"], aggregate(expected)["overall"]
    assert {m: getattr(got, m) for m in noise} == {m: getattr(want, m) for m in noise}


def _answerable_row(item_id: str, provenance: str = "synthetic_fixture") -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language="en",
        category="general",
        split="dev",
        provenance=provenance,
        answerable=True,
        refused=False,
        span_count=1,
        spans_hit_at_5=1,
        spans_hit_at_10=1,
        first_hit_rank=1,
    )


def test_paraphrased_items_leave_the_gate_population_and_are_counted_coverage_only():
    rows = [_answerable_row("en-a-001"), _answerable_row("en-a-002", "paraphrased")]
    out = aggregate(rows)
    assert out["overall"].recall_at_5.n == 1
    assert out["by_language"]["en"].recall_at_5.n == 1
    assert out["population_exclusions"]["coverage_only"] == 1


def test_non_active_items_leave_the_gate_population_and_stale_share_is_stale_over_active_plus_stale():
    rows = [_answerable_row(f"en-a-{i:03d}") for i in range(10)]
    statuses = {"en-a-000": "stale", "en-a-001": "retired", "en-a-002": "active"}
    out = aggregate(rows, statuses=statuses)
    assert out["overall"].recall_at_5.n == 8
    exclusions = out["population_exclusions"]
    assert exclusions["stale_count"] == 1
    assert exclusions["retired_count"] == 1
    assert exclusions["stale_share"] == pytest.approx(1 / 9)


def test_without_statuses_nothing_is_excluded_for_lifecycle():
    rows = [_answerable_row(f"en-a-{i:03d}") for i in range(3)]
    exclusions = aggregate(rows)["population_exclusions"]
    assert exclusions == {"coverage_only": 0, "stale_count": 0, "retired_count": 0, "stale_share": 0.0}
