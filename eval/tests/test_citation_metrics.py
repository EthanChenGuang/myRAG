import hashlib

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import GroundednessLabelCounts

from rag_eval.metrics import citation_metrics, groundedness_label_counts

DOC = "refund-policy.en.md"
GOLD_QUOTE = "Refunds are issued within 14 days."


def _item(item_id: str, *, language: str = "en", answerable: bool = True) -> GoldenItem:
    return GoldenItem(
        id=f"item-{item_id}",
        question="question",
        language=language,
        category="general" if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": DOC, "section": "s", "quote": GOLD_QUOTE}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _citation(alias: str, chunk_id: str, quote: str, *, n: int = 1, strategy: str = "chunk-alias") -> dict:
    return {
        "n": n,
        "alias": alias,
        "chunkIds": [chunk_id],
        "documentId": f"d-{DOC}",
        "documentName": DOC,
        "quote": quote,
        "quoteHash": hashlib.sha256(quote.encode("utf-8")).hexdigest(),
        "strategy": strategy,
    }


def _trace(
    item_id: str,
    *,
    citations: list[dict] | None = None,
    strategy: str | None = "chunk-alias",
    refused: bool = False,
    answer: str | None = "An answer [S1].",
    invalid: int = 0,
    groundedness: dict | None = None,
    kept: int = 2,
) -> RagTrace:
    labels = "\n".join(f"[S{index}] {DOC}\nchunk {index} text" for index in range(1, kept + 1))
    payload: dict = {
        "item_id": f"item-{item_id}",
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
                "document_id": f"d-{DOC}",
                "document_name": DOC,
                "content": f"chunk {index} text",
                "similarity": 0.5,
                "kept_by": "similarity",
            }
            for index in range(1, kept + 1)
        ],
        "used_documents": [],
        "context": "" if refused else labels,
        "refused": refused,
        "refusal_reason": "no_relevant_context" if refused else None,
        "answer": None if refused else answer,
        "citations": citations or [],
        "invalid_citations": invalid,
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
    if strategy is not None and not refused:
        payload["citation_strategy"] = strategy
    if groundedness is not None:
        payload["groundedness"] = groundedness
    return RagTrace.model_validate(payload)


def _scored(label: str, scorer: str = "hhem_2_1_open", latency: int = 900) -> dict:
    score = 0.9 if label == "verified" else 0.2
    return {
        "status": "scored",
        "scorer": scorer,
        "score": score,
        "label": label,
        "threshold": 0.5,
        "thresholdSource": "default",
        "latencyMs": latency,
    }


NOT_CHECKED = {"status": "not_checked", "label": "not_checked", "reason": "unsupported_language"}


def test_coverage_counts_answered_items_with_a_valid_citation_and_skips_refusals():
    golden = [_item("a"), _item("b"), _item("c"), _item("r")]
    traces = [
        _trace("a", citations=[_citation("S1", "c1", "chunk 1 text")]),
        _trace("b", citations=[_citation("S2", "c2", "chunk 2 text")]),
        _trace("c", citations=[]),
        _trace("r", refused=True),
    ]
    metrics = citation_metrics(traces, golden, requested=True)
    assert metrics["citation_coverage"].n == 3
    assert metrics["citation_coverage"].value == 2 / 3


def test_a_citation_outside_the_trace_blocks_is_invalid_and_does_not_cover():
    golden = [_item("a"), _item("b")]
    traces = [
        _trace("a", citations=[_citation("S1", "c1", "chunk 1 text")]),
        _trace(
            "b",
            citations=[
                _citation("S1", "c9", "chunk 9 text"),
                _citation("S7", "c2", "chunk 2 text", n=2),
            ],
        ),
    ]
    metrics = citation_metrics(traces, golden, requested=True)
    assert metrics["invalid_citation_rate"].n == 3
    assert metrics["invalid_citation_rate"].value == 2 / 3
    assert metrics["citation_coverage"].value == 0.5


def test_valid_citations_give_an_invalid_rate_of_zero():
    golden = [_item("a"), _item("b")]
    traces = [
        _trace("a", citations=[_citation("S1", "c1", "chunk 1 text"), _citation("S2", "c2", "chunk 2 text", n=2)]),
        _trace("b", citations=[_citation("S2", "c2", "chunk 2 text")]),
    ]
    metrics = citation_metrics(traces, golden, requested=True)
    assert metrics["invalid_citation_rate"].value == 0.0
    assert metrics["invalid_citation_rate"].n == 3


def test_cited_gold_hit_uses_the_span_match_and_excludes_items_without_gold_spans():
    golden = [_item("hit"), _item("miss"), _item("none", answerable=False)]
    traces = [
        _trace("hit", citations=[_citation("S1", "c1", f"Intro. {GOLD_QUOTE.upper()}  More.")]),
        _trace("miss", citations=[_citation("S1", "c1", "chunk 1 text")]),
        _trace("none", citations=[_citation("S1", "c1", GOLD_QUOTE)]),
    ]
    metrics = citation_metrics(traces, golden, requested=True)
    assert metrics["cited_gold_hit"].n == 2
    assert metrics["cited_gold_hit"].value == 0.5


def test_an_invalid_citation_never_scores_a_gold_hit():
    golden = [_item("a")]
    traces = [_trace("a", citations=[_citation("S1", "c9", GOLD_QUOTE)])]
    assert citation_metrics(traces, golden, requested=True)["cited_gold_hit"].value == 0.0


def test_raw_invalid_markers_are_summed_and_leave_the_invalid_rate_alone():
    golden = [_item("a"), _item("b")]
    traces = [
        _trace("a", citations=[_citation("S1", "c1", "chunk 1 text")], invalid=2),
        _trace("b", citations=[_citation("S1", "c1", "chunk 1 text")], invalid=3),
    ]
    metrics = citation_metrics(traces, golden, requested=True)
    assert metrics["raw_invalid_markers"] == 5
    assert metrics["invalid_citation_rate"].value == 0.0


def test_runs_without_citation_data_yield_none_not_zero():
    golden = [_item("a"), _item("b")]
    traces = [_trace("a", strategy=None), _trace("b", strategy=None)]
    metrics = citation_metrics(traces, golden)
    assert metrics == {
        "invalid_citation_rate": None,
        "citation_coverage": None,
        "cited_gold_hit": None,
        "raw_invalid_markers": None,
    }
    assert groundedness_label_counts(traces, golden) == {}


def test_a_citation_run_is_detected_from_the_traces():
    golden = [_item("a")]
    traces = [_trace("a", citations=[_citation("S1", "c1", "chunk 1 text")])]
    assert citation_metrics(traces, golden)["citation_coverage"].value == 1.0


def test_groundedness_counts_by_scorer_and_language():
    golden = [_item("e1"), _item("e2"), _item("e3"), _item("i1", language="it"), _item("p")]
    traces = [
        _trace("e1", groundedness=_scored("verified")),
        _trace("e2", groundedness=_scored("verified")),
        _trace("e3", groundedness=_scored("possibly_unreliable")),
        _trace("i1", groundedness=NOT_CHECKED),
        _trace("p", groundedness={"status": "pending"}),
    ]
    assert groundedness_label_counts(traces, golden) == {
        "hhem_2_1_open": {"en": GroundednessLabelCounts(verified=2, possibly_unreliable=1)},
        "none": {"it": GroundednessLabelCounts(not_checked=1)},
    }
