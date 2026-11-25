from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport

from rag_eval.gate import evaluate_gate
from rag_eval.metrics import score_items
from rag_eval.golden_io import load_golden
from rag_eval.native_review import counts_in_gated_slices, review_backlog
from rag_eval.paired import item_metrics, paired_report
from rag_eval.paths import REPO_ROOT
from rag_eval.report import _render_markdown, build_report

QUOTE = "the sample value is listed in row seven"
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
APPROVED = {"origin": "llm_drafted", "status": "approved", "reviewer": "Reviewer A", "reviewed_at": "2026-11-20T00:00:00Z"}
PENDING = {"origin": "llm_drafted", "status": "pending"}


def _golden(
    item_id: str,
    language: str,
    *,
    native_review: dict | None = None,
    evidence_language: str | None = None,
    provenance: str = "synthetic_fixture",
    split: str = "dev",
) -> GoldenItem:
    data: dict = {
        "id": item_id,
        "question": "Which value is listed?",
        "language": language,
        "category": "cross_lingual" if evidence_language else "general",
        "answerable": True,
        "expected_answer": "the value",
        "gold_evidence": [{"document": f"doc.{evidence_language or language}.md", "section": "s", "quote": QUOTE}],
        "review_status": "approved",
        "provenance": provenance,
        "split": split,
    }
    if evidence_language:
        data["evidence_language"] = evidence_language
    if native_review is not None:
        data["native_review"] = native_review
    return GoldenItem.model_validate(data)


def _trace(item_id: str, *, hit: bool) -> RagTrace:
    content = f"intro {QUOTE} outro" if hit else "unrelated text"
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
                    "rank": 1,
                    "chunk_id": "c1",
                    "document_id": "d-1",
                    "document_name": "doc.zh.md" if item_id.startswith("zh") else "doc.en.md",
                    "content": content,
                    "similarity": 0.5,
                    "kept_by": "similarity",
                }
            ],
            "used_documents": [],
            "context": "",
            "refused": False,
            "refusal_reason": None,
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


def _manifest() -> RunManifest:
    return RunManifest.model_validate(
        {
            "run_id": "run-native",
            "tier": "smoke",
            "created_at": "2026-01-01T00:00:00Z",
            "git_sha": None,
            "deployment_mode": "single",
            "embedder": {"id": "fixture-embedder", "version": "3", "source_sha256": "e" * 64},
            "corpus_sha256": "c" * 64,
            "golden_path": "eval/fixtures/golden.jsonl",
            "golden_sha256": "g" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "sql_sha256": {},
            "request_options": {"max_results": 10},
            "effective_config_hash": "h" * 64,
            "run_config_hash": "r" * 64,
            "item_count": 3,
            "edge_errors": 0,
        }
    )


def _stat(mean: float) -> dict:
    return {"mean": mean, "spread": 0.0, "runs": [mean, mean, mean], "n": 1}


def _baseline() -> Baseline:
    hit = {"recall_at_5": 1.0, "recall_at_10": 1.0, "mrr": 1.0, "false_refusal_rate": 0.0}
    slices = {
        name: {metric: _stat(value) for metric, value in hit.items()}
        for name in ("overall", "language:en", "language:zh")
    }
    rows = {
        item_id: {metric: [value] * 3 for metric, value in {**hit, "correct_refusal_rate": None}.items()}
        for item_id in ("en-general-001", "zh-general-001", "zh-general-002")
    }
    return Baseline.model_validate(
        {
            "spread_kind": "stdev_ddof1",
            "tier": "smoke",
            "deployment_mode": "single",
            "request_options": {"max_results": 10},
            "corpus_sha256": "c" * 64,
            "golden_sha256": "g" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-embedder",
            "embedder_version": 3,
            "embedder_source_sha256": "e" * 64,
            "run_config_hash": "r" * 64,
            "runs": [
                {"run_id": f"run-{i}", "run_config_hash": "r" * 64, "git_sha": None, "created_at": "2026-01-01T00:00:00Z"}
                for i in range(3)
            ],
            "slices": slices,
            "items": rows,
        }
    )


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def _run(review: dict | None) -> EvalReport:
    golden = [
        _golden("en-general-001", "en"),
        _golden("zh-general-001", "zh"),
        _golden("zh-general-002", "zh", native_review=review),
    ]
    traces = [
        _trace("en-general-001", hit=True),
        _trace("zh-general-001", hit=True),
        _trace("zh-general-002", hit=False),
    ]
    return build_report(_manifest(), score_items(traces, golden), golden, supported_languages=("en", "zh", "it"))


