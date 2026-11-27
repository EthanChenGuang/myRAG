"""Templated-collection metrics (plan 03.3-22; D-19, D-29, D-31, D-36). Synthetic items in invented vocabulary."""

import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem

import rag_eval.metrics as metrics_module
from rag_eval.metrics import aggregate, score_items
from rag_eval.report import _render_markdown, build_report, write_report
from rag_eval.templated_fixtures import load_templated_fixtures
from test_report_runner import _manifest
from test_templated_off_inputs import off_report

SNAPSHOT = Path(__file__).parent / "data" / "templated-off"
ASKED = "vorlo-family-01.pdf"
OTHER = "vorlo-family-02.pdf"
QUOTE = "the quenmar holds tarvik plain"


def _item(item_id: str, tag: str | None, *, doc: str = ASKED, quote: str = QUOTE, category: str = "templated_collection") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="what does the quenmar hold",
        language="en",
        category=category,
        answerable=True,
        expected_answer="tarvik plain",
        gold_evidence=[{"document": doc, "section": "1. Bel", "quote": quote}],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
        tags=[tag] if tag else [],
    )


def _trace(
    item_id: str,
    kept: list[tuple[str, str]],
    *,
    refused: bool = False,
    candidates: list[tuple[str, str, dict[str, int]]] | None = None,
    attribute_filter: dict | None = None,
) -> RagTrace:
    payload = {
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
        "candidates": [
            {
                "rank": index,
                "chunk_id": f"{item_id}-k{index}",
                "document_id": f"d-{doc}",
                "document_name": doc,
                "content": content,
                "similarity": 0.5,
                "has_image": False,
                "legs": legs,
            }
            for index, (doc, content, legs) in enumerate(candidates or [], start=1)
        ],
        "kept": [
            {
                "rank": index,
                "chunk_id": f"{item_id}-c{index}",
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
    if attribute_filter is not None:
        payload["attribute_filter"] = attribute_filter
    return RagTrace.model_validate(payload)


def _helper(name: str):
    helper = getattr(metrics_module, name, None)
    assert callable(helper), f"rag_eval.metrics.{name} is missing"
    return helper


def boilerplate_token_share(*args):
    return _helper("boilerplate_token_share")(*args)


def templated_token_count(text: str) -> int:
    return _helper("templated_token_count")(text)


def _one(item: GoldenItem, trace: RagTrace):
    return score_items([trace], [item])[0]


FILLER = [(OTHER, "pellow drin"), (OTHER, "sarno vell"), (OTHER, "mirta quol"), (OTHER, "fenno trask")]


# ---------- named_document_hit and wrong_document_at_1


def test_named_document_hit_within_rank_five():
    item = _item("tpl-a-01", "feature:attribute_named")
    result = _one(item, _trace(item.id, [*FILLER, (ASKED.upper(), "zorrin")]))
    assert result.named_document_hit is True
    assert result.wrong_document_at_1 is True


def test_named_document_miss_beyond_rank_five_and_refused():
    item = _item("tpl-a-02", "feature:attribute_named")
    beyond = _one(item, _trace(item.id, [*FILLER, (OTHER, "x"), (ASKED, "zorrin")]))
    assert beyond.named_document_hit is False
    refused = _one(item, _trace(item.id, [(ASKED, QUOTE)], refused=True))
    assert refused.named_document_hit is False


def test_wrong_document_at_one_false_when_asked_first_and_none_when_nothing_kept():
    item = _item("tpl-a-03", "feature:attribute_named")
    first = _one(item, _trace(item.id, [(ASKED, "zorrin"), (OTHER, "y")]))
    assert (first.named_document_hit, first.wrong_document_at_1) == (True, False)
    empty = _one(item, _trace(item.id, []))
    assert empty.named_document_hit is False
    assert empty.wrong_document_at_1 is None


def test_named_fields_unset_for_other_items():
    item = _item("tpl-a-04", "feature:variant")
    result = _one(item, _trace(item.id, [(ASKED, QUOTE)]))
    assert result.named_document_hit is None
    assert result.wrong_document_at_1 is None


# ---------- variant_correct


def test_variant_correct_needs_the_gold_sentence_at_rank_one():
    item = _item("tpl-v-01", "feature:variant")
    assert _one(item, _trace(item.id, [(ASKED, f"intro {QUOTE}")])).variant_correct is True
    assert _one(item, _trace(item.id, [(ASKED, "the quenmar holds dorvel"), (ASKED, QUOTE)])).variant_correct is False
    assert _one(item, _trace(item.id, [])).variant_correct is False
    assert _one(_item("tpl-v-02", "feature:quantity"), _trace("tpl-v-02", [(ASKED, QUOTE)])).variant_correct is None


# ---------- quantity_matched


def test_quantity_matched_from_lexical_rank_one():
    item = _item("tpl-q-01", "feature:quantity")
    hit = _trace(item.id, [], candidates=[(OTHER, "noise", {"dense": 1}), (ASKED, QUOTE, {"dense": 2, "lexical:0": 1})])
    assert _one(item, hit).quantity_matched is True
    miss = _trace(item.id, [], candidates=[(OTHER, "noise", {"lexical": 1}), (ASKED, QUOTE, {"lexical": 2})])
    assert _one(item, miss).quantity_matched is False


def test_quantity_matched_none_without_a_lexical_leg():
    item = _item("tpl-q-02", "feature:quantity")
    dense_only = _trace(item.id, [(ASKED, QUOTE)], candidates=[(ASKED, QUOTE, {"dense": 1})])
    assert _one(item, dense_only).quantity_matched is None


# ---------- attribute_filter_fallback


def _filter(mode: str, *, matched: int = 1, explicit: bool = False, fallback: bool = False) -> dict:
    return {
        "mode": mode,
        "explicit": explicit,
        "matched_attributes": matched,
        "resolved_documents": 1,
        "applied": not fallback,
        "fallback": fallback,
        "too_broad": False,
    }


def test_attribute_filter_fallback_flag():
    item = _item("tpl-f-01", None, category="general")
    assert _one(item, _trace(item.id, [])).attribute_filter_fallback is None
    assert _one(item, _trace(item.id, [], attribute_filter=_filter("soft", fallback=True))).attribute_filter_fallback is None
    assert _one(item, _trace(item.id, [], attribute_filter=_filter("hard", matched=0))).attribute_filter_fallback is None
    assert _one(item, _trace(item.id, [], attribute_filter=_filter("hard", fallback=True))).attribute_filter_fallback is True
    assert _one(item, _trace(item.id, [], attribute_filter=_filter("hard"))).attribute_filter_fallback is False
    explicit = _filter("hard", matched=0, explicit=True, fallback=True)
    assert _one(item, _trace(item.id, [], attribute_filter=explicit)).attribute_filter_fallback is True


# ---------- slice rates


def test_slice_rates_count_only_defined_values():
    named = [_item(f"tpl-n-{i:02d}", "feature:attribute_named") for i in range(3)]
    variant = _item("tpl-v-10", "feature:variant")
    plain = _item("tpl-p-01", None, category="general")
    traces = [
        _trace(named[0].id, [(ASKED, "z")]),
        _trace(named[1].id, [(OTHER, "z"), (ASKED, "z")]),
        _trace(named[2].id, [(OTHER, "z")]),
        _trace(variant.id, [(ASKED, QUOTE)]),
        _trace(plain.id, [(ASKED, QUOTE)], attribute_filter=_filter("hard", fallback=True)),
    ]
    overall = aggregate(score_items(traces, [*named, variant, plain]))["overall"]
    assert overall.named_document_recall.value == pytest.approx(2 / 3)
    assert overall.named_document_recall.n == 3
    assert overall.wrong_document_at_1.value == pytest.approx(2 / 3)
    assert (overall.variant_accuracy.value, overall.variant_accuracy.n) == (1.0, 1)
    assert overall.quantity_match_rate is None
    assert (overall.attribute_filter_fallback_rate.value, overall.attribute_filter_fallback_rate.n) == (1.0, 1)


# ---------- boilerplate token share


def _fixture(name: str, top: str, bottom: str, fragment: str) -> dict:
    return {"file_name": name, "templated": {"lines": {"top": [top], "bottom": [bottom], "fragment": fragment, "footer": []}}}


def test_token_count_counts_han_characters_alone_and_letter_digit_runs():
    assert templated_token_count("Kelvo marrin 12, x7") == 4
    assert templated_token_count("霭赅 abc") == 3


def test_boilerplate_share_over_distinct_templated_chunks():
    fixtures = [_fixture(ASKED, "Kelvo marrin 1", "Toren 1", "霭赅")]
    chunk = "Kelvo   marrin 3\nalpha beta gamma delta epsilon zeta\nToren 3"
    traces = [
        _trace("a", [], candidates=[(ASKED, chunk, {"dense": 1}), (OTHER, "Kelvo marrin 1 unrelated", {"dense": 2})]),
        _trace("b", [], candidates=[(ASKED, chunk, {"dense": 1})]),
    ]
    traces[1] = RagTrace.model_validate(
        {**traces[1].model_dump(mode="json"), "candidates": [{**traces[0].model_dump(mode="json")["candidates"][0]}]}
    )
    share = boilerplate_token_share(traces, fixtures)
    assert share.n == 1
    assert share.value == pytest.approx(5 / 11)


def test_boilerplate_share_counts_han_fragments_and_is_unset_without_chunks():
    fixtures = [_fixture(ASKED, "Kelvo 1", "Toren 1", "霭赅")]
    traces = [_trace("a", [], candidates=[(ASKED, "霭赅 pellow", {"dense": 1})])]
    share = boilerplate_token_share(traces, fixtures)
    assert share.value == pytest.approx(2 / 3)
    empty = boilerplate_token_share([_trace("b", [], candidates=[(OTHER, "x", {"dense": 1})])], fixtures)
    assert (empty.value, empty.n) == (None, 0)


def test_build_report_sets_share_on_the_templated_slice_only_with_templated_items():
    fixture = next(entry for entry in load_templated_fixtures()["fixtures"] if entry["language"] == "en")
    lines = fixture["templated"]["lines"]
    chunk = f"{lines['top'][0]}\npellow drin sarno vell mirta\n{lines['bottom'][0]}"
    item = _item("tpl-b-01", "feature:boilerplate", doc=fixture["file_name"], quote="pellow drin")
    trace = _trace(item.id, [(fixture["file_name"], chunk)], candidates=[(fixture["file_name"], chunk, {"dense": 1})])
    report = build_report(_manifest(), score_items([trace], [item]), [item], [trace])
    share = report.by_category["templated_collection"].boilerplate_token_share
    assert share is not None and share.n == 1 and 0 < share.value < 1
    assert report.overall.boilerplate_token_share is None
    plain = item.model_copy(update={"category": "general"})
    other = build_report(_manifest(), score_items([trace], [plain]), [plain], [trace])
    assert all(metrics.boilerplate_token_share is None for metrics in other.by_category.values())
    markdown = _render_markdown(report, None, None)
    assert "## Templated collection" in markdown
    assert "pellow" not in markdown


# ---------- off identity


def test_reports_without_templated_items_are_byte_equal(tmp_path):
    json_path, md_path = write_report(off_report(), tmp_path)
    expected = json.loads((SNAPSHOT / "report.json").read_text(encoding="utf-8"))
    found = json.loads(json_path.read_text(encoding="utf-8"))
    differing = sorted(set(expected) ^ set(found)) or [key for key in sorted(expected) if expected[key] != found[key]]
    assert not differing, f"first differing key: {differing[0]}"
    assert json_path.read_bytes() == (SNAPSHOT / "report.json").read_bytes()
    assert md_path.read_bytes() == (SNAPSHOT / "report.md").read_bytes()
    assert "## Templated collection" not in md_path.read_text(encoding="utf-8")
