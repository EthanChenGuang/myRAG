import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport

from rag_eval.corpus import load_corpus
from rag_eval.golden_io import write_golden
from rag_eval.metrics import question_kind, score_items
from rag_eval.report import build_report, write_report
from rag_eval.runner import main
from test_report_runner import QUOTE, _item, _manifest, _trace

V2_ITEM_FIELDS = ("doc_type", "question_kind", "rerank_status", "lexical_hit_at_10")
V2_REPORT_FIELDS = ("by_doc_type", "by_question_kind", "rerank_skipped_rate", "lexical_leg_hit_rate_at_10")


def _tagged(item: GoldenItem, *tags: str) -> GoldenItem:
    return item.model_copy(update={"tags": list(tags)})


def _with_candidates(trace: RagTrace, candidates: list[dict], **update) -> RagTrace:
    rows = [
        {
            "rank": index,
            "chunk_id": f"c{index}",
            "document_id": f"d-{doc}",
            "document_name": doc,
            "content": content,
            "similarity": 0.5,
            "has_image": False,
            "legs": legs,
        }
        for index, (doc, content, legs) in enumerate(candidates, start=1)
    ]
    return RagTrace.model_validate({**trace.model_dump(mode="json"), "candidates": rows, **update})


def _with_status(trace: RagTrace, rerank: str | None) -> RagTrace:
    status = {"search": "ok"} if rerank is None else {"search": "ok", "rerank": rerank}
    return trace.model_copy(update={"stage_status": status})


def _build(golden: list[GoldenItem], traces: list[RagTrace], **score_kwargs) -> EvalReport:
    return build_report(_manifest(), score_items(traces, golden, **score_kwargs), golden, traces)


def _hit_trace(item_id: str, doc: str = "doc.en.md") -> RagTrace:
    return _trace(item_id, [(doc, QUOTE)])


def test_question_kind_mapping():
    assert question_kind("exact_term", []) == "fact_lookup"
    assert question_kind("general", []) == "fact_lookup"
    assert question_kind("table", []) == "fact_lookup"
    assert question_kind("compound", []) == "context_heavy"
    assert question_kind("multi_turn", []) == "context_heavy"
    assert question_kind("general", ["clause"]) == "context_heavy"
    assert question_kind("exact_term", ["other", "clause"]) == "context_heavy"
    for category in ("no_answer", "typo", "colloquial", "ambiguous", "scanned", "cross_lingual", "selective_filter"):
        assert question_kind(category, []) == "other"


def test_by_question_kind_slices_follow_the_mapping():
    golden = [
        _item("en-general-001", "en", answerable=True),
        _item("en-exact-001", "en", answerable=True, category="exact_term"),
        _tagged(_item("en-clause-001", "en", answerable=True), "clause"),
        _item("en-typo-001", "en", answerable=True, category="typo"),
        _item("en-noanswer-001", "en", answerable=False),
    ]
    traces = [_hit_trace(item.id) if item.answerable else _trace(item.id, [], refused=True) for item in golden]
    report = _build(golden, traces)
    assert set(report.by_question_kind) == {"fact_lookup", "context_heavy", "other"}
    assert report.by_question_kind["fact_lookup"].recall_at_5.n == 2
    assert report.by_question_kind["context_heavy"].recall_at_5.n == 1
    assert report.by_question_kind["other"].recall_at_5.n == 1
    assert report.by_question_kind["other"].correct_refusal_rate.n == 1
    kinds = {item.item_id: item.question_kind for item in report.items}
    assert kinds["en-clause-001"] == "context_heavy"


def test_by_doc_type_uses_gold_document_type_and_defaults_to_general():
    golden = [
        _item("en-general-001", "en", answerable=True),
        _item("it-general-001", "it", answerable=True),
        _item("zh-general-001", "zh", answerable=True),
        _item("en-noanswer-001", "en", answerable=False),
    ]
    traces = [
        _hit_trace("en-general-001", "doc.en.md"),
        _trace("it-general-001", []),
        _trace("zh-general-001", []),
        _trace("en-noanswer-001", [], refused=True),
    ]
    report = _build(golden, traces, doc_types={"doc.en.md": "financial_report", "doc.it.md": "contract_legal"})
    assert set(report.by_doc_type) == {"financial_report", "contract_legal", "general"}
    assert report.by_doc_type["financial_report"].recall_at_5.value == 1.0
    assert report.by_doc_type["contract_legal"].recall_at_5.value == 0.0
    assert report.by_doc_type["general"].recall_at_5.n == 1
    assert report.by_doc_type["general"].correct_refusal_rate.n == 1


def test_doc_type_lookup_is_case_insensitive_and_absent_map_gives_general():
    golden = [_item("en-general-001", "en", answerable=True)]
    traces = [_hit_trace("en-general-001")]
    assert set(_build(golden, traces, doc_types={"DOC.EN.MD": "invoice_receipt"}).by_doc_type) == {"invoice_receipt"}
    assert set(_build(golden, traces).by_doc_type) == {"general"}