def test_pending_drafted_zh_item_is_report_only_and_the_gate_passes():
    report = _run(PENDING)
    result = evaluate_gate(report, _baseline(), _noise())
    assert result.passed, result.offenders
    assert report.by_language["zh"].recall_at_5.n == 1
    assert report.overall.recall_at_5.n == 2
    marked = {item.item_id: item.report_only_reason for item in report.items}
    assert marked["zh-general-002"] == "native_review_pending"
    assert marked["zh-general-001"] is None
    markdown = _render_markdown(report)
    assert "## Report-only items (native review pending)" in markdown
    assert "zh-general-002" in markdown.split("## Report-only items (native review pending)", 1)[1]


def test_the_same_item_approved_counts_and_fails_the_gate():
    report = _run(APPROVED)
    result = evaluate_gate(report, _baseline(), _noise())
    assert not result.passed
    assert {offender.slice for offender in result.offenders} >= {"language:zh", "overall"}
    assert report.by_language["zh"].recall_at_5.n == 2
    assert all(item.report_only_reason is None for item in report.items)


def test_paired_comparison_drops_report_only_items_from_every_slice():
    pending = paired_report(_run(PENDING), _baseline(), _noise())
    approved = paired_report(_run(APPROVED), _baseline(), _noise())
    assert pending is not None and approved is not None
    assert pending.slices["language:zh"]["recall_at_5"].n == 1
    assert pending.slices["overall"]["recall_at_5"].n == 2
    assert pending.all_zero is True
    assert approved.slices["language:zh"]["recall_at_5"].n == 2
    assert approved.all_zero is False


def test_report_only_item_never_enters_a_gated_denominator():
    report = _run(PENDING)
    counting = [item for item in report.items if item.split == "dev" and counts_in_gated_slices(item)]
    answerable = [item for item in counting if item_metrics(item)["recall_at_5"] is not None]
    assert report.overall.recall_at_5.n == len(answerable) == 2
    assert report.overall.recall_at_5.value == 1.0


def test_english_and_native_origin_items_always_count():
    assert counts_in_gated_slices(_golden("en-general-009", "en", native_review=PENDING))
    native = {"origin": "native", "status": "pending"}
    assert counts_in_gated_slices(_golden("zh-general-009", "zh", native_review=native))
    assert counts_in_gated_slices(_golden("it-general-009", "it", native_review=native))
    translated = {"origin": "machine_translated", "status": "pending"}
    assert not counts_in_gated_slices(_golden("it-general-010", "it", native_review=translated))


def test_items_without_native_review_count_as_before():
    for language in ("en", "zh", "it"):
        assert counts_in_gated_slices(_golden(f"{language}-general-011", language))


def test_cross_lingual_item_with_a_pending_drafted_side_does_not_count():
    # question side en needs no review; the zh evidence side is drafted and pending
    pending = _golden("en-cross-001", "en", evidence_language="zh", native_review=PENDING)
    assert not counts_in_gated_slices(pending)
    approved = _golden("zh-cross-002", "zh", evidence_language="it", native_review=APPROVED)
    assert counts_in_gated_slices(approved)
    translated = {"origin": "machine_translated", "status": "pending"}
    assert not counts_in_gated_slices(_golden("it-cross-003", "it", evidence_language="en", native_review=translated))


def test_item_counts_from_the_moment_it_is_approved_and_not_before():
    pending = _golden("zh-general-012", "zh", native_review=PENDING)
    approved = GoldenItem.model_validate({**pending.model_dump(mode="json"), "native_review": APPROVED})
    assert not counts_in_gated_slices(pending)
    assert counts_in_gated_slices(approved)


def _backlog_items() -> list[GoldenItem]:
    return [
        _golden("zh-general-020", "zh", native_review=PENDING),
        _golden("it-general-021", "it"),
        _golden("zh-general-003", "zh"),
        _golden("en-general-022", "en"),
        _golden("it-general-004", "it", native_review=APPROVED),
        _golden("zh-general-005", "zh", native_review={"origin": "native", "status": "pending"}),
        _golden("it-general-006", "it", provenance="human"),
        _golden("en-cross-007", "en", evidence_language="it", native_review=PENDING),
        _golden("it-general-001", "it", native_review={"origin": "machine_translated", "status": "pending"}),
    ]


