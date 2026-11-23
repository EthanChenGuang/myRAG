import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import EvalReport

from rag_eval.golden_io import golden_sha256, load_golden, write_golden
from rag_eval.metrics import score_items
from rag_eval.report import build_report, write_report
from rag_eval.runner import main

QUOTE = "refunds are accepted within thirty days"


def _item(item_id: str, language: str, *, answerable: bool, category: str | None = None) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category or ("general" if answerable else "no_answer"),
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": f"doc.{language}.md", "section": "s", "quote": QUOTE}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


def _trace(item_id: str | None, kept: list[tuple[str, str]], *, refused: bool = False) -> RagTrace:
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


def _manifest(golden_hash: str = "g" * 64) -> RunManifest:
    return RunManifest.model_validate(
        {
            "run_id": "run-test",
            "tier": "smoke",
            "created_at": "2026-01-01T00:00:00Z",
            "git_sha": None,
            "deployment_mode": "single",
            "embedder": {"id": "fixture-embedder", "version": "3", "source_sha256": "e" * 64},
            "corpus_sha256": "c" * 64,
            "golden_path": "eval/fixtures/golden.jsonl",
            "golden_sha256": golden_hash,
            "sql_sha256": {},
            "request_options": {"max_results": 10},
            "effective_config_hash": "h" * 64,
            "run_config_hash": "r" * 64,
            "item_count": 4,
            "edge_errors": 0,
        }
    )


def _four_items() -> tuple[list[GoldenItem], list[RagTrace]]:
    golden = [
        _item("zh-general-001", "zh", answerable=True),
        _item("it-general-001", "it", answerable=True),
        _item("en-no_answer-001", "en", answerable=False),
        _item("en-general-001", "en", answerable=True),
    ]
    traces = [
        _trace("zh-general-001", [("doc.zh.md", f"intro {QUOTE} outro")]),
        _trace("it-general-001", [("doc.it.md", "unrelated text")]),
        _trace("en-no_answer-001", [], refused=True),
        _trace("en-general-001", [], refused=True),
    ]
    return golden, traces


def _report(golden: list[GoldenItem] | None = None, traces: list[RagTrace] | None = None) -> EvalReport:
    if golden is None or traces is None:
        golden, traces = _four_items()
    return build_report(_manifest(), score_items(traces, golden), golden)


def test_build_report_validates_and_copies_manifest_fields():
    report = _report()
    EvalReport.model_validate(report.model_dump(mode="json"))
    assert report.k_values == [5, 10]
    assert (report.run_id, report.tier, report.deployment_mode) == ("run-test", "smoke", "single")
    assert report.run_config_hash == "r" * 64
    assert report.corpus_sha256 == "c" * 64
    assert report.embedder_id == "fixture-embedder"
    assert report.embedder_version == 3
    assert report.request_options.max_results == 10
    assert len(report.items) == 4
    assert set(report.by_language) == {"zh", "it", "en"}
    assert set(report.by_language_category) == {"zh/general", "it/general", "en/no_answer", "en/general"}
    assert report.overall.recall_at_5.n == 3
    assert report.overall.recall_at_5.value == pytest.approx(1 / 3)


def test_build_report_without_embedder_leaves_embedder_fields_empty():
    golden, traces = _four_items()
    manifest = _manifest().model_copy(update={"embedder": None})
    report = build_report(manifest, score_items(traces, golden), golden)
    assert report.embedder_id is None
    assert report.embedder_version is None


def test_write_report_json_is_sorted_unrounded_and_valid(tmp_path: Path):
    json_path, md_path = write_report(_report(), tmp_path / "out")
    assert json_path.name == "report.json" and md_path.name == "report.md"
    text = json_path.read_text(encoding="utf-8")
    data = json.loads(text)
    assert list(data) == sorted(data)
    assert data["overall"]["recall_at_5"]["value"] == 1 / 3
    assert "0.3333333333333333" in text
    EvalReport.model_validate(data)


