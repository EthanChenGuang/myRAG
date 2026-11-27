"""rag_eval.phase33_gate (plan 03.3-22; D-36). Synthetic reports, traces and golden items in invented vocabulary."""

import json
from hashlib import sha256
from pathlib import Path

import pytest
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import MetricValue

import rag_eval.phase33_gate as gate_module
from rag_eval.golden_io import write_golden
from rag_eval.metrics import score_items
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import build_report

REPO = Path(__file__).resolve().parents[2]
NOISE = REPO / "eval" / "config" / "noise.json"
GATES_FILE = REPO / "eval" / "config" / "phase33-gates.json"
COMPARISON_FILE = REPO / "eval" / "config" / "phase33-comparison.json"
OTHER = "pellow-other.pdf"
SECRET_WORDS = ("quenmar", "tarvik", "zorrin")
DEV_ITEMS = 12


def _main(*argv: str) -> int:
    main = getattr(gate_module, "main", None)
    assert callable(main), "rag_eval.phase33_gate.main is missing"
    return main(list(argv))


# ---------- synthetic data


def _item(item_id: str, tag: str | None, doc: str, quote: str, *, category: str = "templated_collection", split: str = "dev") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="which quenmar holds tarvik",
        language="en",
        category=category,
        answerable=True,
        expected_answer="tarvik",
        gold_evidence=[{"document": doc, "section": "1. Bel", "quote": quote}],
        review_status="approved",
        provenance="synthetic_fixture",
        split=split,
        tags=[tag] if tag else [],
    )


def _citation(doc: str, chunk_id: str) -> dict:
    return {
        "n": 1,
        "alias": "S1",
        "chunkIds": [chunk_id],
        "documentId": f"d-{doc}",
        "documentName": doc,
        "quote": "zorrin",
        "quoteHash": "a" * 64,
        "strategy": "chunk-alias",
    }