def test_backlog_lists_pending_and_existing_unreviewed_items_by_language_then_id():
    backlog = review_backlog(_backlog_items())
    assert [(entry.language, entry.item_id, entry.state) for entry in backlog] == [
        ("it", "en-cross-007", "pending"),
        ("it", "it-general-001", "pending"),
        ("it", "it-general-021", "existing_unreviewed"),
        ("zh", "zh-general-003", "existing_unreviewed"),
        ("zh", "zh-general-020", "pending"),
    ]


def test_backlog_order_is_identical_across_runs_and_input_orders():
    items = _backlog_items()
    first = review_backlog(items)
    assert review_backlog(list(reversed(items))) == first
    assert review_backlog(items) == first


def test_existing_golden_files_keep_counting_and_list_their_zh_it_items_as_backlog():
    for path in (REPO_ROOT / "eval/fixtures/golden.jsonl", REPO_ROOT / "eval/fixtures/ingest/golden-ingest.jsonl"):
        items = load_golden(path)
        # 03.2-30's drafted zh and it table_split items await native review, so they alone are report-only.
        drafted_pending = {
            item.id for item in items if item.native_review is not None and item.native_review.status == "pending"
        }
        assert {item.id for item in items if not counts_in_gated_slices(item)} == drafted_pending
        backlog = review_backlog(items)
        assert backlog and all(
            entry.state == ("pending" if entry.item_id in drafted_pending else "existing_unreviewed") for entry in backlog
        )
        expected = {
            item.id
            for item in items
            if item.provenance == "synthetic_fixture" and {item.language, item.evidence_language} & {"zh", "it"}
        }
        assert {entry.item_id for entry in backlog} == expected


def test_report_prints_the_backlog_with_counts_per_language_and_ids():
    report = _run(PENDING)
    assert report.native_review_backlog is not None
    markdown = _render_markdown(report)
    section = markdown.split("## Native review backlog", 1)[1].split("\n## ", 1)[0]
    assert "| zh | 1 | 1 | 2 |" in section
    assert "| it | 0 | 0 | 0 |" in section
    assert "| zh-general-001 | zh | existing, not yet reviewed, still counting |" in section
    assert "| zh-general-002 | zh | pending, report-only until approved |" in section


def test_report_prints_an_empty_backlog_with_count_zero():
    golden = [_golden("en-general-001", "en")]
    report = build_report(
        _manifest(), score_items([_trace("en-general-001", hit=True)], golden), golden, supported_languages=("en",)
    )
    assert report.native_review_backlog == []
    section = _render_markdown(report).split("## Native review backlog", 1)[1].split("\n## ", 1)[0]
    assert "Items: 0" in section
    assert "| zh | 0 | 0 | 0 |" in section


def test_gated_slice_with_no_counting_items_is_report_only_without_dividing_by_zero():
    golden = [_golden("en-general-001", "en"), _golden("zh-general-002", "zh", native_review=PENDING)]
    traces = [_trace("en-general-001", hit=True), _trace("zh-general-002", hit=False)]
    report = build_report(_manifest(), score_items(traces, golden), golden, supported_languages=("en", "zh", "it"))
    assert "zh" not in report.by_language
    result = evaluate_gate(report, _baseline(), _noise())
    assert result.passed
    assert "language:zh:recall_at_5" in result.skipped
    paired = paired_report(report, _baseline(), _noise())
    assert paired is not None and "language:zh" not in paired.slices
    markdown = _render_markdown(report)
    assert "| language:zh | 0 | 1 | report-only (n below 1) |" in markdown


def test_cross_lingual_report_only_item_leaves_the_pair_slice():
    golden = [
        _golden("en-cross-001", "en", evidence_language="zh", native_review=PENDING),
        _golden("en-cross-002", "en", evidence_language="zh"),
    ]
    traces = [_trace("en-cross-001", hit=False), _trace("en-cross-002", hit=False)]
    report = build_report(_manifest(), score_items(traces, golden), golden, supported_languages=("en", "zh", "it"))
    assert report.by_language_pair["en->zh"].recall_at_5.n == 1
    assert report.by_category["cross_lingual"].recall_at_5.n == 1


def test_paired_denominators_equal_the_counting_subset_size():
    report = _run(PENDING)
    paired = paired_report(report, _baseline(), _noise())
    assert paired is not None
    counting = [item for item in report.items if counts_in_gated_slices(item)]
    for language in ("en", "zh"):
        n = sum(1 for item in counting if item.language == language)
        assert paired.slices[f"language:{language}"]["recall_at_5"].n == n
        assert report.by_language[language].recall_at_5.n == n