def test_false_refusal_upper_bound_next_to_every_estimate():
    golden = [_item(f"en-general-{index:03d}", "en", answerable=True) for index in range(18)]
    traces = [_hit_trace(item.id) for item in golden]
    report = _build(golden, traces)
    for slice_metrics in (report.overall, *report.by_language.values(), *report.by_category.values(), *report.by_split.values()):
        assert slice_metrics.false_refusal_upper_95 == pytest.approx(0.1529, abs=5e-4)

    refused = [_trace(item.id, [], refused=True) if index < 2 else _hit_trace(item.id) for index, item in enumerate(golden)]
    two_of_eighteen = _build(golden, refused).overall
    assert two_of_eighteen.false_refusal_rate.value == pytest.approx(2 / 18)
    assert two_of_eighteen.false_refusal_upper_95 > 2 / 18


def test_false_refusal_upper_bound_is_one_without_answerable_items():
    golden = [_item("en-noanswer-001", "en", answerable=False)]
    report = _build(golden, [_trace("en-noanswer-001", [], refused=True)])
    assert report.overall.false_refusal_rate.value is None
    assert report.overall.false_refusal_upper_95 == 1.0


def _rerank_report(statuses: list[str | None]) -> EvalReport:
    golden = [_item(f"en-general-{index:03d}", "en", answerable=True) for index in range(len(statuses))]
    traces = [_with_status(_hit_trace(item.id), status) for item, status in zip(golden, statuses)]
    return _build(golden, traces)


def test_rerank_skipped_rate_counts_skipped_and_timeout_over_attempted():
    report = _rerank_report(["ok", "ok", "ok", "timeout"])
    assert report.rerank_skipped_rate is not None
    assert (report.rerank_skipped_rate.value, report.rerank_skipped_rate.n) == (0.25, 4)
    assert _rerank_report(["ok", "skipped", "ok", "ok"]).rerank_skipped_rate.value == 0.25


def test_rerank_skipped_rate_ignores_disabled_and_absent_stages():
    report = _rerank_report(["ok", "timeout", "disabled", None])
    assert (report.rerank_skipped_rate.value, report.rerank_skipped_rate.n) == (0.5, 2)


def test_rerank_skipped_rate_is_null_when_no_trace_attempted_rerank():
    for statuses in (["disabled", "disabled"], [None, None]):
        rate = _rerank_report(statuses).rerank_skipped_rate
        assert rate is not None and rate.value is None and rate.n == 0


def _lexical_report(candidates_per_item: list[list[tuple[str, str, dict[str, int]]]], *, search_counts=None) -> EvalReport:
    golden = [_item(f"en-general-{index:03d}", "en", answerable=True) for index in range(len(candidates_per_item))]
    traces = []
    for item, candidates in zip(golden, candidates_per_item):
        extra = {"stage_counts": search_counts} if search_counts is not None else {}
        traces.append(_with_candidates(_hit_trace(item.id), candidates, **extra))
    return _build(golden, traces)


def test_lexical_leg_hit_rate_counts_gold_inside_lexical_top_ten():
    gold = ("doc.en.md", f"intro {QUOTE} outro")
    other = ("doc.en.md", "unrelated text")
    report = _lexical_report(
        [
            [(*other, {"dense": 1}), (*gold, {"dense": 2, "lexical": 10})],
            [(*gold, {"dense": 1, "lexical": 11})],
            [(*gold, {"dense": 1})],
            [(*other, {"lexical": 1}), (*gold, {"lexical": 3})],
        ]
    )
    rate = report.lexical_leg_hit_rate_at_10
    assert rate is not None
    assert (rate.value, rate.n) == (0.5, 4)
    assert [item.lexical_hit_at_10 for item in report.items] == [True, False, False, True]


def test_lexical_leg_hit_rate_is_null_when_the_lexical_leg_never_ran():
    gold = ("doc.en.md", f"intro {QUOTE} outro")
    report = _lexical_report([[(*gold, {"dense": 1})], []])
    rate = report.lexical_leg_hit_rate_at_10
    assert rate is not None and rate.value is None and rate.n == 0
    assert all(item.lexical_hit_at_10 is None for item in report.items)


def test_lexical_leg_that_ran_without_hits_counts_as_a_miss():
    report = _lexical_report([[]], search_counts={"search": {"dense": 3, "lexical": 0}})
    assert (report.lexical_leg_hit_rate_at_10.value, report.lexical_leg_hit_rate_at_10.n) == (0.0, 1)


def test_unanswerable_items_are_outside_the_lexical_rate():
    golden = [_item("en-noanswer-001", "en", answerable=False)]
    trace = _with_candidates(_trace("en-noanswer-001", [], refused=True), [("doc.en.md", QUOTE, {"lexical": 1})])
    report = _build(golden, [trace])
    assert report.items[0].lexical_hit_at_10 is None
    assert report.lexical_leg_hit_rate_at_10.n == 0


