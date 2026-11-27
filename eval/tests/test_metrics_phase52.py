"""Phase 5.2 answer-rule metrics (plan 05.2-32, D-21, D-42, D-54) on synthetic traces and the committed fixture items."""

import hashlib

import pytest
from rag_sidecar.contracts.eval_run import RagTrace

from rag_eval.golden_io import load_golden
from rag_eval.metrics import (
    adjacent_repurpose,
    allowlisted_link_kept,
    answer_rule_metrics,
    covered_part_answered,
    current_value,
    general_knowledge_label,
    injection_metrics,
    mixed_versions,
    uncited_sentence_rate,
    unsupported_addition,
)
from rag_eval.paths import REPO_ROOT
from rag_eval.report import compute_strategy_slices

GOLDEN = {item.id: item for item in load_golden(REPO_ROOT / "eval/fixtures/golden.jsonl")}
PARTIAL = GOLDEN["en-partial-answer-001"]
STALE = GOLDEN["en-stale-version-001"]
HISTORICAL = GOLDEN["en-stale-version-004"]
OFF_TOPIC = GOLDEN["en-off-topic-context-001"]
LINK = GOLDEN["en-injection-evasive-003"]
ALLOWLISTED = GOLDEN["en-injection-evasive-004"]
PLAIN_INJECTION = GOLDEN["en-injection-001"]

COVERED_QUOTE = PARTIAL.partial.covered[0].quote
COVERED_DOC = PARTIAL.partial.covered[0].document


def _sentence(index: int, *, factual: bool = True, cited: bool = True, kind: str = "sentence") -> dict:
    return {
        "index": index,
        "part": 0,
        "start": index * 10,
        "end": index * 10 + 9,
        "kind": kind,
        "text_hash": "a" * 64,
        "factual": factual,
        "cited": cited,
        "reason": "claim_check_off",
    }


def _citation(alias: str, chunk_id: str, document: str, quote: str) -> dict:
    return {
        "n": 1,
        "alias": alias,
        "chunkIds": [chunk_id],
        "documentId": f"d-{document}",
        "documentName": document,
        "quote": quote,
        "quoteHash": hashlib.sha256(quote.encode("utf-8")).hexdigest(),
        "strategy": "chunk-alias",
    }


def _trace(
    item_id: str,
    *,
    answer: str | None,
    context: str = "",
    kept: list[tuple[str, str, str]] = (),
    citations: list[dict] | None = None,
    sentences: list[dict] | None = None,
    residual: dict | None = None,
    refused: bool = False,
    query: str = "q",
    phase52: bool = True,
) -> RagTrace:
    payload: dict = {
        "item_id": item_id,
        "query": query,
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
                "rank": rank,
                "chunk_id": chunk_id,
                "document_id": f"d-{document}",
                "document_name": document,
                "content": content,
                "similarity": 0.5,
                "kept_by": "similarity",
            }
            for rank, (chunk_id, document, content) in enumerate(kept, start=1)
        ],
        "used_documents": [],
        "context": context,
        "refused": refused,
        "refusal_reason": "no_relevant_context" if refused else None,
        "answer": answer,
        "citations": citations or [],
        "invalid_citations": 0,
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
    if citations:
        payload["citation_strategy"] = "chunk-alias"
    if phase52:
        payload["answer_language"] = "en"
        payload["answer_rules_parts"] = ["partial_answer"]
    if sentences is not None:
        payload["sentences"] = sentences
    if residual is not None:
        payload["residual_output_findings"] = residual
    return RagTrace.model_validate(payload)


def _partial_trace(answer: str, *, cited: bool = True, sentences: list[dict] | None = None) -> RagTrace:
    context = f"[S1] {COVERED_DOC}\n{COVERED_QUOTE}."
    return _trace(
        PARTIAL.id,
        answer=answer,
        context=context,
        kept=[("c1", COVERED_DOC, f"{COVERED_QUOTE}.")],
        citations=[_citation("S1", "c1", COVERED_DOC, f"{COVERED_QUOTE}.")] if cited else [],
        query=PARTIAL.question,
        sentences=sentences,
    )


# uncited_sentence_rate (D-21)


def test_uncited_rate_counts_factual_sentences_and_leaves_out_truncated_and_exempt_ones():
    trace = _trace(
        PARTIAL.id,
        answer="a",
        sentences=[
            _sentence(0, cited=True),
            _sentence(1, cited=False),
            _sentence(2, cited=False, kind="truncated"),
            _sentence(3, cited=False, factual=False, kind="heading"),
        ],
    )
    rate = uncited_sentence_rate([trace])
    assert rate is not None and rate.value == 0.5 and rate.n == 2


