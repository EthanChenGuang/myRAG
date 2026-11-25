import json
import shutil
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagRunOptions, TraceRefusal
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import MetricValue
from rag_sidecar.contracts.retrieval import ChunkingDecision, ChunkingSweepReport
from test_report_runner import QUOTE, _manifest, _trace

from rag_eval.calibrate.refusal import CalibrationResult, CrossComparison
from rag_eval.gate import evaluate_gate
from rag_eval.metrics import score_items
from rag_eval.phase_compare import (
    ComparisonSpec,
    PhaseComparison,
    RunOutput,
    compression_rule,
    command_result,
    legacy_parity_rule,
    local_bm25_refusal_rule,
    main,
    parent_child_rule,
    recommended_rule,
    resolve_chunking_profile,
    run_phase_comparison,
    translation_rule,
    iterative_scan_rule,
    xlg03_verdict,
)
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import build_report

REPO_ROOT = Path(__file__).resolve().parents[2]
NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8"))
SPEC = REPO_ROOT / "eval" / "config" / "phase4-comparison.json"
SWEEP = REPO_ROOT / "eval" / "reports" / "chunking-sweep.json"
DECISION = REPO_ROOT / "eval" / "decisions" / "chunking" / "contract_legal.json"

ANSWERABLE = ("en-general-001", "en-table-001", "zh-general-001", "it-general-001", "en-clause-001", "it-xl-001")
NO_ANSWER = ("en-no_answer-001", "zh-no_answer-001")


def _g(item_id: str, language: str, *, answerable: bool = True, category: str = "general", evidence=None, tags=()) -> GoldenItem:
    doc_language = evidence or language
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": f"doc.{doc_language}.md", "section": "s", "quote": QUOTE}] if answerable else [],
        evidence_language=evidence,
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
        tags=list(tags),
    )


GOLDEN = [
    _g("en-general-001", "en"),
    _g("en-table-001", "en", category="table"),
    _g("zh-general-001", "zh"),
    _g("it-general-001", "it"),
    _g("en-clause-001", "en", category="compound", tags=["clause"]),
    _g("it-xl-001", "it", category="cross_lingual", evidence="en"),
    _g("en-no_answer-001", "en", answerable=False),
    _g("zh-no_answer-001", "zh", answerable=False),
]
DOC = {item.id: item.gold_evidence[0].document if item.gold_evidence else "doc.en.md" for item in GOLDEN}


def _output(
    misses=(),
    refused=("en-no_answer-001",),
    tokens: int = 100,
    threshold_refusals=(),
    lexical=None,
) -> RunOutput:
    traces = []
    for item in GOLDEN:
        if item.id in refused:
            trace = _trace(item.id, [], refused=True)
        elif not item.answerable or item.id in misses:
            trace = _trace(item.id, [(DOC[item.id], "unrelated text")])
        else:
            trace = _trace(item.id, [(DOC[item.id], f"intro {QUOTE} outro")])
        update = {"context_tokens": tokens}
        if item.id in threshold_refusals:
            update["refusal"] = TraceRefusal(decision="refuse", basis="rerank_threshold", reason="below_threshold")
        traces.append(trace.model_copy(update=update))
    report = build_report(_manifest(), score_items(traces, GOLDEN), GOLDEN)
    if lexical is not None:
        items = [
            item.model_copy(update={"lexical_hit_at_10": lexical.get(item.item_id)}) if item.answerable else item
            for item in report.items
        ]
        hits = [v for v in (lexical.get(i) for i in ANSWERABLE) if v is not None]
        rate = MetricValue(value=sum(1.0 for v in hits if v) / len(hits), n=len(hits))
        report = report.model_copy(update={"items": items, "lexical_leg_hit_rate_at_10": rate})
    return RunOutput(report=report, traces=traces, golden=list(GOLDEN))


def _baseline(output: RunOutput):
    return baseline_from_report(output.report, tag="baseline")


# ---------- rule (a)


def test_legacy_parity_passes_only_when_every_legacy_run_is_all_zero():
    base = _output()
    baseline = _baseline(base)
    ok = legacy_parity_rule({"legacy-prechunked": (_output(), baseline), "legacy-ingest": (_output(), baseline)}, NOISE)
    assert ok.passed is True
    assert [check.all_zero for check in ok.runs] == [True, True]

    moved = legacy_parity_rule(
        {"legacy-prechunked": (_output(), baseline), "legacy-ingest": (_output(misses=("zh-general-001",)), baseline)}, NOISE
    )
    assert moved.passed is False
    assert [check.all_zero for check in moved.runs] == [True, False]


