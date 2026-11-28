"""Phase 4.4 gates (D-36) on synthetic runs. The committed runs under eval/tests/data/phase44/ come from write_fixture_runs below
(`uv run --directory eval python tests/test_phase44_gate.py` rewrites them); a test checks that they still match. Neutral text only (D-41)."""

import json
import shutil
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagTrace, TraceKeptChunk
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.latency import LatencyBudgets

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_report_runner import _manifest, _trace

from rag_eval import phase44_gate
from rag_eval.golden_io import write_golden
from rag_eval.metrics import score_items
from rag_eval.phase44_gate import (
    OFF_ENV,
    OVERLAP_FILE,
    OverlapReport,
    Phase44GateSpec,
    cap_agreement_gate,
    main,
    off_identity_gate,
    on_gate,
    refusal_differences,
    run_config_for,
    run_phase44_gates,
)
from rag_eval.phase_compare import HARNESS_DIR, ComparisonError, RunOutput
from rag_eval.phase_compare import with_min_gate_n
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import build_report

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "eval" / "config" / "phase44-comparison.json"
RUNS_DIR = REPO_ROOT / "eval" / "config" / "runs"
DATA = REPO_ROOT / "eval" / "tests" / "data" / "phase44"
# These tests check the noise-band arithmetic on small synthetic slices; min_gate_n=1 gates every slice.
# The min_gate_n rule itself (default 10, owner decision 2026-11-28) is tested in test_min_gate_n.py.
NOISE = with_min_gate_n(
    NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8")), 1
)
BUDGETS = LatencyBudgets.model_validate_json((REPO_ROOT / "eval" / "config" / "latency-budgets.json").read_text(encoding="utf-8"))
BUDGETS_PATH = "eval/config/latency-budgets.json"
QUOTE = "the neutral sample sentence names one plain fact"


def _spec() -> Phase44GateSpec:
    return Phase44GateSpec.model_validate_json(SPEC_PATH.read_text(encoding="utf-8"))


def _raw_spec() -> dict:
    return json.loads(SPEC_PATH.read_text(encoding="utf-8"))


# ---------- synthetic runs


def _g(item_id: str, language: str, *, answerable: bool = True) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category="general" if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": f"doc.{language}.md", "section": "s", "quote": QUOTE}] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


GOLDEN = [_g("en-general-001", "en"), _g("it-general-001", "it"), _g("zh-general-001", "zh"), _g("en-no_answer-001", "en", answerable=False)]
GOLDEN_REL = "eval/tests/data/phase44/golden.jsonl"


def _chunk(item_id: str, doc: str, text: str) -> TraceKeptChunk:
    return TraceKeptChunk(
        rank=1, chunk_id=f"{item_id}-c1", document_id=f"d-{doc}", document_name=doc, content=f"intro {text} outro", similarity=0.5, kept_by="similarity"
    )


def _output(misses: tuple[str, ...] = (), refused: tuple[str, ...] = ("en-no_answer-001",), search_ms: float = 12.0) -> RunOutput:
    traces: list[RagTrace] = []
    for item in GOLDEN:
        if item.id in refused:
            trace = _trace(item.id, [], refused=True)
        else:
            chunk = _chunk(item.id, "other.md", "unrelated words") if item.id in misses or not item.answerable else _chunk(item.id, f"doc.{item.language}.md", QUOTE)
            trace = _trace(item.id, []).model_copy(update={"kept": [chunk]})
        traces.append(trace.model_copy(update={"stage_latency_ms": {"embed": 3.0, "search": search_ms}}))
    manifest = _manifest().model_copy(update={"golden_path": GOLDEN_REL})
    report = build_report(manifest, score_items(traces, GOLDEN), GOLDEN, traces)
    return RunOutput(report=report, traces=traces, golden=list(GOLDEN))


def _overlap(mean: float | None, k: int = 10) -> OverlapReport:
    rows = [{"item_id": item.id, "overlap": mean, "uncapped": 0 if mean is None else 10} for item in GOLDEN]
    return OverlapReport.model_validate(
        {
            "tenant_hash": "0" * 12,
            "k": k,
            "capped_candidate_limit": 500,
            "questions": len(rows),
            "measured": 0 if mean is None else len(rows),
            "mean_overlap_at_k": mean,
            "min_overlap_at_k": mean,
            "items": rows,
        }
    )