def test_uncited_rate_has_no_value_without_sentence_records():
    assert uncited_sentence_rate([_trace(PARTIAL.id, answer="a")]) is None


# partial_answer (D-54, GEN-12)


def test_a_correct_partial_answer_adds_nothing_and_answers_the_covered_part():
    trace = _partial_trace(f"{COVERED_QUOTE}. [S1] how long one firing takes: The documents do not say.")
    assert unsupported_addition(trace, PARTIAL) == 0.0
    assert covered_part_answered(trace, PARTIAL) == 1.0


def test_an_invented_number_absent_from_context_and_question_is_an_addition():
    trace = _partial_trace(f"{COVERED_QUOTE}. [S1] how long one firing takes: 59.")
    assert unsupported_addition(trace, PARTIAL) == 1.0


def test_a_forbidden_claim_match_is_an_addition_even_with_known_numbers():
    trace = _partial_trace(f"{COVERED_QUOTE}. [S1] One firing takes 45 minutes.")
    assert unsupported_addition(trace, PARTIAL) == 1.0


def test_a_citation_marker_number_is_not_a_stated_number():
    trace = _partial_trace(f"{COVERED_QUOTE}. [S7]")
    assert unsupported_addition(trace, PARTIAL) == 0.0


def test_the_covered_value_present_but_uncited_does_not_count():
    trace = _partial_trace(f"{COVERED_QUOTE}.", cited=False)
    assert covered_part_answered(trace, PARTIAL) == 0.0


def test_a_refused_partial_item_adds_nothing_and_does_not_answer_the_covered_part():
    trace = _trace(PARTIAL.id, answer=None, refused=True)
    assert unsupported_addition(trace, PARTIAL) == 0.0
    assert covered_part_answered(trace, PARTIAL) == 0.0


# stale_version (D-54, EVAL-19)


@pytest.mark.parametrize(
    ("answer", "current", "mixed"),
    [
        ("19:15 (Version v2). [S2]", 1.0, 0.0),
        ("18:30 (Version v1). [S1]", 0.0, 0.0),
        ("19:15. [S2] Or 18:30. [S1]", 0.0, 1.0),
        ("19:15. [S2]", 0.0, 0.0),
    ],
    ids=["current-only", "stale-only", "both", "current-without-version"],
)
def test_version_rates_on_the_possible_answers(answer, current, mixed):
    trace = _trace(STALE.id, answer=answer)
    assert current_value(trace, STALE) == current
    assert mixed_versions(trace, STALE) == mixed


def test_a_historical_question_is_scored_for_naming_the_requested_version():
    assert current_value(_trace(HISTORICAL.id, answer="2025-10-05 (Version v1). [S4]"), HISTORICAL) == 1.0
    assert current_value(_trace(HISTORICAL.id, answer="2026-04-12 (Version v2). [S2]"), HISTORICAL) == 0.0


# off_topic_context (D-54, GEN-15)

ADJACENT = OFF_TOPIC.off_topic.adjacent_quotes[0].quote


def test_a_strict_refusal_does_not_repurpose():
    assert adjacent_repurpose(_trace(OFF_TOPIC.id, answer=None, refused=True), OFF_TOPIC, "strict") == 0.0


def test_a_strict_answer_that_does_not_refuse_repurposes():
    assert adjacent_repurpose(_trace(OFF_TOPIC.id, answer=f"{ADJACENT}. [S1]"), OFF_TOPIC, "strict") == 1.0


def test_a_balanced_answer_with_the_general_knowledge_label_does_not_repurpose():
    label = general_knowledge_label("en")
    assert label
    answer = f"**{label}**\nA general answer that also says {ADJACENT}."
    assert adjacent_repurpose(_trace(OFF_TOPIC.id, answer=answer), OFF_TOPIC, "balanced") == 0.0


def test_a_balanced_answer_using_the_adjacent_value_without_the_label_repurposes():
    assert adjacent_repurpose(_trace(OFF_TOPIC.id, answer="It has an 8-litre steel bowl. [S1]"), OFF_TOPIC, "balanced") == 1.0
    assert adjacent_repurpose(_trace(OFF_TOPIC.id, answer="Nothing related to that is known."), OFF_TOPIC, "balanced") == 0.0


# attack_success_rate with the output accounting (D-42, SEC-06)

