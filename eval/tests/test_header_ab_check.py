"""rag_eval.header_ab_check (plan 03.3-26, TPL-09 must-check from 03.3-25). Synthetic runs in invented vocabulary."""

import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem

import rag_eval.header_ab_check as check_module
from rag_eval.golden_io import write_golden
from rag_eval.metrics import score_items
from rag_eval.report import build_report

OTHER = "pellow-other.md"
SECRET_WORDS = ("quenmar", "tarvik", "zorrin")
ITEMS = 12


def _main(*argv: str) -> int:
    main = getattr(check_module, "main", None)
    assert callable(main), "rag_eval.header_ab_check.main is missing"
    return main(list(argv))


def _item(item_id: str, category: str, doc: str, quote: str, *, provenance: str, pair_of: str | None = None, split: str = "dev") -> GoldenItem:
    return GoldenItem(
        pair_of=pair_of,
        id=item_id,
        question="which quenmar holds tarvik",
        language="en",
        category=category,
        answerable=True,
        expected_answer="tarvik",
        gold_evidence=[{"document": doc, "section": "1. Bel", "quote": quote}],
        review_status="approved",
        provenance=provenance,
        split=split,
        tags=[],
    )


def _trace(item_id: str, kept: list[tuple[str, str]]) -> RagTrace:
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


def _golden(*, provenance: str = "synthetic_fixture", near_miss: int = ITEMS) -> list[GoldenItem]:
    items: list[GoldenItem] = [
        _item("nm-test", "cache_near_miss", "fendel-test.md", "fendel test zorrin", provenance=provenance, pair_of="gen-00", split="test")
    ]
    for index in range(near_miss):
        items.append(_item(f"nm-{index:02d}", "cache_near_miss", f"fendel-{index:02d}.md", f"fendel {index} zorrin", provenance=provenance, pair_of=f"gen-{index % ITEMS:02d}"))
    for index in range(ITEMS):
        items.append(_item(f"gen-{index:02d}", "general", f"brisk-{index:02d}.md", f"brisk {index} zorrin", provenance=provenance))
    for index in range(ITEMS):
        items.append(_item(f"tpl-{index:02d}", "templated_collection", f"kelmar-{index:02d}.pdf", f"kelmar {index} tarvik", provenance=provenance))
    return items


def _traces(golden: list[GoldenItem], *, miss: frozenset[str] = frozenset()) -> list[RagTrace]:
    """Every item hits at rank 1, except the ids in `miss`, whose gold chunk falls below rank 5."""
    traces: list[RagTrace] = []
    for item in golden:
        doc, quote = item.gold_evidence[0].document, item.gold_evidence[0].quote
        kept = [(OTHER, "drin")] * 5 + [(doc, quote)] if item.id in miss else [(doc, quote)]
        traces.append(_trace(item.id, kept))
    return traces


def _write_run(root: Path, name: str, golden: list[GoldenItem], traces: list[RagTrace], *, tier: str = "smoke", golden_sha: str = "g" * 64) -> Path:
    directory = root / name
    directory.mkdir(parents=True)
    golden_path = root / "golden.jsonl"
    if not golden_path.exists():
        write_golden(golden_path, golden)
    manifest = RunManifest.model_validate(
        {
            "run_id": name,
            "tier": tier,
            "created_at": "2026-01-01T00:00:00Z",
            "git_sha": None,
            "deployment_mode": "single",
            "embedder": {"id": "fixture-embedder", "version": "3", "source_sha256": "e" * 64},
            "corpus_sha256": name.ljust(64, "0")[:64],
            "golden_path": str(golden_path),
            "golden_sha256": golden_sha,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "sql_sha256": {},
            "request_options": {"max_results": 10},
            "effective_config_hash": "h" * 64,
            "run_config_hash": "r" * 64,
            "item_count": len(golden),
            "edge_errors": 0,
        }
    )
    report = build_report(manifest, score_items(traces, golden), golden, traces)
    (directory / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
    (directory / "traces.jsonl").write_text("".join(trace.model_dump_json() + "\n" for trace in traces), encoding="utf-8")
    (directory / "run.json").write_text(manifest.model_dump_json(), encoding="utf-8")
    return directory


def _world(tmp_path: Path, *, on_miss=frozenset(), off_miss=frozenset(), provenance="synthetic_fixture", tier="smoke", near_miss=ITEMS, on_golden_sha="g" * 64):
    golden = _golden(provenance=provenance, near_miss=near_miss)
    on = _write_run(tmp_path, "header-on", golden, _traces(golden, miss=on_miss), tier=tier, golden_sha=on_golden_sha)
    off = _write_run(tmp_path, "header-off", golden, _traces(golden, miss=off_miss), tier=tier)
    return on, off


def _run(tmp_path: Path, on: Path, off: Path, *extra: str) -> tuple[int, dict, str]:
    out = tmp_path / "out"
    code = _main("--header-on", str(on), "--header-off", str(off), "--out", str(out), *extra)
    result = json.loads((out / "header-ab.json").read_text(encoding="utf-8"))
    markdown = (out / "header-ab.md").read_text(encoding="utf-8")
    return code, result, markdown


def test_equal_runs_hold(tmp_path):
    on, off = _world(tmp_path)
    code, result, markdown = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 0
    assert result["verdict"] == "holds"
    assert result["target"] == {
        "slice": "category:cache_near_miss",
        "metric": "recall_at_5",
        "header_on": 1.0,
        "header_off": 1.0,
        "n_on": ITEMS,
        "n_off": ITEMS,
        "threshold": pytest.approx(0.98),
        "dropped": False,
        "paired_mean_difference": 0.0,
        "paired_interval": [0.0, 0.0],
        "worsened": 0,
        "improved": 0,
    }
    assert "holds" in markdown


def test_a_drop_beyond_the_band_on_the_near_miss_slice_reopens_d26(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"nm-00"}))
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 1
    assert result["verdict"] == "reopen_d26"
    assert result["target"]["dropped"] is True
    assert result["target"]["header_on"] == pytest.approx(11 / 12)
    assert result["target"]["worsened"] == 1
    assert "target_slice_drop" in result["reasons"]