def test_legacy_parity_fails_on_a_report_from_different_data():
    baseline = _baseline(_output()).model_copy(update={"golden_sha256": "f" * 64})
    result = legacy_parity_rule({"legacy-prechunked": (_output(), baseline)}, NOISE)
    assert result.passed is False
    assert result.runs[0].mismatches


# ---------- rule (b)


def test_recommended_passes_with_no_drop_and_higher_correct_refusal():
    baseline = _baseline(_output(misses=("en-general-001",)))
    reference = _output()
    recommended = _output(refused=NO_ANSWER)
    result = recommended_rule(recommended, baseline, reference, NOISE, run="v2-recommended", reference_name="v2-all-off")
    assert result.passed is True
    assert result.baseline.refusal.improved is True and result.reference.refusal.improved is True
    assert result.baseline.refusal.false_refusal == 0.0
    assert result.baseline.refusal.false_refusal_upper_95 is not None


def test_recommended_fails_on_a_category_drop_the_ci_gate_does_not_see():
    baseline = _baseline(_output(misses=("en-general-001",)))
    recommended = _output(misses=("en-table-001",), refused=NO_ANSWER)
    assert evaluate_gate(recommended.report, baseline, NOISE).passed
    result = recommended_rule(recommended, baseline, _output(misses=("en-general-001",)), NOISE, run="r", reference_name="o")
    assert result.passed is False
    assert {drop.slice for drop in result.baseline.drops} == {"category:table"}
    assert all(drop.metric in ("recall_at_5", "recall_at_10", "mrr") for drop in result.baseline.drops)


def test_recommended_fails_when_correct_refusal_is_not_higher():
    baseline = _baseline(_output())
    result = recommended_rule(_output(), baseline, _output(), NOISE, run="r", reference_name="o")
    assert result.passed is False
    assert result.baseline.refusal.improved is False
    assert result.reference.refusal.improved is False


def test_recommended_fails_against_the_reference_run_even_when_the_baseline_passes():
    baseline = _baseline(_output(misses=("en-general-001", "zh-general-001")))
    reference = _output(refused=())
    recommended = _output(misses=("zh-general-001",), refused=NO_ANSWER)
    result = recommended_rule(recommended, baseline, reference, NOISE, run="r", reference_name="o")
    assert result.baseline.passed is True
    assert result.reference.passed is False
    assert result.passed is False


def test_recommended_ignores_its_own_retrieval_overrides_but_not_other_data():
    baseline = _baseline(_output(misses=("en-general-001",)))
    recommended = _output(refused=NO_ANSWER)
    options = RagRunOptions.model_validate(
        {**recommended.report.request_options.model_dump(), "retrieval_overrides": {"rerank_model": "fake-quality-v1"}}
    )
    recommended = RunOutput(
        report=recommended.report.model_copy(update={"request_options": options}),
        traces=recommended.traces,
        golden=recommended.golden,
    )
    assert recommended_rule(recommended, baseline, _output(), NOISE, run="r", reference_name="o").passed is True
    other = baseline.model_copy(update={"corpus_sha256": "d" * 64})
    result = recommended_rule(recommended, other, _output(), NOISE, run="r", reference_name="o")
    assert result.passed is False and result.baseline.mismatches


# ---------- rule (c)


def test_parent_child_needs_a_clause_gain_and_no_other_drop():
    off = _output(misses=("en-clause-001",))
    assert parent_child_rule(_output(), off, NOISE, on_name="on", off_name="off").passed is True

    flat = parent_child_rule(_output(misses=("en-clause-001",)), off, NOISE, on_name="on", off_name="off")
    assert flat.passed is False
    assert flat.measures["clause_recall_at_10_delta"] == 0.0

    dropped = parent_child_rule(_output(misses=("zh-general-001",)), off, NOISE, on_name="on", off_name="off")
    assert dropped.passed is False
    assert {"language:zh", "category:general"} <= {drop.slice for drop in dropped.drops}