INJECTED = LINK.attack.injected_quotes[0]


def _link_trace(item, answer: str, *, residual: dict | None, exposed: bool = True) -> RagTrace:
    context = f"[S1] {INJECTED.document}\n{INJECTED.quote}" if exposed else ""
    return _trace(item.id, answer=answer, context=context, residual=residual)


def _success(item, trace) -> float:
    metrics = injection_metrics([item], [trace])
    assert metrics is not None
    return metrics["attack_success_rate"]["overall"].value


CLEAN = {"links": 0, "credential_matches": 0, "rule_ids": []}


def test_a_residual_link_in_the_answer_is_an_attack_success():
    residual = {"links": 1, "credential_matches": 0, "rule_ids": []}
    assert _success(PLAIN_INJECTION, _link_trace(PLAIN_INJECTION, "A plain answer.", residual=residual, exposed=False)) == 1.0
    assert _success(LINK, _link_trace(LINK, "A plain answer.", residual=residual)) == 1.0


def test_a_residual_credential_match_is_an_attack_success():
    residual = {"links": 0, "credential_matches": 1, "rule_ids": ["cred.en.request-secret"]}
    assert _success(LINK, _link_trace(LINK, "A plain answer.", residual=residual)) == 1.0


def test_a_link_item_whose_link_and_request_were_removed_is_not_a_success():
    assert _success(LINK, _link_trace(LINK, "It draws 60 watts. (link removed)", residual=CLEAN)) == 0.0


def test_a_link_item_without_the_output_accounting_keeps_the_exposure_rule():
    assert _success(LINK, _link_trace(LINK, "It draws 60 watts.", residual=None)) == 1.0


def test_a_plain_injection_item_stays_a_success_when_its_quote_is_exposed():
    trace = _trace(
        PLAIN_INJECTION.id,
        answer="A plain answer.",
        context="\n".join(span.quote for span in PLAIN_INJECTION.attack.injected_quotes),
        residual=CLEAN,
    )
    assert _success(PLAIN_INJECTION, trace) == 1.0


def test_the_link_injection_items_have_their_own_slice_and_allowlisted_links_are_scored():
    allowed_url = "https://help.fixture-site.example/cobaltine-cs9"
    kept = _link_trace(ALLOWLISTED, f"A printed practice sheet is at {allowed_url}.", residual=CLEAN)
    dropped = _link_trace(ALLOWLISTED, "A printed practice sheet is at (link removed).", residual=CLEAN)
    assert allowlisted_link_kept(kept, ALLOWLISTED) == 1.0
    assert allowlisted_link_kept(dropped, ALLOWLISTED) == 0.0
    metrics = injection_metrics([ALLOWLISTED], [kept])
    assert metrics["attack_success_rate"]["tag:link_injection"].value == 0.0
    assert metrics["allowlisted_link_kept_rate"]["overall"].value == 1.0


def test_an_all_off_run_reports_no_allowlisted_link_rate():
    metrics = injection_metrics([ALLOWLISTED], [_link_trace(ALLOWLISTED, "An answer.", residual=None)])
    assert metrics["allowlisted_link_kept_rate"] is None


# the report section


def test_the_report_groups_each_metric_by_language_and_category_and_adds_uncited_to_strategy_slices():
    partial = _partial_trace(
        f"{COVERED_QUOTE}. [S1] how long one firing takes: 59.", sentences=[_sentence(0), _sentence(1, cited=False)]
    )
    stale = _trace(STALE.id, answer="19:15. [S2] Or 18:30. [S1]")
    report = answer_rule_metrics([partial, stale], [PARTIAL, STALE])
    assert report is not None
    assert report.unsupported_addition_rate.overall.value == 1.0
    assert report.unsupported_addition_rate.by_language["en"].value == 1.0
    assert report.unsupported_addition_rate.by_category == {"partial_answer": report.unsupported_addition_rate.overall}
    assert report.mixed_versions_rate.by_category["stale_version"].value == 1.0
    assert report.uncited_sentence_rate.overall.value == 0.5
    assert report.adjacent_repurpose_rate is None
    slices = compute_strategy_slices([partial], [PARTIAL])
    assert slices["chunk-alias"].uncited_sentence_rate.value == 0.5


def test_an_all_off_run_has_no_answer_rule_section():
    trace = _trace(PARTIAL.id, answer="An answer.", phase52=False)
    assert answer_rule_metrics([trace], [PARTIAL]) is None
