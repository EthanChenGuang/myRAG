import math

import pytest
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.ndcg import gold_unit_first_hits, ndcg_at_context_k
from test_report_runner import _trace

QUOTE_A = "the first synthetic statement about the sample value"
QUOTE_B = "a second synthetic statement about another sample value"
QUOTE_C = "a third synthetic statement used only as a spare span"


def _item(quotes: list[str], groups: list[list[int]] | None = None) -> GoldenItem:
    payload = {
        "id": "en-general-900",
        "question": "question",
        "language": "en",
        "category": "general",
        "answerable": True,
        "expected_answer": "answer",
        "gold_evidence": [{"document": "doc.en.md", "section": "s", "quote": quote} for quote in quotes],
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    if groups is not None:
        payload["evidence_groups"] = groups
    return GoldenItem.model_validate(payload)


def _hit(quote: str) -> tuple[str, str]:
    return ("doc.en.md", f"before {quote} after")


FILLER = ("filler.md", "nothing relevant here")


def test_ndcg_is_zero_when_k_is_zero_or_there_is_no_gold_unit():
    assert ndcg_at_context_k([1], 0) == 0.0
    assert ndcg_at_context_k([], 5) == 0.0


def test_ndcg_single_unit_hit_at_position_one_is_one():
    assert ndcg_at_context_k([1], 3) == pytest.approx(1.0)


def test_ndcg_two_units_at_positions_one_and_two_with_k_two_is_one():
    assert ndcg_at_context_k([1, 2], 2) == pytest.approx(1.0)


def test_ndcg_two_units_with_only_the_second_position_hit_is_between_zero_and_one():
    value = ndcg_at_context_k([None, 2], 2)
    ideal = 1 + 1 / math.log2(3)
    assert value == pytest.approx((1 / math.log2(3)) / ideal)
    assert 0.0 < value < 1.0


def test_ndcg_ignores_positions_beyond_k_and_caps_the_ideal_at_k():
    assert ndcg_at_context_k([4], 3) == 0.0
    assert ndcg_at_context_k([1, None, None], 1) == pytest.approx(1.0)


def test_first_hits_give_one_entry_per_span_in_rank_order():
    item = _item([QUOTE_A, QUOTE_B])
    trace = _trace(item.id, [FILLER, _hit(QUOTE_B), _hit(QUOTE_A)])
    assert gold_unit_first_hits(trace, item) == [3, 2]


def test_first_hits_return_none_for_a_span_that_no_kept_chunk_matches():
    item = _item([QUOTE_A, QUOTE_B])
    trace = _trace(item.id, [_hit(QUOTE_A), FILLER])
    assert gold_unit_first_hits(trace, item) == [1, None]


def test_first_hits_order_kept_by_rank_not_by_list_position():
    item = _item([QUOTE_A])
    trace = _trace(item.id, [_hit(QUOTE_A), FILLER])
    kept = list(reversed([chunk.model_copy(update={"rank": 2 if index == 0 else 1}) for index, chunk in enumerate(trace.kept)]))
    trace = trace.model_copy(update={"kept": kept})
    assert gold_unit_first_hits(trace, item) == [2]


def test_first_hits_give_one_entry_per_evidence_group_at_the_first_matching_span():
    item = _item([QUOTE_A, QUOTE_B, QUOTE_C], groups=[[0, 1], [2]])
    trace = _trace(item.id, [FILLER, _hit(QUOTE_B), _hit(QUOTE_A)])
    assert gold_unit_first_hits(trace, item) == [2, None]


def test_several_kept_chunks_matching_one_span_earn_one_credit():
    item = _item([QUOTE_A])
    trace = _trace(item.id, [_hit(QUOTE_A), _hit(QUOTE_A), _hit(QUOTE_A)])
    hits = gold_unit_first_hits(trace, item)
    assert hits == [1]
    assert ndcg_at_context_k(hits, len(trace.kept)) == pytest.approx(1.0)
