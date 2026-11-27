from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.metrics import aggregate, score_items
from rag_eval.paired import item_metrics

DOC = "alpha.en.md"
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