def test_compression_needs_fewer_context_tokens_and_no_drop():
    off = _output(tokens=100)
    assert compression_rule(_output(tokens=80), off, NOISE, on_name="on", off_name="off").passed is True
    assert compression_rule(_output(tokens=120), off, NOISE, on_name="on", off_name="off").passed is False
    assert compression_rule(_output(tokens=100), off, NOISE, on_name="on", off_name="off").passed is False
    dropped = compression_rule(_output(tokens=80, misses=("en-table-001",)), off, NOISE, on_name="on", off_name="off")
    assert dropped.passed is False and dropped.drops


def test_translation_compares_cross_lingual_recall_and_lexical_hit_rate():
    every = {item_id: True for item_id in ANSWERABLE}
    off = _output(misses=("it-xl-001",), lexical={**every, "it-xl-001": False})
    on = _output(lexical=every)
    passed = translation_rule(on, off, on_name="on", off_name="off")
    assert passed.passed is True
    assert passed.measures["cross_lingual_recall_at_10_on"] == 1.0
    assert passed.measures["cross_lingual_recall_at_10_off"] == 0.0

    worse_recall = translation_rule(off, on, on_name="on", off_name="off")
    assert worse_recall.passed is False

    lower_lexical = translation_rule(_output(lexical={**every, "en-general-001": False}), _output(lexical=every), on_name="on", off_name="off")
    assert lower_lexical.passed is False

    unmeasured = translation_rule(_output(), _output(), on_name="on", off_name="off")
    assert unmeasured.passed is False


def _selective(**changes) -> dict:
    def modes() -> dict:
        return {
            "off": {"rows": 1, "recall_at_k": 0.1, "k": 10},
            "relaxed_order": {"rows": 10, "recall_at_k": 1.0, "k": 10},
            "strict_order": {"rows": 10, "recall_at_k": 0.9, "k": 10},
            "exact": {"rows": 10, "recall_at_k": 1.0, "k": 10},
        }

    report = {"small_tenant": modes(), "rare_doc_type": modes()}
    for key, value in changes.items():
        slice_name, mode, field = key.split("__")
        report[slice_name][mode][field] = value
    return report


def test_iterative_scan_reads_the_synthetic_report_and_reports_the_fixture_slice():
    fixture = _output()
    result = iterative_scan_rule(fixture, fixture, _selective(), fixture_slice="category:general", on_name="on", off_name="off")
    assert result.passed is True
    assert result.fixture_equal is True

    for change in (
        {"small_tenant__off__rows": 10},
        {"rare_doc_type__relaxed_order__recall_at_k": 0.8},
        {"small_tenant__strict_order__recall_at_k": 0.89},
        {"rare_doc_type__exact__recall_at_k": 0.9},
    ):
        assert iterative_scan_rule(fixture, fixture, _selective(**change), fixture_slice="category:general", on_name="on", off_name="off").passed is False
    assert iterative_scan_rule(fixture, fixture, None, fixture_slice="category:general", on_name="on", off_name="off").passed is False

    differs = iterative_scan_rule(
        _output(misses=("en-general-001",)), fixture, _selective(), fixture_slice="category:general", on_name="on", off_name="off"
    )
    assert differs.passed is True and differs.fixture_equal is False


# ---------- rule (d), XLG-03 and local_bm25


def test_command_results_record_exit_codes():
    assert command_result(["npx", "vitest"], 0).passed is True
    failed = command_result(["npx", "vitest"], 1)
    assert failed.passed is False and failed.exit_code == 1


def test_xlg03_verdict_from_the_calibration_comparisons():
    def result(*rows: CrossComparison) -> CalibrationResult:
        return CalibrationResult(cross_vs_same=list(rows))

    none = xlg03_verdict(result(CrossComparison(provider="cohere", model="m", query_language="en")))
    assert none.verdict == "not_comparable"
    ok = xlg03_verdict(result(CrossComparison(provider="cohere", model="m", query_language="en", comparable=True, exceeds_noise_band=False)))
    assert ok.verdict == "pass"
    bad = xlg03_verdict(
        result(
            CrossComparison(provider="cohere", model="m", query_language="en", comparable=True, exceeds_noise_band=False),
            CrossComparison(provider="cohere", model="m", query_language="zh", cross_key="k-zh", comparable=True, exceeds_noise_band=True),
        )
    )
    assert bad.verdict == "fail" and bad.exceeding == ["k-zh"]