def test_write_report_markdown_has_tables_rounding_and_na(tmp_path: Path):
    _, md_path = write_report(_report(), tmp_path)
    md = md_path.read_text(encoding="utf-8")
    assert "## Overall" in md and "## By language" in md and "## By category" in md
    assert "## By language and category" in md
    assert "0.333 (n=3)" in md
    assert "1.000 (n=1)" in md
    assert "n/a (n=0)" in md
    assert "0.3333333" not in md
    assert "categories are report-only" in md.lower()
    assert "only overall and per-language slices gate" in md.lower()


def test_write_report_is_byte_identical_across_two_writes(tmp_path: Path):
    report = _report()
    first = write_report(report, tmp_path / "a")
    second = write_report(report, tmp_path / "b")
    assert first[0].read_bytes() == second[0].read_bytes()
    assert first[1].read_bytes() == second[1].read_bytes()


def test_notes_carry_the_chinese_empty_term_quirk_only_with_zh_items(tmp_path: Path):
    with_zh = _report()
    assert any("Filter 1" in note and "empty" in note for note in with_zh.notes)
    _, md_path = write_report(with_zh, tmp_path)
    assert "Filter 1" in md_path.read_text(encoding="utf-8")

    golden = [_item("en-general-001", "en", answerable=True)]
    traces = [_trace("en-general-001", [("doc.en.md", QUOTE)])]
    without_zh = build_report(_manifest(), score_items(traces, golden), golden)
    assert not any("Filter 1" in note for note in without_zh.notes)


def _write_inputs(
    tmp_path: Path, traces: list[RagTrace], golden: list[GoldenItem] | None = None
) -> tuple[Path, Path, Path, Path]:
    if golden is None:
        golden, _ = _four_items()
    golden_path = tmp_path / "golden.jsonl"
    write_golden(golden_path, golden)
    traces_path = tmp_path / "traces.jsonl"
    traces_path.write_text(
        "".join(json.dumps(t.model_dump(mode="json"), sort_keys=True) + "\n" for t in traces), encoding="utf-8"
    )
    manifest_path = tmp_path / "run.json"
    manifest_path.write_text(_manifest(golden_sha256(golden_path)).model_dump_json(), encoding="utf-8")
    return traces_path, golden_path, manifest_path, tmp_path / "out"


def _score_args(traces: Path, golden: Path, manifest: Path, out: Path) -> list[str]:
    return ["score", "--traces", str(traces), "--golden", str(golden), "--manifest", str(manifest), "--out", str(out)]


def test_score_cli_writes_report_and_prints_overall_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _, traces = _four_items()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, traces)
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 0
    assert (out / "report.json").is_file() and (out / "report.md").is_file()
    EvalReport.model_validate_json((out / "report.json").read_text(encoding="utf-8"))
    printed = capsys.readouterr().out
    assert "overall" in printed and "recall@5" in printed
    assert len(load_golden(golden_path)) == 4


def test_score_cli_exits_2_naming_a_golden_item_without_trace(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _, traces = _four_items()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, traces[:-1])
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 2
    assert "en-general-001" in capsys.readouterr().err
    assert not (out / "report.json").exists()


def test_score_cli_exits_2_naming_a_duplicated_trace(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _, traces = _four_items()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, [*traces, traces[0]])
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 2
    assert "zh-general-001" in capsys.readouterr().err


def test_score_cli_exits_2_naming_a_trace_with_unknown_item(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _, traces = _four_items()
    stray = _trace("ghost-item-001", [])
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, [*traces, stray])
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 2
    assert "ghost-item-001" in capsys.readouterr().err


def test_score_cli_exits_2_for_a_trace_without_item_id(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    _, traces = _four_items()
    traces_path, golden_path, manifest_path, out = _write_inputs(tmp_path, [*traces, _trace(None, [])])
    assert main(_score_args(traces_path, golden_path, manifest_path, out)) == 2
    assert "item_id" in capsys.readouterr().err


def test_score_cli_exits_2_for_unreadable_inputs(tmp_path: Path, capsys: pytest.CaptureFixture[str]):
    missing = tmp_path / "nope.jsonl"
    assert main(_score_args(missing, missing, missing, tmp_path / "out")) == 2
    assert capsys.readouterr().err.strip()


def test_help_lists_the_score_subcommand(capsys: pytest.CaptureFixture[str]):
    with pytest.raises(SystemExit) as exc:
        main(["--help"])
    assert exc.value.code == 0
    assert "score" in capsys.readouterr().out
