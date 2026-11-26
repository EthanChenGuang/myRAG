from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from test_report_runner import QUOTE, _trace

from rag_eval.metrics import score_items, slices_by

PLAN = {
    "date_range": None,
    "framework": "llamaindex",
    "gate": {"lang": "en", "protected_tokens": [], "reasons": ["R12_SMALL_TALK"], "rewrite": False, "skip_retrieval": True, "transforms": []},
    "language": "en",
    "original": "hello",
    "skipped": [],
    "standalone": "hello",
    "sub_questions": [],
    "variants": [{"kind": "original", "language": "en", "protected_ok": True, "sub_question_index": None, "text": "hello"}],
}


def _golden(item_id: str, category: str, *, conversational: bool = False, answerable: bool = False) -> GoldenItem:
    item = {
        "id": item_id,
        "question": "hello",
        "language": "en",
        "category": category,
        "answerable": answerable,
        "review_status": "approved",
        "provenance": "synthetic_fixture",
        "split": "dev",
    }
    if answerable:
        item.update(expected_answer="Thirty days.", gold_evidence=[{"document": "doc.en.md", "section": "Refunds", "quote": QUOTE}])
    if conversational:
        item["expected_behavior"] = "conversational"
    return GoldenItem.model_validate(item)


def _skipped_trace(item_id: str, *, refused: bool = False, kept: bool = False, plan: bool = True):
    trace = _trace(item_id, [("doc.en.md", QUOTE)] if kept else [], refused=refused)
    return RagTrace.model_validate({**trace.model_dump(mode="json"), "query_plan": PLAN if plan else None})


def test_a_skipped_unrefused_turn_without_documents_is_conversational():
    golden = [_golden("en-small-talk-001", "small_talk", conversational=True)]
    [result] = score_items([_skipped_trace("en-small-talk-001")], golden)
    assert result.expected_behavior == "conversational" and result.conversational_ok is True


def test_a_refused_retrieved_or_unplanned_turn_is_not_conversational():
    golden = [_golden(f"en-small-talk-00{i}", "small_talk", conversational=True) for i in (1, 2, 3)]
    traces = [
        _skipped_trace("en-small-talk-001", refused=True),
        _skipped_trace("en-small-talk-002", kept=True),
        _skipped_trace("en-small-talk-003", plan=False),
    ]
    assert [r.conversational_ok for r in score_items(traces, golden)] == [False, False, False]


def test_conversational_items_stay_out_of_the_refusal_rates():
    golden = [
        _golden("en-small-talk-001", "small_talk", conversational=True),
        _golden("en-no-answer-001", "no_answer"),
    ]
    traces = [_skipped_trace("en-small-talk-001"), _trace("en-no-answer-001", [], refused=True)]
    overall = slices_by(score_items(traces, golden), lambda _r: "overall")["overall"]
    assert overall.correct_refusal_rate.value == 1.0 and overall.correct_refusal_rate.n == 1
    assert overall.conversational_rate is not None
    assert overall.conversational_rate.value == 1.0 and overall.conversational_rate.n == 1


def test_small_talk_without_expected_behavior_is_still_scored_as_a_refusal():
    golden = [_golden("en-small-talk-001", "small_talk")]
    results = score_items([_skipped_trace("en-small-talk-001")], golden)
    assert results[0].conversational_ok is None
    overall = slices_by(results, lambda _r: "overall")["overall"]
    assert overall.correct_refusal_rate.n == 1 and overall.conversational_rate is None
