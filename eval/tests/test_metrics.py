import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult

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
    assert report.overall.row_recall_at_10.value == 0.5 and report.overall.row_recall_at_10.n == 4


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