def test_local_bm25_run_must_not_refuse_on_a_rerank_threshold():
    assert local_bm25_refusal_rule(_output(), run="local-bm25").passed is True
    result = local_bm25_refusal_rule(_output(threshold_refusals=("en-general-001",)), run="local-bm25")
    assert result.passed is False and result.threshold_decisions == 1


# ---------- chunking profile


def test_recorded_profile_falls_back_to_the_best_gated_sweep_candidate():
    sweep = ChunkingSweepReport.model_validate_json(SWEEP.read_text(encoding="utf-8"))
    decision = ChunkingDecision.model_validate_json(DECISION.read_text(encoding="utf-8"))
    legacy = decision.model_copy(update={"profile_id": "legacy"})
    candidates = [entry.profile_id for entry in sweep.profiles if entry.gate is not None]
    choice = resolve_chunking_profile(legacy, sweep)
    assert choice.source == "sweep_candidate" and choice.profile_id == candidates[0]

    promoted = sweep.model_copy(
        update={
            "profiles": [
                entry.model_copy(update={"gate": entry.gate.model_copy(update={"passed": True, "regressions": []})})
                if entry.profile_id == candidates[1]
                else entry
                for entry in sweep.profiles
            ]
        }
    )
    assert resolve_chunking_profile(legacy, promoted).profile_id == candidates[1]

    decided = decision.model_copy(update={"profile_id": f"{candidates[2]}-contract_legal"})
    chosen = resolve_chunking_profile(decided, sweep)
    assert chosen.source == "decision" and chosen.profile_id == candidates[2]


# ---------- end to end


def _world(tmp_path: Path, *, recommended_refused=NO_ANSWER) -> tuple[ComparisonSpec, dict[str, RunOutput]]:
    legacy = _output(misses=("en-general-001",))
    baseline = _baseline(legacy)
    for name in ("prechunked", "ingest"):
        (tmp_path / f"{name}.json").write_text(baseline.model_dump_json(), encoding="utf-8")
    shutil.copy(SWEEP, tmp_path / "sweep.json")
    decision = ChunkingDecision.model_validate_json(DECISION.read_text(encoding="utf-8")).model_copy(update={"profile_id": "legacy"})
    (tmp_path / "decision.json").write_text(decision.model_dump_json(), encoding="utf-8")
    raw = json.loads(SPEC.read_text(encoding="utf-8"))
    raw.update(
        {
            "baselines": {"prechunked": str(tmp_path / "prechunked.json"), "ingest": str(tmp_path / "ingest.json")},
            "chunking_decision": str(tmp_path / "decision.json"),
            "chunking_sweep": str(tmp_path / "sweep.json"),
        }
    )
    spec = ComparisonSpec.model_validate(raw)
    every = {item_id: True for item_id in ANSWERABLE}
    recommended = _output(refused=recommended_refused, lexical=every)
    outputs = {
        "legacy-prechunked": legacy,
        "legacy-ingest": legacy,
        "v2-all-off": _output(lexical=every),
        "v2-recommended": recommended,
        "parent-child-off": _output(misses=("en-clause-001",), refused=NO_ANSWER),
        "parent-child-on": _output(refused=NO_ANSWER),
        "compression-on": _output(refused=NO_ANSWER, tokens=60, lexical=every),
        "local-bm25": _output(misses=("it-xl-001",), refused=NO_ANSWER, lexical={**every, "it-xl-001": False}),
        "translation-on": _output(refused=NO_ANSWER, lexical=every),
        "iterative-scan-relaxed": recommended,
    }
    return spec, outputs


def _stub_runner(outputs: dict[str, RunOutput], seen: dict):
    def runner(request):
        seen[request.name] = request
        return outputs[request.name]

    return runner


def _stub_commands(codes: dict[str, int] | None = None, selective: dict | None = None):
    calls: list[list[str]] = []

    def run(argv: list[str]) -> int:
        calls.append(list(argv))
        if "eval/harness/selective-filter.mts" in argv:
            Path(argv[-1]).write_text(json.dumps(selective or _selective()), encoding="utf-8")
            return 0
        for marker, code in (codes or {}).items():
            if marker in " ".join(argv):
                return code
        return 0

    return run, calls