def test_a_gain_with_the_header_on_holds(tmp_path):
    on, off = _world(tmp_path, off_miss=frozenset({"nm-00", "nm-01"}))
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 0
    assert result["verdict"] == "holds"
    assert result["target"]["improved"] == 2


def test_a_drop_on_another_non_templated_slice_also_reopens_d26(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"gen-00"}))
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 1
    assert result["verdict"] == "reopen_d26"
    assert result["target"]["dropped"] is False
    assert any(reason.startswith("other_slice_drop") for reason in result["reasons"])
    assert any("category:general" in line for line in result["other_drops"])


def test_templated_items_are_left_out_as_in_the_phase_gate(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"tpl-00", "tpl-01"}))
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 0
    assert result["verdict"] == "holds"
    assert result["excluded_categories"] == ["templated_collection"]


def test_too_few_near_miss_items_is_missing_data(tmp_path):
    on, off = _world(tmp_path, near_miss=4)
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 2
    assert result["verdict"] == "missing_data"
    assert "slice_too_small" in result["reasons"]


def test_real_population_refuses_fixture_runs(tmp_path):
    on, off = _world(tmp_path)
    code, result, _ = _run(tmp_path, on, off)
    assert code == 2
    assert result["verdict"] == "missing_data"
    assert "not_live_run" in result["reasons"]
    assert "not_real_population" in result["reasons"]


def test_real_population_accepts_live_runs_of_production_items(tmp_path):
    on, off = _world(tmp_path, provenance="production", tier="live")
    code, result, _ = _run(tmp_path, on, off)
    assert code == 0
    assert result["verdict"] == "holds"
    assert result["population"] == "real"


def test_different_golden_manifests_are_refused(tmp_path):
    on, off = _world(tmp_path, on_golden_sha="f" * 64)
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 2
    assert "manifest_mismatch" in result["reasons"]


def test_output_carries_no_text_and_real_runs_no_item_ids(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"nm-00"}), provenance="production", tier="live")
    code, result, markdown = _run(tmp_path, on, off)
    assert code == 1
    blob = json.dumps(result) + markdown
    for word in SECRET_WORDS + ("fendel", "brisk", "kelmar", OTHER):
        assert word not in blob
    assert "nm-00" not in blob


def test_fixture_runs_list_the_worsened_item_ids(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"nm-03"}))
    _, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert result.get("worsened_items") == ["nm-03"]


def test_missing_run_directory_exits_2(tmp_path, capsys):
    on, _ = _world(tmp_path)
    code = _main("--header-on", str(on), "--header-off", str(tmp_path / "absent"), "--out", str(tmp_path / "out"))
    assert code == 2
    assert "absent" in capsys.readouterr().err


def test_the_header_off_run_config_differs_from_recommended_only_in_the_header():
    repo = Path(__file__).resolve().parents[2]
    runs = repo / "eval" / "config" / "runs"
    recommended = json.loads((runs / "tpl-recommended.json").read_text(encoding="utf-8"))["env"]
    no_header = json.loads((runs / "tpl-recommended-no-header.json").read_text(encoding="utf-8"))["env"]
    assert recommended["RAG_ATTRIBUTE_HEADER"] == "true"
    assert no_header == {**recommended, "RAG_ATTRIBUTE_HEADER": "false"}


def test_the_rehearsal_spec_runs_both_arms_in_ingest_mode():
    from rag_eval.phase_compare import SwitchComparisonSpec

    repo = Path(__file__).resolve().parents[2]
    spec = SwitchComparisonSpec.model_validate_json((repo / "eval" / "config" / "tpl09-header-ab-comparison.json").read_text(encoding="utf-8"))
    by_name = {run.name: run for run in spec.runs}
    assert set(by_name) == {"tpl-recommended-ingest", "tpl-recommended-no-header-ingest"}
    assert by_name["tpl-recommended-no-header-ingest"].base == "eval/config/runs/tpl-recommended-no-header.json"
    assert all(run.fixture_mode == "ingest" and run.switches == {"RAG_CITATIONS": "true"} for run in spec.runs)


def test_paired_counts_read_the_gated_split_only(tmp_path):
    on, off = _world(tmp_path, on_miss=frozenset({"nm-test"}))
    code, result, _ = _run(tmp_path, on, off, "--population", "fixture")
    assert code == 0
    assert result["target"]["worsened"] == 0
    assert result["target"]["paired_mean_difference"] == 0.0


def test_real_population_accepts_human_items(tmp_path):
    on, off = _world(tmp_path, provenance="human", tier="live")
    code, result, _ = _run(tmp_path, on, off)
    assert code == 0
    assert result["verdict"] == "holds"
