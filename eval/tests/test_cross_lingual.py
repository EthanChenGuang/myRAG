from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport

import rag_eval.baseline as baseline_module
import rag_eval.gate as gate_module
from rag_eval.corpus import load_corpus
from rag_eval.gate import evaluate_gate
from rag_eval.golden_io import load_golden
from rag_eval.metrics import score_items
from rag_eval.paired import item_metrics, paired_report
from rag_eval.paths import REPO_ROOT
from rag_eval.report import build_report, write_report

NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
QUOTE = "refunds are accepted within thirty days"


def _noise() -> NoiseConfig:
    return NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))


def _item(item_id: str, language: str, evidence_language: str | None, *, category: str = "cross_lingual") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category,
        answerable=True,
        expected_answer="answer",
        gold_evidence=[{"document": f"doc.{evidence_language or language}.md", "section": "s", "quote": QUOTE}],
        evidence_language=evidence_language,
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _trace(item_id: str, document: str, hit: bool) -> RagTrace:
    kept = [
        {
            "rank": 1,
            "chunk_id": "c1",
            "document_id": f"d-{document}",
            "document_name": document,
            "content": f"intro {QUOTE} outro" if hit else "unrelated text",
            "similarity": 0.5,
            "kept_by": "similarity",
        }
    ]
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
            "kept": kept,
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
            "run_id": "run-xl",
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
            "item_count": 4,
            "edge_errors": 0,
        }
    )


def _report(hit_en_zh: bool = True) -> EvalReport:
    golden = [
        _item("xl-en-zh-01", "en", "zh"),
        _item("xl-en-zh-02", "en", "zh"),
        _item("xl-it-en-01", "it", "en"),
        _item("en-general-001", "en", None, category="general"),
    ]
    traces = [
        _trace("xl-en-zh-01", "doc.zh.md", hit_en_zh),
        _trace("xl-en-zh-02", "doc.zh.md", hit_en_zh),
        _trace("xl-it-en-01", "doc.en.md", True),
        _trace("en-general-001", "doc.en.md", True),
    ]
    return build_report(_manifest(), score_items(golden=golden, traces=traces), golden)


def test_build_report_slices_cross_lingual_items_by_language_pair():
    report = _report()
    assert sorted(report.by_language_pair) == ["en->zh", "it->en"]
    assert report.by_language_pair["en->zh"].recall_at_5.n == 2
    assert report.by_language_pair["it->en"].recall_at_5.n == 1
    assert report.by_language_pair["en->zh"].recall_at_5.value == 1.0
    assert report.by_category["cross_lingual"].recall_at_5.n == 3
    by_id = {item.item_id: item for item in report.items}
    assert by_id["xl-en-zh-01"].evidence_language == "zh"
    assert by_id["en-general-001"].evidence_language is None


def test_report_without_cross_lingual_items_has_no_pair_slices():
    golden = [_item("en-general-001", "en", None, category="general")]
    report = build_report(_manifest(), score_items([_trace("en-general-001", "doc.en.md", True)], golden), golden)
    assert report.by_language_pair == {}


def test_gate_and_baseline_expose_pair_slices_named_pair_question_to_evidence():
    report = _report()
    for slices in (gate_module._report_slices(report), baseline_module._slices(report)):
        assert "pair:en->zh" in slices
        assert "pair:it->en" in slices
        assert "category:cross_lingual" in slices


def test_pair_and_cross_lingual_slices_are_gated_like_language_slices_and_other_categories_are_not():
    noise = _noise()
    gated = gate_module._is_gated
    assert gated("pair:en->zh", noise)
    assert gated("category:cross_lingual", noise)
    assert gated("language:en", noise)
    assert not gated("category:general", noise)