def test_run_phase_comparison_writes_a_valid_passing_report(tmp_path: Path):
    spec, outputs = _world(tmp_path)
    seen: dict = {}
    commands, calls = _stub_commands()
    out = tmp_path / "phase-04"
    result = run_phase_comparison(spec, out, runner=_stub_runner(outputs, seen), commands=commands)
    assert result.passed is True, result.model_dump_json(indent=2)
    stored = PhaseComparison.model_validate_json((out / "comparison.json").read_text(encoding="utf-8"))
    assert stored.passed is True
    assert stored.xlg03.verdict in ("pass", "not_comparable")
    md = (out / "comparison.md").read_text(encoding="utf-8")
    assert "noise band" in md and "lexical fixture embedder" in md and "stay off" in md
    assert set(seen) == {run.name for run in spec.runs}
    assert [c for c in calls if "vitest" in " ".join(c)] == [spec.commands.conformance, spec.commands.voice_budget]


def test_run_phase_comparison_materialises_each_named_run(tmp_path: Path):
    spec, outputs = _world(tmp_path)
    seen: dict = {}
    commands, _ = _stub_commands()
    result = run_phase_comparison(spec, tmp_path / "out", runner=_stub_runner(outputs, seen), commands=commands)

    legacy = seen["legacy-prechunked"]
    assert legacy.fixture_mode == "prechunked" and legacy.run_config["env"] == {"RAG_PIPELINE": "legacy"}
    assert seen["legacy-ingest"].fixture_mode == "ingest"

    recommended = seen["v2-recommended"].run_config
    assert recommended["overrides"] == {"rerank_model": "fake-quality-v1"}
    assert recommended["env"]["RAG_REFUSAL_THRESHOLD"] == "true"

    bm25 = seen["local-bm25"].run_config
    assert bm25["env"]["RAG_RERANKER"] == "local_bm25" and bm25["overrides"] is None
    assert seen["translation-on"].run_config["env"]["RAG_LEXICAL_TRANSLATION"] == "true"

    profile = result.chunking_profile.profile_id
    assert profile != "legacy"
    for name, parent_child in (("parent-child-on", "true"), ("parent-child-off", None)):
        config = seen[name].run_config
        assert seen[name].fixture_mode == "ingest"
        assert config["env"].get("RAG_PARENT_CHILD") == parent_child
        ids = {p["id"] for p in config["chunking_profiles"]}
        assert ids and all(i.startswith(f"{profile}-") for i in ids)
        assert set(config["overrides"]["chunking_profile_by_doc_type"].values()) == ids
    assert "chunking_profiles" not in seen["v2-recommended"].run_config


def test_run_phase_comparison_fails_when_a_rule_fails(tmp_path: Path):
    spec, outputs = _world(tmp_path, recommended_refused=("en-no_answer-001",))
    commands, _ = _stub_commands(codes={"voice-budget": 1})
    result = run_phase_comparison(spec, tmp_path / "out", runner=_stub_runner(outputs, {}), commands=commands)
    assert result.passed is False
    assert result.recommended.passed is False
    assert result.voice_budget.passed is False and result.conformance.passed is True
    md = (tmp_path / "out" / "comparison.md").read_text(encoding="utf-8")
    assert "FAIL" in md


def test_spec_rejects_a_rule_naming_an_unknown_run():
    raw = json.loads(SPEC.read_text(encoding="utf-8"))
    raw["rules"]["compression"]["on"] = "missing-run"
    with pytest.raises(ValueError):
        ComparisonSpec.model_validate(raw)


def test_committed_spec_validates():
    spec = ComparisonSpec.model_validate_json(SPEC.read_text(encoding="utf-8"))
    assert {run.name for run in spec.runs} >= {"legacy-prechunked", "legacy-ingest", "v2-all-off", "v2-recommended"}


def test_cli_exit_code_follows_the_verdict(tmp_path: Path, monkeypatch):
    spec, outputs = _world(tmp_path)
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(spec.model_dump_json(), encoding="utf-8")
    commands, _ = _stub_commands()
    import rag_eval.phase_compare as module

    monkeypatch.setattr(module, "default_runner", _stub_runner(outputs, {}))
    monkeypatch.setattr(module, "default_command_runner", commands)
    assert main(["--spec", str(spec_path), "--out", str(tmp_path / "cli")]) == 0
    assert main(["--spec", str(tmp_path / "missing.json"), "--out", str(tmp_path / "cli2")]) == 2