def test_legacy_traces_leave_every_pre_existing_field_unchanged_and_new_ones_empty():
    golden = [
        _item("zh-general-001", "zh", answerable=True),
        _item("en-noanswer-001", "en", answerable=False),
        _item("en-general-001", "en", answerable=True),
    ]
    traces = [
        _trace("zh-general-001", [("doc.zh.md", f"intro {QUOTE}")]),
        _trace("en-noanswer-001", [], refused=True),
        _trace("en-general-001", [], refused=True),
    ]
    report = _build(golden, traces)
    assert report.overall.recall_at_5.value == 0.5
    assert report.overall.false_refusal_rate.value == 0.5
    assert report.rerank_skipped_rate is not None and report.rerank_skipped_rate.value is None
    assert report.lexical_leg_hit_rate_at_10 is not None and report.lexical_leg_hit_rate_at_10.value is None
    assert all(item.rerank_status is None and item.lexical_hit_at_10 is None for item in report.items)


def test_reports_written_before_this_change_still_validate():
    golden = [_item("en-general-001", "en", answerable=True)]
    data = _build(golden, [_hit_trace("en-general-001")]).model_dump(mode="json")
    for key in V2_REPORT_FIELDS:
        del data[key]
    del data["overall"]["false_refusal_upper_95"]
    for group in ("by_language", "by_category", "by_language_category", "by_split", "by_provenance", "by_provenance_category"):
        for value in data[group].values():
            del value["false_refusal_upper_95"]
    for item in data["items"]:
        for key in V2_ITEM_FIELDS:
            del item[key]
    loaded = EvalReport.model_validate(data)
    assert loaded.by_doc_type == {} and loaded.by_question_kind == {}
    assert loaded.overall.false_refusal_upper_95 is None
    assert loaded.rerank_skipped_rate is None


def test_markdown_shows_new_slices_bounds_and_metrics(tmp_path: Path):
    golden = [_item("en-general-001", "en", answerable=True), _item("en-exact-001", "en", answerable=True, category="exact_term")]
    traces = [
        _with_status(_with_candidates(_hit_trace(item.id), [("doc.en.md", QUOTE, {"lexical": 2})]), "ok" if index else "timeout")
        for index, item in enumerate(golden)
    ]
    report = _build(golden, traces, doc_types={"doc.en.md": "product_technical"})
    _, md_path = write_report(report, tmp_path)
    md = md_path.read_text(encoding="utf-8")
    assert "## By document type" in md and "product_technical" in md
    assert "## By question kind" in md and "fact_lookup" in md
    assert "False refusal upper 95" in md
    assert "Rerank skipped rate: 0.500 (n=2)" in md
    assert "Lexical leg hit rate@10: 1.000 (n=2)" in md


def test_markdown_for_legacy_traces_says_n_a(tmp_path: Path):
    golden = [_item("en-general-001", "en", answerable=True)]
    _, md_path = write_report(_build(golden, [_hit_trace("en-general-001")]), tmp_path)
    md = md_path.read_text(encoding="utf-8")
    assert "Rerank skipped rate: n/a (n=0)" in md
    assert "Lexical leg hit rate@10: n/a (n=0)" in md


def test_corpus_loader_reads_doc_type_from_fixture_meta(tmp_path: Path):
    (tmp_path / "en").mkdir()
    (tmp_path / "en" / "a.md").write_text(
        '<!-- fixture-meta {"filename": "a.en.md", "doc_type": "financial_report"} -->\n# A\n\ntext\n', encoding="utf-8"
    )
    (tmp_path / "en" / "b.md").write_text("# B\n\ntext\n", encoding="utf-8")
    docs = {doc.relpath: doc for doc in load_corpus(tmp_path)}
    assert docs["en/a.md"].doc_type == "financial_report"
    assert docs["en/b.md"].doc_type is None


def test_runner_corpus_flag_feeds_doc_types_into_the_report(tmp_path: Path):
    corpus = tmp_path / "corpus"
    (corpus / "en").mkdir(parents=True)
    (corpus / "en" / "doc.md").write_text(
        '<!-- fixture-meta {"filename": "doc.en.md", "doc_type": "invoice_receipt"} -->\n# D\n\n' + QUOTE + "\n",
        encoding="utf-8",
    )
    golden = [_item("en-general-001", "en", answerable=True)]
    golden_path = tmp_path / "golden.jsonl"
    write_golden(golden_path, golden)
    traces_path = tmp_path / "traces.jsonl"
    traces_path.write_text(json.dumps(_hit_trace("en-general-001").model_dump(mode="json")) + "\n", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(_manifest().model_dump(mode="json")), encoding="utf-8")
    out = tmp_path / "out"
    code = main(
        ["score", "--traces", str(traces_path), "--golden", str(golden_path), "--manifest", str(manifest_path),
         "--out", str(out), "--corpus", str(corpus)]
    )
    assert code == 0
    report = EvalReport.model_validate_json((out / "report.json").read_text(encoding="utf-8"))
    assert set(report.by_doc_type) == {"invoice_receipt"}