def write_fixture_runs(root: Path) -> None:
    """golden.jsonl, one baseline per fixture mode and one finished run per spec run (report.json, traces.jsonl, run.json and the
    overlap file of each bm25 run), all passing."""
    root.mkdir(parents=True, exist_ok=True)
    write_golden(root / "golden.jsonl", GOLDEN)
    output = _output()
    for mode in ("prechunked", "ingest"):
        baseline = baseline_from_report(output.report, tag=f"synthetic-{mode}")
        (root / f"baseline-{mode}.json").write_text(json.dumps(baseline.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
    spec = _spec()
    for run in spec.runs:
        directory = root / HARNESS_DIR / run.name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "report.json").write_text(json.dumps(output.report.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
        (directory / "traces.jsonl").write_text("".join(json.dumps(t.model_dump(mode="json"), sort_keys=True) + "\n" for t in output.traces), encoding="utf-8")
        manifest = _manifest().model_copy(update={"golden_path": GOLDEN_REL})
        (directory / "run.json").write_text(json.dumps(manifest.model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")
        if not run.phase44_off:
            (directory / OVERLAP_FILE).write_text(json.dumps(_overlap(1.0).model_dump(mode="json"), sort_keys=True, indent=2) + "\n", encoding="utf-8")


def _data_spec(root: Path = DATA) -> Phase44GateSpec:
    rel = root.relative_to(REPO_ROOT) if root.is_relative_to(REPO_ROOT) else root
    return _spec().model_copy(update={"baselines": {"prechunked": str(rel / "baseline-prechunked.json"), "ingest": str(rel / "baseline-ingest.json")}})


def _passing_commands(argv: list[str]) -> int:
    return 0


# ---------- spec


def test_spec_validates_and_pre_registers_the_three_gates():
    spec = _spec()
    g = spec.gates
    assert g.off_identity.decision == "D-36 (a)" and g.on.decision == "D-36 (b)" and g.cap_agreement.decision == "D-36 (c)"
    assert dict(spec.off_env) == dict(OFF_ENV)
    assert {spec.runs[[r.name for r in spec.runs].index(name)].fixture_mode for name in g.off_identity.runs} == {"prechunked", "ingest"}
    assert g.off_identity.commands == ["characterization"] and g.off_identity.latency_profile == "chat"
    assert [(p.run, p.reference) for p in g.on.pairs] == [
        ("v2-lexical-bm25-on-prechunked", "v2-default-prechunked"),
        ("v2-lexical-bm25-on-ingest", "v2-default-ingest"),
    ]
    assert g.on.refusal_paired_zero is True and g.on.latency_profile == "chat"
    assert g.cap_agreement.k == 10 and g.cap_agreement.min_mean_overlap == 0.95
    assert [(p.run, p.reference) for p in spec.report_only] == [("v2-lexical-bm25-on-rerank-none-prechunked", "v2-default-rerank-none-prechunked")]


def test_run_configs_are_the_v2_default_plus_the_scoring_variables():
    spec = _spec()
    base = json.loads((RUNS_DIR / "v2-default.json").read_text(encoding="utf-8"))
    on = json.loads((RUNS_DIR / "v2-lexical-bm25-on.json").read_text(encoding="utf-8"))
    assert on["env"] == {**base["env"], "RAG_LEXICAL_SCORING": "bm25", "RAG_LEXICAL_BM25_K1": "1.2", "RAG_LEXICAL_BM25_B": "0.75"}
    assert on["overrides"] == base["overrides"]
    configs = {run.name: run_config_for(spec, run) for run in spec.runs}
    assert configs["off-prechunked"] == {"name": "off-prechunked", "env": dict(OFF_ENV), "overrides": None}
    assert configs["v2-default-prechunked"]["env"] == {**base["env"], **OFF_ENV}
    assert configs["v2-lexical-bm25-on-ingest"]["env"]["RAG_LEXICAL_SCORING"] == "bm25"
    assert configs["v2-lexical-bm25-on-rerank-none-prechunked"]["env"]["RAG_RERANKER"] == "none"
    assert configs["v2-default-rerank-none-prechunked"]["env"]["RAG_RERANKER"] == "none"


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("unexpected",), 1),
        (("gates", "on", "extra"), True),
        (("off_env", "RAG_LEXICAL_SCORING"), "bm25"),
        (("gates", "cap_agreement", "min_mean_overlap"), 1.5),
        (("gates", "on", "refusal_paired_zero"), False),
    ],
)
def test_spec_rejects_unknown_keys_and_values_outside_the_rules(path, value):
    raw = _raw_spec()
    target = raw
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        Phase44GateSpec.model_validate(raw)


def test_spec_rejects_an_unknown_run_an_off_run_with_a_base_and_a_mixed_mode_pair():
    raw = _raw_spec()
    raw["gates"]["cap_agreement"]["runs"] = ["no-such-run"]
    with pytest.raises(ValidationError, match="unknown runs"):
        Phase44GateSpec.model_validate(raw)
    raw = _raw_spec()
    raw["runs"][0]["base"] = "eval/config/runs/v2-default.json"
    with pytest.raises(ValidationError, match="no base"):
        Phase44GateSpec.model_validate(raw)
    raw = _raw_spec()
    raw["gates"]["on"]["pairs"][0]["reference"] = "v2-default-ingest"
    with pytest.raises(ValidationError, match="same fixture mode"):
        Phase44GateSpec.model_validate(raw)


# ---------- gate (a)


def _baselines(output: RunOutput) -> dict:
    return {mode: baseline_from_report(output.report, tag=mode) for mode in ("prechunked", "ingest")}


def test_off_identity_passes_and_fails_on_a_nonzero_paired_difference_a_command_or_the_latency_budget():
    spec = _spec()
    gate = spec.gates.off_identity
    modes = {run.name: run.fixture_mode for run in spec.runs}
    base = _output()
    outputs = {name: _output() for name in gate.runs}
    ok = off_identity_gate(gate, outputs, modes, _baselines(base), NOISE, BUDGETS, BUDGETS_PATH, {"characterization": 0})
    assert ok.passed is True
    outputs["off-ingest"] = _output(misses=("zh-general-001",))
    moved = off_identity_gate(gate, outputs, modes, _baselines(base), NOISE, BUDGETS, BUDGETS_PATH, {"characterization": 0})
    assert moved.passed is False
    assert any(line.startswith("off-ingest vs ingest baseline") and "language:zh" in line for line in moved.offenders)
    outputs["off-ingest"] = _output()
    failed_command = off_identity_gate(gate, outputs, modes, _baselines(base), NOISE, BUDGETS, BUDGETS_PATH, {"characterization": 1})
    assert failed_command.passed is False and failed_command.offenders == ["command characterization exited 1"]
    outputs["off-prechunked"] = _output(search_ms=900.0)
    slow = off_identity_gate(gate, outputs, modes, _baselines(base), NOISE, BUDGETS, BUDGETS_PATH, {"characterization": 0})
    assert slow.passed is False and any(line.startswith("off-prechunked: search p95") for line in slow.offenders)


# ---------- gate (b)


def _on_outputs(**runs: RunOutput) -> dict[str, RunOutput]:
    outputs = {name: _output() for pair in _spec().gates.on.pairs for name in (pair.run, pair.reference)}
    outputs.update(runs)
    return outputs


def test_on_gate_passes_and_names_the_slice_that_drops_below_the_reference_band():
    gate = _spec().gates.on
    assert on_gate(gate, _on_outputs(), NOISE, BUDGETS, BUDGETS_PATH).passed is True
    dropped = on_gate(gate, _on_outputs(**{"v2-lexical-bm25-on-ingest": _output(misses=("it-general-001",))}), NOISE, BUDGETS, BUDGETS_PATH)
    assert dropped.passed is False
    assert any(line.startswith("v2-lexical-bm25-on-ingest:") and "language:it:recall_at_10" in line for line in dropped.offenders)
    assert any("overall:mrr" in line for line in dropped.offenders)


def test_on_gate_fails_on_a_refusal_difference():
    gate = _spec().gates.on
    refused = _output(refused=("en-no_answer-001", "en-general-001"))
    result = on_gate(gate, _on_outputs(**{"v2-lexical-bm25-on-prechunked": refused}), NOISE, BUDGETS, BUDGETS_PATH)
    assert result.passed is False
    assert any("false_refusal_rate: 1 item(s) moved against v2-default-prechunked (en-general-001)" in line for line in result.offenders)
    assert result.numbers["v2-lexical-bm25-on-prechunked.refusal_differences"] == 1
    not_refused = _output(refused=())
    assert any(line.startswith("correct_refusal_rate") for line in refusal_differences(not_refused, _output(), reference_name="ref"))


# ---------- gate (c)


def test_cap_agreement_fails_at_0_94_and_passes_at_0_95():
    gate = _spec().gates.cap_agreement
    passing = {name: _overlap(0.95) for name in gate.runs}
    assert cap_agreement_gate(gate, passing).passed is True
    failing = {**passing, "v2-lexical-bm25-on-ingest": _overlap(0.94)}
    result = cap_agreement_gate(gate, failing)
    assert result.passed is False
    assert result.offenders == ["v2-lexical-bm25-on-ingest: mean overlap@10 0.9400 < 0.95"]
    unmeasured = cap_agreement_gate(gate, {**passing, "v2-lexical-bm25-on-prechunked": _overlap(None)})
    assert unmeasured.passed is False and "not measured" in unmeasured.offenders[0]
    other_k = cap_agreement_gate(gate, {**passing, "v2-lexical-bm25-on-prechunked": _overlap(1.0, k=5)})
    assert other_k.passed is False and "k=5" in other_k.offenders[0]


# ---------- end to end on the committed runs


def test_committed_runs_match_the_generator(tmp_path):
    write_fixture_runs(tmp_path)
    committed = sorted(p.relative_to(DATA) for p in DATA.rglob("*") if p.is_file())
    generated = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*") if p.is_file())
    assert committed == generated
    for rel in generated:
        assert (DATA / rel).read_bytes() == (tmp_path / rel).read_bytes(), str(rel)


def test_all_gates_pass_on_the_committed_runs_and_write_gate_json_and_md(tmp_path):
    seen: list[list[str]] = []
    result = run_phase44_gates(_data_spec(), tmp_path, command_runner=lambda argv: seen.append(argv) or 0, reuse=DATA)
    assert result.passed is True
    assert [g.name for g in result.gates] == ["off_identity", "on", "cap_agreement"]
    assert seen == [_spec().commands["characterization"]]
    assert {r.run for r in result.report_only} == {"v2-lexical-bm25-on-rerank-none-prechunked"}
    assert json.loads((tmp_path / "gate.json").read_text(encoding="utf-8"))["passed"] is True
    assert "Report-only (not gated)" in (tmp_path / "gate.md").read_text(encoding="utf-8")


def _copy_data(tmp_path: Path) -> Path:
    root = tmp_path / "data"
    shutil.copytree(DATA, root)
    return root


def test_an_overlap_below_the_minimum_fails_the_run_and_main_exits_non_zero(tmp_path, monkeypatch, capsys):
    root = _copy_data(tmp_path)
    (root / HARNESS_DIR / "v2-lexical-bm25-on-ingest" / OVERLAP_FILE).write_text(json.dumps(_overlap(0.94).model_dump(mode="json")), encoding="utf-8")
    result = run_phase44_gates(_data_spec(root), tmp_path / "out", command_runner=_passing_commands, reuse=root, only=["cap_agreement"])
    assert result.passed is False
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(_data_spec(root).model_dump(mode="json")), encoding="utf-8")
    monkeypatch.setattr(phase44_gate, "default_command_runner", _passing_commands)
    code = main(["--spec", str(spec_path), "--out", str(tmp_path / "cli"), "--reuse", str(root), "--only", "cap_agreement"])
    assert code == phase44_gate.EXIT_FAIL
    assert "mean overlap@10 0.9400 < 0.95" in capsys.readouterr().out


def test_a_missing_run_or_overlap_file_is_an_error_not_a_pass(tmp_path):
    root = _copy_data(tmp_path)
    (root / HARNESS_DIR / "v2-lexical-bm25-on-prechunked" / OVERLAP_FILE).unlink()
    with pytest.raises(ComparisonError, match="lexical-bm25-overlap.json is missing"):
        run_phase44_gates(_data_spec(root), tmp_path / "out", command_runner=_passing_commands, reuse=root)
    shutil.rmtree(root / HARNESS_DIR / "v2-default-ingest")
    with pytest.raises(ComparisonError, match="no report.json"):
        run_phase44_gates(_data_spec(root), tmp_path / "out2", command_runner=_passing_commands, reuse=root, only=["on"])
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(_data_spec(root).model_dump(mode="json")), encoding="utf-8")
    assert main(["--spec", str(spec_path), "--out", str(tmp_path / "cli"), "--reuse", str(root), "--only", "on"]) == phase44_gate.EXIT_USAGE


def test_a_reference_that_scores_with_bm25_is_refused(tmp_path):
    raw = _data_spec().model_dump(mode="json")
    for run in raw["runs"]:
        if run["name"] == "v2-default-prechunked":
            run["env"] = {"RAG_LEXICAL_SCORING": "bm25"}
    with pytest.raises(ComparisonError, match="sets phase44_off but its run config scores with bm25"):
        run_phase44_gates(Phase44GateSpec.model_validate(raw), tmp_path, command_runner=_passing_commands, reuse=DATA, only=["on"])


if __name__ == "__main__":
    shutil.rmtree(DATA, ignore_errors=True)
    write_fixture_runs(DATA)
    print(f"wrote {DATA.relative_to(REPO_ROOT)}")