def _trace(item_id: str, kept: list[tuple[str, str]], *, candidates=None, cite: str | None = None) -> RagTrace:
    kept_rows = [
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
            "kept": kept_rows,
            "used_documents": [],
            "context": "[S1] zorrin" if cite else "",
            "refused": False,
            "refusal_reason": None,
            "citations": [_citation(cite, kept_rows[0]["chunk_id"])] if cite else [],
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


def _golden(*, templated_split: str = "dev") -> list[GoldenItem]:
    items: list[GoldenItem] = []
    for index in range(DEV_ITEMS):
        doc = f"kelmar-{index:02d}.pdf"
        items.append(_item(f"tpl-named-{index:02d}", "feature:attribute_named", doc, f"quenmar {index} tarvik", split=templated_split))
        items.append(_item(f"tpl-variant-{index:02d}", "feature:variant", doc, f"variant {index} tarvik", split=templated_split))
        items.append(_item(f"tpl-quantity-{index:02d}", "feature:quantity", doc, f"amount {index} tarvik", split=templated_split))
        items.append(_item(f"gen-{index:02d}", None, "fendel.md", f"fendel fact {index}", category="general"))
    return items


def _traces(golden: list[GoldenItem], *, bad: frozenset[str] = frozenset(), lexical: bool = True, templated: bool = True) -> list[RagTrace]:
    traces: list[RagTrace] = []
    for item in golden:
        doc, quote = item.gold_evidence[0].document, item.gold_evidence[0].quote
        index = int(item.id.rsplit("-", 1)[1])
        failing = index < 6
        if item.category == "general":
            if "slice" in bad and failing:
                traces.append(_trace(item.id, [(OTHER, "drin")]))
            else:
                traces.append(_trace(item.id, [(doc, quote)]))
            continue
        if not templated:
            traces.append(_trace(item.id, [(OTHER, "drin")]))
        elif "feature:attribute_named" in item.tags:
            kept = [(doc, quote)] if not ("named" in bad and failing) else [(OTHER, "a")] * 6 + [(doc, quote)]
            traces.append(_trace(item.id, kept, cite=kept[0][0]))
        elif "feature:variant" in item.tags:
            kept = [(doc, quote)] if not ("variant" in bad and failing) else [(doc, "variant other tarvik"), (doc, quote)]
            traces.append(_trace(item.id, kept))
        else:
            first = (doc, quote) if not ("quantity" in bad and failing) else (OTHER, "amount")
            legs = {"lexical": 1} if lexical else {"dense": 1}
            traces.append(_trace(item.id, [(doc, quote)], candidates=[(*first, legs)]))
    return traces


def _manifest(golden_path: Path, *, run_id: str, corpus: str) -> RunManifest:
    return RunManifest.model_validate(
        {
            "run_id": run_id,
            "tier": "smoke",
            "created_at": "2026-01-01T00:00:00Z",
            "git_sha": None,
            "deployment_mode": "single",
            "embedder": {"id": "fixture-embedder", "version": "3", "source_sha256": "e" * 64},
            "corpus_sha256": corpus,
            "golden_path": str(golden_path),
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


def _write_run(root: Path, name: str, golden: list[GoldenItem], traces: list[RagTrace], *, corpus: str, share: float | None = None):
    directory = root / "reports" / name
    directory.mkdir(parents=True)
    golden_path = root / "golden.jsonl"
    if not golden_path.exists():
        write_golden(golden_path, golden)
    manifest = _manifest(golden_path, run_id=name, corpus=corpus)
    report = build_report(manifest, score_items(traces, golden), golden, traces)
    if share is not None and "templated_collection" in report.by_category:
        slice_metrics = report.by_category["templated_collection"]
        patched = slice_metrics.model_copy(update={"boilerplate_token_share": MetricValue(value=share, n=40)})
        report = report.model_copy(update={"by_category": {**report.by_category, "templated_collection": patched}})
    (directory / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
    (directory / "traces.jsonl").write_text("".join(trace.model_dump_json() + "\n" for trace in traces), encoding="utf-8")
    (directory / "run.json").write_text(manifest.model_dump_json(), encoding="utf-8")
    return report


RUNS = {
    "tpl-all-off-prechunked": "prechunked",
    "tpl-all-off-ingest": "ingest",
    "tpl-v2-off-prechunked": "prechunked",
    "tpl-v2-off-ingest": "ingest",
    "tpl-recommended-prechunked": "prechunked",
    "tpl-recommended-ingest": "ingest",
    "tpl-only-quantity-ingest": "ingest",
}


def _gates_spec(comparison: Path, **overrides) -> dict:
    spec = {
        "schema_version": 1,
        "phase": "03.3",
        "description": "synthetic gates",
        "comparison_spec": str(comparison),
        "noise": str(NOISE),
        "gate_split": "dev",
        "min_dev_items": 10,
        "gates": [
            {"id": "off_identity", "kind": "off_identity", "runs": ["tpl-all-off-prechunked", "tpl-all-off-ingest"], "decisions": ["D-36"], "requirements": ["TPL-09"]},
            {
                "id": "boilerplate_share",
                "kind": "boilerplate_share",
                "run": "tpl-recommended-ingest",
                "control": "tpl-all-off-ingest",
                "slice": "category:templated_collection",
                "max": 0.01,
                "control_min": 0.04,
                "decisions": ["D-13", "D-15"],
                "requirements": ["TPL-02"],
            },
            {
                "id": "named_document",
                "kind": "named_document",
                "run": "tpl-recommended-ingest",
                "tag": "feature:attribute_named",
                "k": 5,
                "recall_min": 0.95,
                "wrong_document_at_1_max": 0.05,
                "cited_asked_document_min": 0.9,
                "decisions": ["D-28", "D-29", "D-30"],
                "requirements": ["TPL-03", "TPL-06", "TPL-09"],
            },
            {"id": "variant", "kind": "variant", "run": "tpl-recommended-ingest", "tag": "feature:variant", "min": 0.85, "decisions": ["D-19"], "requirements": ["TPL-01"]},
            {
                "id": "quantity",
                "kind": "quantity",
                "run": "tpl-recommended-ingest",
                "tag": "feature:quantity",
                "min": 0.9,
                "require_lexical_leg": True,
                "decisions": ["D-31"],
                "requirements": ["TPL-07"],
            },
            {
                "id": "no_other_slice_drop",
                "kind": "no_other_slice_drop",
                "pairs": [
                    {"run": "tpl-recommended-prechunked", "reference": "tpl-v2-off-prechunked"},
                    {"run": "tpl-recommended-ingest", "reference": "tpl-v2-off-ingest"},
                ],
                "exclude_categories": ["templated_collection"],
                "decisions": ["D-36"],
                "requirements": ["TPL-09"],
            },
        ],
        "report_only": {
            "fallback_rate_runs": ["tpl-recommended-ingest"],
            "retrieval_moves": {
                "pairs": [{"run": "tpl-recommended-ingest", "reference": "tpl-v2-off-ingest"}],
                "exclude_categories": ["templated_collection"],
            },
            "single_switch": [{"run": "tpl-only-quantity-ingest", "reference": "tpl-v2-off-ingest"}],
        },
    }
    spec.update(overrides)
    return spec


def _comparison(baselines: dict[str, str], runs: dict[str, str]) -> dict:
    return {
        "schema_version": 2,
        "phase": "03.3",
        "noise": str(NOISE),
        "baselines": baselines,
        "runs": [{"name": name, "fixture_mode": mode, "checks": ["report_only"]} for name, mode in runs.items()],
    }


def _world(
    tmp_path: Path,
    *,
    bad: frozenset[str] = frozenset(),
    share: float = 0.002,
    control_share: float | None = 0.06,
    lexical: bool = True,
    templated_split: str = "dev",
    drift_baseline: bool = False,
    skip: str | None = None,
    comparison_runs: dict[str, str] | None = None,
    gates_overrides: dict | None = None,
) -> Path:
    golden = _golden(templated_split=templated_split)
    good = _traces(golden)
    off = _traces(golden, templated=False)
    reports = {}
    for name, mode in RUNS.items():
        if name == skip:
            continue
        corpus = ("i" if mode == "ingest" else "c") * 64
        if name.startswith("tpl-recommended"):
            traces = _traces(golden, bad=bad, lexical=lexical)
            corpus = "j" * 64 if mode == "ingest" else corpus
            reports[name] = _write_run(tmp_path, name, golden, traces, corpus=corpus, share=share if mode == "ingest" else None)
        elif name.startswith("tpl-only"):
            reports[name] = _write_run(tmp_path, name, golden, good, corpus="k" * 64)
        elif name.startswith("tpl-all-off"):
            reports[name] = _write_run(tmp_path, name, golden, off, corpus=corpus, share=control_share if mode == "ingest" else None)
        else:
            reports[name] = _write_run(tmp_path, name, golden, good, corpus=corpus)
    baselines = {}
    for mode in ("prechunked", "ingest"):
        source = reports.get(f"tpl-all-off-{mode}") or reports[f"tpl-v2-off-{mode}"]
        if drift_baseline and mode == "prechunked":
            source = reports["tpl-v2-off-prechunked"]
        path = tmp_path / f"baseline-{mode}.json"
        path.write_text(baseline_from_report(source, tag=f"b-{mode}").model_dump_json(), encoding="utf-8")
        baselines[mode] = str(path)
    comparison = tmp_path / "comparison.json"
    comparison.write_text(json.dumps(_comparison(baselines, comparison_runs or RUNS)), encoding="utf-8")
    spec = tmp_path / "gates.json"
    spec.write_text(json.dumps(_gates_spec(comparison, **(gates_overrides or {}))), encoding="utf-8")
    return spec


def _evaluate(tmp_path: Path, spec: Path) -> tuple[int, dict]:
    out = tmp_path / "out"
    code = _main("evaluate", "--spec", str(spec), "--reports", str(tmp_path / "reports"), "--out", str(out))
    result = json.loads((out / "gates.json").read_text(encoding="utf-8")) if (out / "gates.json").exists() else {}
    return code, result


def _gate(result: dict, gate_id: str) -> dict:
    found = [gate for gate in result.get("gates", []) if gate["id"] == gate_id]
    assert found, f"gate {gate_id} missing from gates.json"
    return found[0]


# ---------- check


def test_check_accepts_a_consistent_spec(tmp_path):
    assert _main("check", "--spec", str(_world(tmp_path))) == 0


def test_check_rejects_a_run_missing_from_the_comparison_spec(tmp_path, capsys):
    runs = {name: mode for name, mode in RUNS.items() if name != "tpl-only-quantity-ingest"}
    assert _main("check", "--spec", str(_world(tmp_path, comparison_runs=runs))) == 2
    assert "tpl-only-quantity-ingest" in capsys.readouterr().err


def test_check_rejects_a_fixture_mode_mismatch(tmp_path, capsys):
    runs = {**RUNS, "tpl-v2-off-ingest": "prechunked"}
    assert _main("check", "--spec", str(_world(tmp_path, comparison_runs=runs))) == 2
    assert "fixture mode" in capsys.readouterr().err


def test_check_rejects_an_invalid_spec(tmp_path):
    assert _main("check", "--spec", str(_world(tmp_path, gates_overrides={"min_dev_items": 0}))) == 2
    spec = _world(tmp_path / "second")
    raw = json.loads(spec.read_text(encoding="utf-8"))
    raw["gates"][2]["run"] = "tpl-recommended-prechunked"
    spec.write_text(json.dumps(raw), encoding="utf-8")
    assert _main("check", "--spec", str(spec)) == 2


# ---------- evaluate: all pass, output, exit codes


def test_every_gate_passes_and_alignment_is_recorded(tmp_path):
    code, result = _evaluate(tmp_path, _world(tmp_path))
    assert code == 0, result.get("failures")
    assert result["passed"] is True
    assert {gate["id"] for gate in result["gates"]} == {
        "off_identity", "boilerplate_share", "named_document", "variant", "quantity", "no_other_slice_drop"
    }
    drop = _gate(result, "no_other_slice_drop")
    assert any("corpus_sha256" in line and "tpl-recommended-ingest" in line for line in drop["alignment"])
    assert result["spec_sha256"] == sha256((tmp_path / "gates.json").read_bytes()).hexdigest()
    assert result["spec_commit_count"] == 0
    readme = (tmp_path / "out" / "README.md").read_text(encoding="utf-8")
    assert "| TPL-07 | quantity | pass |" in readme
    names = {row["name"] for row in result["report_only"]}
    assert names == {"attribute_filter_fallback_rate", "retrieval_unchanged", "single_switch"}


def test_output_carries_no_text(tmp_path):
    _evaluate(tmp_path, _world(tmp_path, bad=frozenset({"named", "variant"})))
    for name in ("gates.json", "README.md"):
        path = tmp_path / "out" / name
        assert path.is_file(), f"{name} was not written"
        text = path.read_text(encoding="utf-8")
        assert not any(word in text for word in SECRET_WORDS), name


def test_missing_run_directory_exits_2(tmp_path, capsys):
    code, _ = _evaluate(tmp_path, _world(tmp_path, skip="tpl-only-quantity-ingest"))
    assert code == 2
    assert "tpl-only-quantity-ingest" in capsys.readouterr().err


def test_internal_error_exits_70(tmp_path, monkeypatch):
    spec = _world(tmp_path)
    monkeypatch.setattr(gate_module, "evaluate_phase33", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")), raising=False)
    code, _ = _evaluate(tmp_path, spec)
    assert code == 70


# ---------- gate kinds: passing cases are in the all-pass test; failing and missing-data cases here


def test_off_identity_fails_when_an_all_off_run_moves(tmp_path):
    code, result = _evaluate(tmp_path, _world(tmp_path, drift_baseline=True))
    assert code == 1
    gate = _gate(result, "off_identity")
    assert gate["passed"] is False
    assert "tpl-all-off-prechunked/paired_all_zero" in gate["offenders"]
    assert _gate(result, "variant")["passed"] is True


def test_boilerplate_share_fails_above_its_max(tmp_path):
    code, result = _evaluate(tmp_path, _world(tmp_path, share=0.05))
    assert code == 1
    gate = _gate(result, "boilerplate_share")
    assert (gate["passed"], gate["measures"]["share"]) == (False, 0.05)


def test_boilerplate_share_fails_when_the_control_is_below_its_min(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, control_share=0.01))
    gate = _gate(result, "boilerplate_share")
    assert gate["passed"] is False
    assert gate["offenders"] == ["tpl-all-off-ingest:category:templated_collection"]


def test_boilerplate_share_missing_data_fails(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, control_share=None))
    gate = _gate(result, "boilerplate_share")
    assert (gate["passed"], gate["reason"]) == (False, "missing_data")


def test_named_document_fails_when_the_asked_document_ranks_low(tmp_path):
    code, result = _evaluate(tmp_path, _world(tmp_path, bad=frozenset({"named"})))
    assert code == 1
    gate = _gate(result, "named_document")
    assert gate["passed"] is False
    assert gate["measures"]["named_document_recall"] == pytest.approx(0.5)
    assert "tpl-named-00" in gate["offenders"]


def test_named_document_needs_the_minimum_dev_items(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, templated_split="test"))
    for gate_id in ("named_document", "variant", "quantity"):
        gate = _gate(result, gate_id)
        assert (gate["passed"], gate["reason"]) == (False, "missing_data"), gate_id


def test_variant_fails_below_its_floor(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, bad=frozenset({"variant"})))
    gate = _gate(result, "variant")
    assert gate["passed"] is False
    assert gate["measures"]["variant_correct"] == pytest.approx(0.5)


def test_quantity_fails_below_its_floor(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, bad=frozenset({"quantity"})))
    gate = _gate(result, "quantity")
    assert gate["passed"] is False
    assert "tpl-quantity-00" in gate["offenders"]


def test_quantity_without_a_lexical_leg_is_missing_data(tmp_path):
    _, result = _evaluate(tmp_path, _world(tmp_path, lexical=False))
    gate = _gate(result, "quantity")
    assert (gate["passed"], gate["reason"]) == (False, "missing_data")


def test_no_other_slice_drop_fails_in_ingest_mode_with_different_corpus_hashes(tmp_path):
    code, result = _evaluate(tmp_path, _world(tmp_path, bad=frozenset({"slice"})))
    assert code == 1
    gate = _gate(result, "no_other_slice_drop")
    assert gate["passed"] is False
    assert "tpl-recommended-ingest" in gate["offenders"]
    assert any("corpus_sha256" in line for line in gate["alignment"])
    assert not any("corpus_sha256 differs" in line for line in gate["detail"])
    moves = [row for row in result["report_only"] if row["name"] == "retrieval_unchanged"]
    assert moves and moves[0]["measures"]["unchanged"] == 0.0


# ---------- the committed files


@pytest.mark.skipif(not GATES_FILE.exists(), reason="the gates file is committed in the last commit of plan 03.3-22")
def test_committed_gates_file_checks():
    assert _main("check", "--spec", str(GATES_FILE)) == 0