def _baseline_with_pair(report: EvalReport, mean: float, spread: float) -> Baseline:
    slices = {}
    for name, metrics in gate_module._report_slices(report).items():
        slices[name] = {
            metric: {
                "mean": getattr(metrics, metric).value,
                "spread": 0.0,
                "runs": [getattr(metrics, metric).value] * 3,
                "n": getattr(metrics, metric).n,
            }
            for metric in METRICS
        }
    slices["pair:en->zh"]["recall_at_5"] = {"mean": mean, "spread": spread, "runs": [mean] * 3, "n": 2}
    return Baseline.model_validate(
        {
            "spread_kind": "stdev_ddof1",
            "tier": "smoke",
            "deployment_mode": "single",
            "request_options": {"max_results": 10},
            "corpus_sha256": report.corpus_sha256,
            "golden_sha256": report.golden_sha256,
            "golden_filter": report.golden_filter.model_dump(),
            "embedder_id": report.embedder_id,
            "embedder_version": report.embedder_version,
            "embedder_source_sha256": report.embedder_source_sha256,
            "run_config_hash": report.run_config_hash,
            "runs": [
                {"run_id": f"run-{i}", "run_config_hash": report.run_config_hash, "git_sha": None, "created_at": "2026-01-01T00:00:00Z"}
                for i in range(3)
            ],
            "slices": slices,
        }
    )


def test_gate_fails_a_pair_slice_that_drops_beyond_the_noise_floor_when_spread_is_zero():
    report = _report(hit_en_zh=False)
    assert report.by_language_pair["en->zh"].recall_at_5.value == 0.0
    result = evaluate_gate(report, _baseline_with_pair(report, mean=0.0201, spread=0.0), _noise())
    assert not result.passed
    assert [(o.slice, o.metric) for o in result.offenders] == [("pair:en->zh", "recall_at_5")]


def test_gate_passes_a_pair_slice_drop_exactly_at_the_floor():
    report = _report(hit_en_zh=False)
    result = evaluate_gate(report, _baseline_with_pair(report, mean=0.02, spread=0.0), _noise())
    assert result.passed and not result.offenders


def test_gate_noise_band_widens_with_spread_for_a_pair_slice():
    report = _report(hit_en_zh=False)
    result = evaluate_gate(report, _baseline_with_pair(report, mean=0.2, spread=0.1), _noise())
    assert result.passed


def test_paired_report_carries_pair_slices_with_zero_difference_against_itself():
    report = _report()
    baseline_items = {
        item.item_id: {metric: [value] * 3 for metric, value in item_metrics(item).items()} for item in report.items
    }
    baseline = _baseline_with_pair(report, mean=1.0, spread=0.0).model_copy(update={"items": baseline_items})
    paired = paired_report(report, baseline, _noise())
    assert paired is not None and paired.all_zero
    assert paired.slices["pair:en->zh"]["recall_at_5"].n == 2
    assert paired.slices["category:cross_lingual"]["recall_at_5"].n == 3


def test_markdown_renders_the_language_pair_table_only_when_the_mapping_is_non_empty(tmp_path):
    _, with_pairs = write_report(_report(), tmp_path / "with")
    text = with_pairs.read_text(encoding="utf-8")
    assert "## By language pair" in text
    assert "| en->zh |" in text and "| it->en |" in text

    golden = [_item("en-general-001", "en", None, category="general")]
    plain = build_report(_manifest(), score_items([_trace("en-general-001", "doc.en.md", True)], golden), golden)
    _, without_pairs = write_report(plain, tmp_path / "without")
    assert "By language pair" not in without_pairs.read_text(encoding="utf-8")



def test_no_cross_lingual_gold_document_has_a_translated_twin_in_another_language_folder():
    corpus_dir = REPO_ROOT / "eval/fixtures/corpus"
    stem_languages: dict[str, set[str]] = {}
    for doc in load_corpus(corpus_dir):
        stem_languages.setdefault(doc.relpath.split("/", 1)[1].split(".", 1)[0], set()).add(doc.language)
    items = [item for item in load_golden(REPO_ROOT / "eval/fixtures/golden.jsonl") if item.category == "cross_lingual"]
    assert items
    documents = {doc.filename: doc for doc in load_corpus(corpus_dir)}
    for item in items:
        for span in item.gold_evidence:
            stem = documents[span.document].relpath.split("/", 1)[1].split(".", 1)[0]
            assert stem_languages[stem] == {item.evidence_language}, (item.id, span.document, stem_languages[stem])


def test_the_parallel_document_check_rejects_a_stem_that_exists_in_two_languages():
    corpus_dir = REPO_ROOT / "eval/fixtures/corpus"
    stem_languages: dict[str, set[str]] = {}
    for doc in load_corpus(corpus_dir):
        stem_languages.setdefault(doc.relpath.split("/", 1)[1].split(".", 1)[0], set()).add(doc.language)
    assert stem_languages["product-specs"] == {"zh", "en", "it"}
    assert stem_languages["refund-policy"] == {"zh", "en", "it"}
