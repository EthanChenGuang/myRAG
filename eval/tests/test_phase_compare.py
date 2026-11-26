import json
import shutil
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.eval_run import RagRunOptions, TraceCandidate, TraceRefusal
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.latency import LatencyBudgets, StageLatency
from rag_sidecar.contracts.report import InjectionReport, MetricValue
from rag_sidecar.contracts.retrieval import ChunkingDecision, ChunkingSweepReport
from test_report_runner import QUOTE, _manifest, _trace

from rag_eval.calibrate.refusal import CalibrationResult, CrossComparison
from rag_eval.gate import evaluate_gate
from rag_eval.metrics import score_items
from rag_eval.golden_io import write_golden
from rag_eval.phase_compare import (
    ComparisonSpec,
    RunRequest,
    SwitchComparison,
    SwitchComparisonSpec,
    LatencyBudgetSpec,
    absolute_zero_check,
    latency_budget_check,
    category_noise_check,
    citation_validity_check,
    gate_check,
    no_slice_drop_check,
    paired_all_zero_check,
    retrieval_unchanged_check,
    run_switch_comparison,
    default_runner,
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


ANSWERABLE_DENSE = 0.6
NO_ANSWER_DENSE = 0.1


def _candidate(item: GoldenItem, similarity: float) -> TraceCandidate:
    return TraceCandidate(
        rank=1, chunk_id=f"cand-{item.id}", document_id="d-cand", content="candidate", similarity=similarity, has_image=False
    )


def _output(
    misses=(),
    refused=("en-no_answer-001",),
    tokens: int = 100,
    threshold_refusals=(),
    lexical=None,
    rank2=(),
    dense=None,
    refusals=None,
) -> RunOutput:
    traces = []
    for item in GOLDEN:
        if item.id in refused:
            trace = _trace(item.id, [], refused=True)
        elif not item.answerable or item.id in misses:
            trace = _trace(item.id, [(DOC[item.id], "unrelated text")])
        elif item.id in rank2:
            trace = _trace(item.id, [(DOC[item.id], "unrelated text"), (DOC[item.id], f"intro {QUOTE} outro")])
        else:
            trace = _trace(item.id, [(DOC[item.id], f"intro {QUOTE} outro")])
        similarity = (dense or {}).get(item.id, ANSWERABLE_DENSE if item.answerable else NO_ANSWER_DENSE)
        update = {"context_tokens": tokens, "candidates": [_candidate(item, similarity)]}
        if item.id in threshold_refusals:
            update["refusal"] = TraceRefusal(decision="refuse", basis="rerank_threshold", reason="below_threshold")
        if refusals and item.id in refusals:
            update["refusal"] = refusals[item.id]
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
    assert result.baseline.refusal.passed is True and result.reference.refusal.passed is True
    assert result.baseline.refusal.strictly_improved is True and result.reference.refusal.strictly_improved is True
    assert result.strict_improvement.verdict == "improved"
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


def test_equal_correct_and_false_refusal_passes_with_the_strict_gain_open():
    baseline = _baseline(_output())
    result = recommended_rule(_output(), baseline, _output(), NOISE, run="r", reference_name="o")
    assert result.passed is True
    assert result.reference.refusal.method == "point"
    assert result.reference.refusal.strictly_improved is False
    assert result.strict_improvement.verdict == "open"
    assert "04-43" in result.strict_improvement.note


# ---------- rule (b) refusal at matched false refusal


def test_equal_correct_refusal_with_lower_false_refusal_passes_against_the_reference():
    reference = _output(refused=("en-no_answer-001", "zh-general-001"))
    result = recommended_rule(_output(), _baseline(_output()), reference, NOISE, run="r", reference_name="o")
    refusal = result.reference.refusal
    assert refusal.correct_refusal == refusal.reference_correct_refusal
    assert refusal.false_refusal < refusal.reference_false_refusal
    assert refusal.passed is True and result.reference.passed is True
    assert result.passed is True


def test_lower_correct_refusal_fails_against_the_reference():
    reference = _output(refused=NO_ANSWER)
    result = recommended_rule(_output(), _baseline(_output()), reference, NOISE, run="r", reference_name="o")
    assert result.reference.refusal.passed is False
    assert result.reference.passed is False and result.passed is False
    assert any("correct refusal" in failure for failure in result.reference.refusal.failures)


def test_equal_correct_refusal_with_higher_false_refusal_fails_against_the_reference():
    recommended = _output(refused=("en-no_answer-001", "zh-general-001"))
    result = recommended_rule(recommended, _baseline(_output()), _output(), NOISE, run="r", reference_name="o")
    refusal = result.reference.refusal
    assert refusal.correct_refusal == refusal.reference_correct_refusal
    assert refusal.passed is False
    assert any("false refusal" in failure for failure in refusal.failures)


def test_matched_false_refusal_fails_when_v2_refuses_fewer_no_answer_items_than_legacy():
    legacy = _output(refused=(*NO_ANSWER, "en-general-001"))
    baseline = _baseline(legacy)
    dense = {"zh-no_answer-001": 0.9}
    reference = _output(dense=dense)
    recommended = _output(refused=NO_ANSWER, dense=dense)
    result = recommended_rule(recommended, baseline, reference, NOISE, run="r", reference_name="o")
    refusal = result.baseline.refusal
    assert refusal.method == "matched_false_refusal"
    assert refusal.matched is not None
    assert refusal.matched.target_false_refusal == pytest.approx(1 / 6)
    assert refusal.matched.false_refusal <= 1 / 6
    assert refusal.matched.correct_refusal == 0.5
    assert refusal.matched.covers_reference is False and refusal.matched.missing == ["zh-no_answer-001"]
    assert refusal.passed is False and result.baseline.passed is False and result.passed is False


def test_matched_false_refusal_passes_when_v2_reaches_legacy_correct_refusal():
    baseline = _baseline(_output(refused=(*NO_ANSWER, "en-general-001")))
    dense = {"zh-no_answer-001": 0.15}
    result = recommended_rule(_output(refused=NO_ANSWER, dense=dense), baseline, _output(dense=dense), NOISE, run="r", reference_name="o")
    matched = result.baseline.refusal.matched
    assert matched is not None and matched.correct_refusal == 1.0
    assert matched.covers_reference is True and matched.missing == []
    assert result.baseline.refusal.passed is True


# ---------- rule (b) category slices by paired significance


def test_a_single_rank_move_on_a_three_item_category_is_report_only():
    reference = _output(rank2=("en-table-001",))
    recommended = _output(rank2=("en-general-001",), refused=NO_ANSWER)
    result = recommended_rule(recommended, _baseline(reference), reference, NOISE, run="r", reference_name="o")
    moves = {(move.drop.slice, move.drop.metric): move for move in result.reference.report_only}
    assert ("category:general", "mrr") in moves
    assert moves[("category:general", "mrr")].n == 3 and moves[("category:general", "mrr")].n_nonzero == 1
    assert result.reference.drops == []
    assert result.reference.passed is True and result.passed is True


def test_a_multi_item_category_drop_fails():
    reference = _output(rank2=("en-table-001", "it-xl-001"))
    recommended = _output(rank2=("en-general-001", "it-general-001"), refused=NO_ANSWER)
    result = recommended_rule(recommended, _baseline(reference), reference, NOISE, run="r", reference_name="o")
    assert ("category:general", "mrr") in {(drop.slice, drop.metric) for drop in result.reference.drops}
    assert not [drop for drop in result.reference.drops if not drop.slice.startswith("category:")]
    assert result.reference.passed is False and result.passed is False


def test_a_category_drop_whose_paired_interval_is_below_zero_fails():
    reference = _output(rank2=("en-clause-001",))
    recommended = _output(rank2=("en-table-001",), refused=NO_ANSWER)
    result = recommended_rule(recommended, _baseline(reference), reference, NOISE, run="r", reference_name="o")
    assert ("category:table", "mrr") in {(drop.slice, drop.metric) for drop in result.reference.drops}
    assert result.reference.passed is False


def test_an_overall_or_language_drop_beyond_the_band_still_fails():
    reference = _output()
    recommended = _output(rank2=("en-general-001",), refused=NO_ANSWER)
    result = recommended_rule(recommended, _baseline(reference), reference, NOISE, run="r", reference_name="o")
    slices = {(drop.slice, drop.metric) for drop in result.reference.drops}
    assert {("overall", "mrr"), ("language:en", "mrr")} <= slices
    assert ("category:general", "mrr") in {(m.drop.slice, m.drop.metric) for m in result.reference.report_only}
    assert result.reference.passed is False and result.passed is False


def test_gate_answers_below_the_similarity_floor_are_reported():
    floor = TraceRefusal(decision="answer", basis="similarity_floor", reason="above_similarity_floor", top_score=0.6, threshold=0.12)
    reference = _output(refusals={item.id: floor for item in GOLDEN if item.answerable})
    gate = TraceRefusal(
        decision="answer", basis="none", reason="above_threshold", top_score=0.07, threshold=0.04, cell_key="cohere|fake|zh|same"
    )
    recommended = _output(dense={"zh-no_answer-001": 0.05}, refusals={"zh-no_answer-001": gate})
    result = recommended_rule(recommended, _baseline(reference), reference, NOISE, run="r", reference_name="o")
    assert [(row.item_id, row.cell_key) for row in result.gate_below_floor] == [("zh-no_answer-001", "cohere|fake|zh|same")]
    row = result.gate_below_floor[0]
    assert row.floor == 0.12 and row.best_dense == 0.05 and row.split == "dev"


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


def test_run_phase_comparison_names_the_open_strict_refusal_gain(tmp_path: Path):
    spec, outputs = _world(tmp_path, recommended_refused=("en-no_answer-001",))
    commands, _ = _stub_commands()
    result = run_phase_comparison(spec, tmp_path / "out", runner=_stub_runner(outputs, {}), commands=commands)
    assert result.passed is True
    assert result.recommended.strict_improvement.verdict == "open"
    md = (tmp_path / "out" / "comparison.md").read_text(encoding="utf-8")
    assert "04-43" in md and "matched false refusal" in md


def test_run_phase_comparison_fails_when_a_rule_fails(tmp_path: Path):
    spec, outputs = _world(tmp_path, recommended_refused=())
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


def test_default_runner_reads_the_golden_file_named_by_the_run_manifest(tmp_path: Path):
    golden_path = tmp_path / "golden.jsonl"
    write_golden(golden_path, GOLDEN)
    output = _output()
    seen: list[list[str]] = []

    def spawner(argv, cwd):
        seen.append(argv)
        out = Path(argv[argv.index("--out") + 1])
        (out / "report.json").write_text(output.report.model_dump_json(), encoding="utf-8")
        (out / "traces.jsonl").write_text("\n".join(t.model_dump_json() for t in output.traces) + "\n", encoding="utf-8")
        manifest = _manifest().model_copy(update={"golden_path": str(golden_path)})
        (out / "run.json").write_text(manifest.model_dump_json(), encoding="utf-8")
        return type("Done", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    request = RunRequest(name="legacy", run_config={"name": "legacy", "env": {}, "overrides": None}, fixture_mode="ingest", out_dir=tmp_path / "run")
    result = default_runner(request, spawner=spawner)
    assert sorted(item.id for item in result.golden) == sorted(item.id for item in GOLDEN)
    assert seen[0][seen[0].index("--fixture-mode") + 1] == "ingest" and "--no-gate" in seen[0]
    assert json.loads((tmp_path / "run" / "inputs" / "run-config.json").read_text(encoding="utf-8"))["name"] == "legacy"


# ---------- schema 2: switch comparison (Phase 5 D-25)

SPEC5 = REPO_ROOT / "eval" / "config" / "phase5-comparison.json"
PHASE5_SWITCHES = (
    "RAG_CITATIONS",
    "RAG_CLAUDE_CITATIONS",
    "RAG_GROUNDEDNESS",
    "RAG_GROUNDEDNESS_VECTARA_OPT_IN",
    "RAG_GROUNDEDNESS_VECTARA_MULTI_TENANT_ACK",
    "RAG_ANSWER_FEEDBACK",
)


def _with_citations(output: RunOutput, invalid: float | None, n: int = 6) -> RunOutput:
    rate = None if invalid is None else MetricValue(value=invalid, n=n)
    return RunOutput(report=output.report.model_copy(update={"invalid_citation_rate": rate}), traces=output.traces, golden=output.golden)


def test_citation_validity_needs_a_measured_zero_invalid_rate():
    base = _output()
    assert citation_validity_check(_with_citations(base, 0.0)).passed is True
    failing = citation_validity_check(_with_citations(base, 0.25))
    assert failing.passed is False and failing.measures["invalid_citation_rate"] == 0.25
    assert citation_validity_check(_with_citations(base, None)).passed is False, "an unmeasured rate is not a zero rate"
    assert citation_validity_check(_with_citations(base, 0.0, n=0)).passed is False


def test_retrieval_unchanged_fails_on_any_nonzero_retrieval_paired_difference():
    base = _output()
    baseline = _baseline(base)
    assert retrieval_unchanged_check(_output(), baseline, NOISE).passed is True
    moved = retrieval_unchanged_check(_output(rank2=("en-general-001",)), baseline, NOISE)
    assert moved.passed is False
    assert any("mrr" in line for line in moved.detail)


def test_retrieval_unchanged_ignores_answer_only_options_but_not_other_data():
    base = _output()
    baseline = _baseline(base)
    on = base.report.model_copy(update={"request_options": base.report.request_options.model_copy(update={"citations": True, "groundedness": True})})
    assert retrieval_unchanged_check(RunOutput(report=on, traces=base.traces, golden=base.golden), baseline, NOISE).passed is True
    other = base.report.model_copy(update={"corpus_sha256": "d" * 64})
    result = retrieval_unchanged_check(RunOutput(report=other, traces=base.traces, golden=base.golden), baseline, NOISE)
    assert result.passed is False and any("corpus_sha256" in line for line in result.detail)


def test_paired_all_zero_is_stricter_than_retrieval_unchanged():
    base = _output()
    baseline = _baseline(base)
    assert paired_all_zero_check(_output(), baseline, NOISE).passed is True
    flipped = _output(refused=("en-no_answer-001", "zh-no_answer-001"))
    assert retrieval_unchanged_check(flipped, baseline, NOISE).passed is True
    assert paired_all_zero_check(flipped, baseline, NOISE).passed is False


def test_no_slice_drop_fails_beyond_the_noise_band():
    base = _output()
    baseline = _baseline(base)
    assert no_slice_drop_check(_output(), baseline, NOISE).passed is True
    dropped = no_slice_drop_check(_output(misses=("en-general-001", "en-table-001", "en-clause-001")), baseline, NOISE)
    assert dropped.passed is False and dropped.detail


def _switch_world(tmp_path: Path) -> SwitchComparisonSpec:
    baseline = _baseline(_output())
    for name in ("prechunked", "ingest"):
        (tmp_path / f"{name}.json").write_text(baseline.model_dump_json(), encoding="utf-8")
    raw = json.loads(SPEC5.read_text(encoding="utf-8"))
    raw["baselines"] = {"prechunked": str(tmp_path / "prechunked.json"), "ingest": str(tmp_path / "ingest.json")}
    return SwitchComparisonSpec.model_validate(raw)


def _switch_runner(outputs: dict[str, RunOutput], seen: dict):
    def runner(request):
        seen[request.name] = request
        return outputs[request.name]

    return runner


def _env_commands(codes: dict[str, int] | None = None):
    calls: list[tuple[list[str], dict[str, str]]] = []

    def run(argv: list[str], env: dict[str, str]) -> int:
        calls.append((list(argv), dict(env)))
        for marker, code in (codes or {}).items():
            if marker in " ".join(argv):
                return code
        return 0

    return run, calls


def _passing_outputs(spec: SwitchComparisonSpec) -> dict[str, RunOutput]:
    return {run.name: _with_citations(_output(), 0.0) if "--citations" in run.harness_flags else _output() for run in spec.runs}


def test_committed_phase5_spec_names_both_fixture_modes_switched_off_and_on():
    spec = SwitchComparisonSpec.model_validate_json(SPEC5.read_text(encoding="utf-8"))
    off = [run for run in spec.runs if run.name.startswith("off-")]
    on = [run for run in spec.runs if run.name.startswith("on-")]
    assert {run.fixture_mode for run in off} == {"prechunked", "ingest"} == {run.fixture_mode for run in on}
    for run in off:
        assert {name: run.switches.get(name) for name in PHASE5_SWITCHES} == {name: "false" for name in PHASE5_SWITCHES}
        assert run.harness_flags == []
        assert {"paired_all_zero", "characterization"} <= set(run.checks)
    for run in on:
        assert run.switches["RAG_CITATIONS"] == "true" and run.switches["RAG_GROUNDEDNESS"] == "true"
        assert {name: run.switches.get(name) for name in set(PHASE5_SWITCHES) - {"RAG_CITATIONS", "RAG_GROUNDEDNESS"}} == {
            name: "false" for name in set(PHASE5_SWITCHES) - {"RAG_CITATIONS", "RAG_GROUNDEDNESS"}
        }
        assert run.harness_flags == ["--citations", "--groundedness"]
        assert {"retrieval_unchanged", "no_slice_drop", "citation_validity", "strict_refusal"} <= set(run.checks)


def test_switch_spec_rejects_unknown_checks_secrets_and_unknown_flags():
    raw = json.loads(SPEC5.read_text(encoding="utf-8"))
    for mutate in (
        lambda r: r["runs"][0]["checks"].append("made_up"),
        lambda r: r["runs"][0]["switches"].update({"ANTHROPIC_API_KEY": "placeholder"}),
        lambda r: r["runs"][0]["switches"].update({"RAG_SIDECAR_SECRET": "placeholder"}),
        lambda r: r["runs"][0]["harness_flags"].append("--base-url"),
        lambda r: r["runs"].append(dict(r["runs"][0])),
    ):
        broken = json.loads(json.dumps(raw))
        mutate(broken)
        with pytest.raises(ValueError):
            SwitchComparisonSpec.model_validate(broken)


def test_run_switch_comparison_passes_and_writes_one_table_per_run(tmp_path: Path):
    spec = _switch_world(tmp_path)
    seen: dict = {}
    commands, calls = _env_commands()
    out = tmp_path / "phase-05"
    result = run_switch_comparison(spec, out, runner=_switch_runner(_passing_outputs(spec), seen), commands=commands)
    assert result.passed is True, result.model_dump_json(indent=2)
    stored = SwitchComparison.model_validate_json((out / "comparison.json").read_text(encoding="utf-8"))
    assert stored.passed is True and [run.name for run in stored.runs] == [run.name for run in spec.runs]
    md = (out / "comparison.md").read_text(encoding="utf-8")
    for run in spec.runs:
        assert f"### {run.name}" in md
    on = next(run for run in spec.runs if run.name.startswith("on-"))
    request = seen[on.name]
    assert request.process_env["RAG_CITATIONS"] == "true" and list(request.harness_flags) == ["--citations", "--groundedness"]
    assert any("chat-strict" in " ".join(argv) and env.get("RAG_CITATIONS") == "true" for argv, env in calls)
    assert any("characterize-chat" in " ".join(argv) and env.get("RAG_CITATIONS") == "false" for argv, env in calls)


@pytest.mark.parametrize(
    "breaker",
    ["invalid_citations", "retrieval_moved", "command_failed", "off_refusal_changed"],
)
def test_run_switch_comparison_fails_on_a_synthetic_failing_input(tmp_path: Path, breaker: str):
    spec = _switch_world(tmp_path)
    outputs = _passing_outputs(spec)
    on = next(run.name for run in spec.runs if run.name.startswith("on-"))
    off = next(run.name for run in spec.runs if run.name.startswith("off-"))
    codes = None
    if breaker == "invalid_citations":
        outputs[on] = _with_citations(outputs[on], 0.1)
    elif breaker == "retrieval_moved":
        outputs[on] = _with_citations(_output(rank2=("en-general-001",)), 0.0)
    elif breaker == "off_refusal_changed":
        outputs[off] = _output(refused=("en-no_answer-001", "zh-no_answer-001"))
    else:
        codes = {"chat-strict": 1}
    commands, _ = _env_commands(codes)
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(outputs, {}), commands=commands)
    assert result.passed is False
    assert "FAIL" in (tmp_path / "out" / "comparison.md").read_text(encoding="utf-8")


def test_cli_dispatches_a_schema_2_spec(tmp_path: Path, monkeypatch):
    spec = _switch_world(tmp_path)
    spec_path = tmp_path / "spec5.json"
    spec_path.write_text(spec.model_dump_json(), encoding="utf-8")
    import rag_eval.phase_compare as module

    commands, _ = _env_commands()
    monkeypatch.setattr(module, "default_runner", _switch_runner(_passing_outputs(spec), {}))
    monkeypatch.setattr(module, "default_env_command_runner", commands)
    assert main(["--spec", str(spec_path), "--out", str(tmp_path / "cli")]) == 0
    assert json.loads((tmp_path / "cli" / "comparison.json").read_text(encoding="utf-8"))["schema_version"] == 2


def test_default_runner_passes_switches_and_harness_flags(tmp_path: Path):
    output = _output()
    seen: list[tuple[list[str], dict]] = []

    def spawner(argv, cwd, env=None):
        seen.append((argv, env))
        out = Path(argv[argv.index("--out") + 1])
        (out / "report.json").write_text(output.report.model_dump_json(), encoding="utf-8")
        (out / "traces.jsonl").write_text("\n".join(t.model_dump_json() for t in output.traces) + "\n", encoding="utf-8")
        golden_path = tmp_path / "golden.jsonl"
        write_golden(golden_path, GOLDEN)
        (out / "run.json").write_text(_manifest().model_copy(update={"golden_path": str(golden_path)}).model_dump_json(), encoding="utf-8")
        return type("Done", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    request = RunRequest(
        name="on-prechunked",
        run_config={"name": "on-prechunked", "env": {}, "overrides": None},
        fixture_mode="prechunked",
        out_dir=tmp_path / "run",
        process_env={"RAG_CITATIONS": "true"},
        harness_flags=("--citations",),
    )
    default_runner(request, spawner=spawner)
    argv, env = seen[0]
    assert "--citations" in argv and env["RAG_CITATIONS"] == "true"


# ---------- Phase 5.1: absolute_zero and category_noise (D-14), retrieval_unchanged with exclusions, gate

SPEC51 = REPO_ROOT / "eval" / "config" / "phase51-comparison.json"
ASR_PATH = 'injection.attack_success_rate["category:injection"]'
FP_PATH = "injection.rules_false_positive_count"


def _injection(asr: float | None = 0.0, n: int = 12, rules_fp: int = 0, label: str = "recommended") -> InjectionReport:
    rates = {"category:injection": MetricValue(value=asr, n=n)}
    for language in ("en", "zh", "it"):
        rates[f"language_category:{language}:injection"] = MetricValue(value=asr, n=n // 3)
    return InjectionReport(
        config_label=label,
        items=n,
        exposure_rate=dict(rates),
        attack_success_rate=rates,
        rules_false_positive_count=rules_fp,
        gate="absolute_zero" if label == "recommended" else "report_only",
    )


def _with_injection(output: RunOutput, injection: InjectionReport | None) -> RunOutput:
    return RunOutput(report=output.report.model_copy(update={"injection": injection}), traces=output.traces, golden=output.golden)


def test_absolute_zero_passes_only_on_a_measured_zero():
    base = _output()
    assert absolute_zero_check(_with_injection(base, _injection()), ASR_PATH).passed is True
    assert absolute_zero_check(_with_injection(base, _injection()), FP_PATH).passed is True
    failing = absolute_zero_check(_with_injection(base, _injection(asr=1 / 12)), ASR_PATH)
    assert failing.passed is False and ASR_PATH in failing.detail[0] and "0.0833" in failing.detail[0]
    fp = absolute_zero_check(_with_injection(base, _injection(rules_fp=2)), FP_PATH)
    assert fp.passed is False and fp.measures[FP_PATH] == 2.0


@pytest.mark.parametrize(
    "injection,path",
    [
        (None, ASR_PATH),
        (_injection(), 'injection.attack_success_rate["category:injection_evasive"]'),
        (_injection(asr=None), ASR_PATH),
        (_injection(n=0), ASR_PATH),
        (_injection(), "injection.config_label"),
    ],
)
def test_absolute_zero_never_passes_vacuously(injection, path):
    result = absolute_zero_check(_with_injection(_output(), injection), path)
    assert result.passed is False and result.detail


def test_absolute_zero_rejects_a_malformed_path_in_the_spec():
    raw = json.loads(SPEC5.read_text(encoding="utf-8"))
    raw["runs"][0]["checks"].append({"kind": "absolute_zero", "path": 'injection..attack["x'})
    with pytest.raises(ValueError):
        SwitchComparisonSpec.model_validate(raw)


def _without_category(output: RunOutput, category: str) -> RunOutput:
    by_category = {name: metrics for name, metrics in output.report.by_category.items() if name != category}
    return RunOutput(report=output.report.model_copy(update={"by_category": by_category}), traces=output.traces, golden=output.golden)


def test_category_noise_names_a_dropped_category_slice():
    base = _output()
    baseline = _baseline(base)
    assert category_noise_check(_output(), baseline, NOISE, exclude=[]).passed is True
    dropped = category_noise_check(_output(misses=("en-table-001",)), baseline, NOISE, exclude=[])
    assert dropped.passed is False
    assert any(line.startswith("category:table:") for line in dropped.detail)


def test_category_noise_ignores_excluded_categories_and_non_category_slices():
    base = _output()
    baseline = _baseline(base)
    observed = _output(misses=("en-table-001",))
    assert category_noise_check(observed, baseline, NOISE, exclude=["table"]).passed is True
    overall_only = category_noise_check(_output(misses=("en-general-001", "zh-general-001", "it-general-001")), baseline, NOISE, exclude=["general"])
    assert overall_only.passed is True, "overall and language slices are the gate's business, not category_noise"


def test_category_noise_fails_on_a_missing_slice_or_other_data():
    base = _output()
    baseline = _baseline(base)
    missing = category_noise_check(_without_category(_output(), "table"), baseline, NOISE, exclude=[])
    assert missing.passed is False and any("category:table" in line and "missing" in line for line in missing.detail)
    nothing = category_noise_check(_output(), baseline, NOISE, exclude=["general", "table", "compound", "cross_lingual", "no_answer"])
    assert nothing.passed is False, "a check that compared no slice must not pass"
    other = base.report.model_copy(update={"corpus_sha256": "d" * 64})
    assert category_noise_check(RunOutput(report=other, traces=base.traces, golden=base.golden), baseline, NOISE, exclude=[]).passed is False


def test_retrieval_unchanged_can_exclude_categories():
    base = _output()
    baseline = _baseline(base)
    moved = _output(rank2=("en-table-001",))
    assert retrieval_unchanged_check(moved, baseline, NOISE).passed is False
    assert retrieval_unchanged_check(moved, baseline, NOISE, exclude_categories=["table"]).passed is True
    assert retrieval_unchanged_check(_output(rank2=("en-general-001",)), baseline, NOISE, exclude_categories=["table"]).passed is False


def test_gate_check_follows_the_ci_gate_including_the_absolute_zero_offenders():
    base = _output()
    baseline = _baseline(base)
    assert gate_check(_output(), baseline, NOISE).passed is True
    attacked = gate_check(_with_injection(_output(), _injection(asr=0.5)), baseline, NOISE)
    assert attacked.passed is False and any("attack_success_rate" in line for line in attacked.detail)
    reported = gate_check(_with_injection(_output(), _injection(asr=0.5, label="tagging_only")), baseline, NOISE)
    assert reported.passed is True, "only the recommended label is gated at zero (A-13)"


def test_existing_specs_still_validate_with_string_checks_only():
    spec4 = ComparisonSpec.model_validate_json(SPEC.read_text(encoding="utf-8"))
    assert spec4.runs
    spec5 = SwitchComparisonSpec.model_validate_json(SPEC5.read_text(encoding="utf-8"))
    assert all(isinstance(check, str) for run in spec5.runs for check in run.checks)


def test_phase5_comparison_output_has_no_injection_key_when_no_run_measured_injection(tmp_path: Path):
    spec = _switch_world(tmp_path)
    commands, _ = _env_commands()
    run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_passing_outputs(spec), {}), commands=commands)
    stored = json.loads((tmp_path / "out" / "comparison.json").read_text(encoding="utf-8"))
    assert all("injection" not in run and "run_config_env" not in run for run in stored["runs"])


def _spec51_world(tmp_path: Path) -> SwitchComparisonSpec:
    baseline = _baseline(_output())
    (tmp_path / "prechunked.json").write_text(baseline.model_dump_json(), encoding="utf-8")
    raw = json.loads(SPEC51.read_text(encoding="utf-8"))
    raw["baselines"] = {"prechunked": str(tmp_path / "prechunked.json")}
    return SwitchComparisonSpec.model_validate(raw)


def _spec51_outputs(spec: SwitchComparisonSpec, **changes: RunOutput) -> dict[str, RunOutput]:
    labels = {"all-off": "all_off", "recommended": "recommended", "tagging-only": "tagging_only"}
    outputs = {
        run.name: _with_injection(_output(), _injection(asr=0.0 if run.name == "recommended" else 0.5, label=labels.get(run.name, "other")))
        for run in spec.runs
    }
    outputs.update(changes)
    return outputs


def test_committed_phase51_spec_gates_all_off_and_recommended_and_reports_the_rest():
    spec = SwitchComparisonSpec.model_validate_json(SPEC51.read_text(encoding="utf-8"))
    runs = {run.name: run for run in spec.runs}
    assert set(runs) == {"all-off", "recommended", "tagging-only", "flag", "downweight"}
    assert runs["all-off"].base == "eval/config/runs/sec-all-off.json"
    assert {"gate", "paired_all_zero"} <= set(runs["all-off"].checks)
    recommended = runs["recommended"]
    assert recommended.base == "eval/config/runs/sec-recommended.json" and recommended.env == {}
    kinds = {getattr(check, "kind", check): check for check in recommended.checks}
    assert "gate" in kinds
    zero_paths = {check.path for check in recommended.checks if getattr(check, "kind", None) == "absolute_zero"}
    assert zero_paths == {ASR_PATH, FP_PATH}
    assert sorted(kinds["category_noise"].exclude) == ["injection", "injection_evasive"]
    assert sorted(kinds["retrieval_unchanged"].exclude_categories) == ["injection", "injection_evasive"]
    assert runs["flag"].base == runs["downweight"].base == "eval/config/runs/sec-recommended.json"
    assert runs["flag"].env == {"RAG_INJECTION_CHECK": "flag"} and runs["downweight"].env == {"RAG_INJECTION_CHECK": "downweight"}
    for name in ("tagging-only", "flag", "downweight"):
        assert runs[name].checks == ["report_only"]


def test_run_switch_comparison_phase51_passes_and_records_injection(tmp_path: Path):
    spec = _spec51_world(tmp_path)
    seen: dict = {}
    commands, _ = _env_commands()
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_spec51_outputs(spec), seen), commands=commands)
    assert result.passed is True, result.model_dump_json(indent=2)
    assert seen["flag"].run_config["env"]["RAG_INJECTION_CHECK"] == "flag"
    assert seen["flag"].run_config["env"]["RAG_CONTEXT_TAGGING"] == "true"
    assert seen["recommended"].run_config["env"]["RAG_INJECTION_CHECK"] == "drop"
    stored = json.loads((tmp_path / "out" / "comparison.json").read_text(encoding="utf-8"))
    by_name = {run["name"]: run for run in stored["runs"]}
    assert by_name["tagging-only"]["injection"]["attack_success_rate"]["category:injection"]["value"] == 0.5
    md = (tmp_path / "out" / "comparison.md").read_text(encoding="utf-8")
    assert "attack success" in md.lower() and "report_only" in md
    assert "Run-config env: RAG_CONTEXT_TAGGING=true, RAG_INJECTION_CHECK=flag" in md
    assert by_name["flag"]["run_config_env"]["RAG_INJECTION_CHECK"] == "flag"
    assert "stub extractive generator" in stored["notes"][0]


@pytest.mark.parametrize("breaker", ["attack_succeeded", "rules_false_positive", "category_dropped", "off_moved", "no_injection_block"])
def test_run_switch_comparison_phase51_fails_on_each_gated_condition(tmp_path: Path, breaker: str):
    spec = _spec51_world(tmp_path)
    changes = {
        "attack_succeeded": {"recommended": _with_injection(_output(), _injection(asr=1 / 12))},
        "rules_false_positive": {"recommended": _with_injection(_output(), _injection(rules_fp=1))},
        "category_dropped": {"recommended": _with_injection(_output(misses=("en-table-001",)), _injection())},
        "off_moved": {"all-off": _with_injection(_output(rank2=("en-general-001",)), _injection(asr=0.5, label="all_off"))},
        "no_injection_block": {"recommended": _with_injection(_output(), None)},
    }[breaker]
    commands, _ = _env_commands()
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_spec51_outputs(spec, **changes), {}), commands=commands)
    assert result.passed is False


def test_report_only_runs_never_fail_the_comparison(tmp_path: Path):
    spec = _spec51_world(tmp_path)
    worse = _with_injection(_output(misses=("en-general-001", "en-table-001", "en-clause-001")), _injection(asr=1.0, label="other"))
    commands, _ = _env_commands()
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_spec51_outputs(spec, flag=worse), {}), commands=commands)
    assert result.passed is True


# ---------- Phase 5.1.1 closing comparison (plan 05.1.1-22)

SPEC511 = REPO_ROOT / "eval" / "config" / "phase5.1.1-comparison.json"
PHASE511_DEFAULTS = {
    "RAG_RETRIEVAL_LOG": "off",
    "RAG_RETRIEVAL_LOG_RETENTION_DAYS": "30",
    "RAG_REFUSAL_FEEDBACK": "false",
    "RAG_EMBED_FEEDBACK": "false",
    "RAG_SOURCE_OPEN_SIGNAL": "false",
    "RAG_DOMAIN_EXPERT_REVIEW": "false",
}
PHASE511_ON = {
    "RAG_RETRIEVAL_LOG": "masked_query",
    "RAG_REFUSAL_FEEDBACK": "true",
    "RAG_EMBED_FEEDBACK": "true",
    "RAG_SOURCE_OPEN_SIGNAL": "true",
    "RAG_DOMAIN_EXPERT_REVIEW": "true",
}
FAST = {"analyze": 1.0, "embed": 2.0, "search": 6.0, "assemble": 0.0, "generation": 5.0, "retrieval_total": 12.0}


def _with_latency(output: RunOutput, p95: dict[str, float] | None) -> RunOutput:
    latency = None if p95 is None else {stage: StageLatency(p50_ms=value, p95_ms=value, n=10) for stage, value in p95.items()}
    return RunOutput(report=output.report.model_copy(update={"latency": latency}), traces=output.traces, golden=output.golden)


def _spec511_world(tmp_path: Path) -> SwitchComparisonSpec:
    baseline = _baseline(_output())
    for name in ("prechunked", "ingest"):
        (tmp_path / f"{name}.json").write_text(baseline.model_dump_json(), encoding="utf-8")
    raw = json.loads(SPEC511.read_text(encoding="utf-8"))
    raw["baselines"] = {"prechunked": str(tmp_path / "prechunked.json"), "ingest": str(tmp_path / "ingest.json")}
    return SwitchComparisonSpec.model_validate(raw)


def _spec511_outputs(spec: SwitchComparisonSpec, **changes: RunOutput) -> dict[str, RunOutput]:
    outputs = {run.name: _with_latency(_output(), FAST) for run in spec.runs}
    outputs.update({name.replace("_", "-"): output for name, output in changes.items()})
    return outputs


def test_committed_phase511_spec_runs_both_fixture_modes_off_and_on():
    spec = SwitchComparisonSpec.model_validate_json(SPEC511.read_text(encoding="utf-8"))
    runs = {run.name: run for run in spec.runs}
    assert set(runs) == {"off-prechunked", "off-ingest", "on-prechunked", "on-ingest"}
    assert set(spec.baselines) == {"prechunked", "ingest"}
    for mode in ("prechunked", "ingest"):
        off, on = runs[f"off-{mode}"], runs[f"on-{mode}"]
        assert off.fixture_mode == on.fixture_mode == mode
        assert off.switches == PHASE511_DEFAULTS
        assert {name: on.switches.get(name) for name in PHASE511_ON} == PHASE511_ON
        assert not any("SECRET" in name for name in on.switches)
        assert off.harness_flags == on.harness_flags == []
        assert {"paired_all_zero", "characterization"} <= {check for check in off.checks if isinstance(check, str)}
        assert {"retrieval_unchanged", "no_slice_drop"} <= {check for check in on.checks if isinstance(check, str)}
        latency = next(check for check in on.checks if getattr(check, "kind", None) == "latency_budget")
        assert latency.against == f"off-{mode}" and latency.budgets == "eval/config/latency-budgets.json"
    assert "tests/rag/feedback-loop/refusal-metadata.test.ts" in spec.commands["characterization"]


def test_run_switch_comparison_phase511_passes(tmp_path: Path):
    spec = _spec511_world(tmp_path)
    seen: dict = {}
    commands, calls = _env_commands()
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_spec511_outputs(spec), seen), commands=commands)
    assert result.passed is True, result.model_dump_json(indent=2)
    assert seen["on-ingest"].process_env["RAG_RETRIEVAL_LOG"] == "masked_query"
    assert any("characterize-chat" in " ".join(argv) and env.get("RAG_RETRIEVAL_LOG") == "off" for argv, env in calls)
    by_name = {run.name: run for run in result.runs}
    assert any(check.name == "latency_budget" and check.passed for check in by_name["on-prechunked"].checks)


@pytest.mark.parametrize("breaker", ["retrieval_moved", "off_moved", "over_budget", "total_over_budget", "slower_than_off", "not_measured", "stage_missing"])
def test_run_switch_comparison_phase511_fails_on_a_synthetic_failing_input(tmp_path: Path, breaker: str):
    spec = _spec511_world(tmp_path)
    changes = {
        "retrieval_moved": {"on_prechunked": _with_latency(_output(rank2=("en-general-001",)), FAST)},
        "off_moved": {"off_ingest": _with_latency(_output(misses=("en-general-001",)), FAST)},
        "over_budget": {"on_ingest": _with_latency(_output(), {**FAST, "search": 450.0})},
        "total_over_budget": {"off_prechunked": _with_latency(_output(), {**FAST, "retrieval_total": 2500.0})},
        "slower_than_off": {"on_prechunked": _with_latency(_output(), {**FAST, "embed": 2.0 * 1.5 + 5.0 + 1.0})},
        "not_measured": {"on_ingest": _with_latency(_output(), None)},
        "stage_missing": {"on_ingest": _with_latency(_output(), {k: v for k, v in FAST.items() if k != "search"})},
    }[breaker]
    commands, _ = _env_commands()
    result = run_switch_comparison(spec, tmp_path / "out", runner=_switch_runner(_spec511_outputs(spec, **changes), {}), commands=commands)
    assert result.passed is False
    assert "FAIL" in (tmp_path / "out" / "comparison.md").read_text(encoding="utf-8")


def test_latency_budget_check_allows_the_noise_band_and_fails_beyond_it():
    budgets = LatencyBudgets.model_validate_json((REPO_ROOT / "eval" / "config" / "latency-budgets.json").read_text(encoding="utf-8"))
    check = LatencyBudgetSpec(kind="latency_budget", profile="chat", against="off", tolerance_ms=5, tolerance_ratio=0.5)
    off = _with_latency(_output(), FAST)
    within = latency_budget_check(_with_latency(_output(), {**FAST, "search": 6.0 * 1.5 + 5.0}), budgets, check, off)
    assert within.passed is True, within.detail
    beyond = latency_budget_check(_with_latency(_output(), {**FAST, "search": 6.0 * 1.5 + 5.5}), budgets, check, off)
    assert beyond.passed is False and any("search" in line for line in beyond.detail)
    unbudgeted = latency_budget_check(_with_latency(_output(), {**FAST, "made_up_stage": 9000.0}), budgets, check.model_copy(update={"against": None}))
    assert unbudgeted.passed is True, unbudgeted.detail
    assert latency_budget_check(off, budgets, check, None).passed is False


@pytest.mark.parametrize("against", ["missing-run", "on-prechunked", "off-ingest"])
def test_phase511_spec_rejects_a_latency_reference_that_is_not_an_earlier_run_of_the_same_mode(against: str):
    raw = json.loads(SPEC511.read_text(encoding="utf-8"))
    on = next(run for run in raw["runs"] if run["name"] == "on-prechunked")
    next(check for check in on["checks"] if isinstance(check, dict))["against"] = against
    with pytest.raises(ValueError):
        SwitchComparisonSpec.model_validate(raw)


# ---------- schema 3: Phase 3.2 per-switch arms (plan 03.2-66, D-46)

PHASE32_SPEC = REPO_ROOT / "eval" / "config" / "phase32-comparison.json"
PHASE32_ARMS = ("language_aware_ingest", "table_header_repeat", "table_row_serialization", "caption_language", "doc_translation")


def _arm_item(item_id: str, language: str, category: str = "general", *, hit: bool = True, evidence: str | None = None, **extra) -> dict:
    item = {
        "item_id": item_id,
        "language": language,
        "category": category,
        "split": "test",
        "provenance": "synthetic_fixture",
        "answerable": True,
        "refused": False,
        "span_count": 1,
        "spans_hit_at_5": 1 if hit else 0,
        "spans_hit_at_10": 1 if hit else 0,
        "first_hit_rank": 1 if hit else None,
    }
    if evidence is not None:
        item["evidence_language"] = evidence
    item.update(extra)
    return item


def _arm_items(**misses: bool) -> list[dict]:
    """Twelve neutral items over three languages, the table slices, an image item and a cross-lingual pair; `misses` turns hits off."""
    items = []
    for language in ("en", "zh", "it"):
        items += [
            _arm_item(f"{language}-general-001", language),
            _arm_item(f"{language}-general-002", language),
            _arm_item(f"{language}-table-001", language, "table"),
            _arm_item(f"{language}-table-split-001", language, "table_split"),
        ]
    items += [_arm_item("ingest-image-caption-en", "en", "general"), _arm_item("xl-en-it-01", "en", "cross_lingual", evidence="it")]
    for item in items:
        if misses.get(item["item_id"].replace("-", "_")):
            item.update(spans_hit_at_5=0, spans_hit_at_10=0, first_hit_rank=None)
    return items


def _arm_report(path: Path, items: list[dict], embedder: str | None = "fixture-hash-ngram") -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"embedder_id": embedder, "items": items}), encoding="utf-8")
    return str(path)


def _arm_world(tmp_path: Path, runs: dict[str, tuple[list[dict], list[dict]]], embedder: str | None = "fixture-hash-ngram") -> tuple[Path, Path]:
    manifest = {
        name: {"off": _arm_report(tmp_path / name / "off.json", off, embedder), "on": _arm_report(tmp_path / name / "on.json", on, embedder)}
        for name, (off, on) in runs.items()
    }
    runs_path = tmp_path / "runs.json"
    runs_path.write_text(json.dumps(manifest), encoding="utf-8")
    return PHASE32_SPEC, runs_path


def _run_arms(tmp_path: Path, runs: dict[str, tuple[list[dict], list[dict]]], embedder: str | None = "fixture-hash-ngram") -> tuple[int, dict, str]:
    spec, runs_path = _arm_world(tmp_path, runs, embedder)
    out = tmp_path / "out"
    code = main(["--spec", str(spec), "--runs", str(runs_path), "--out", str(out)])
    payload = json.loads((out / "comparison.json").read_text(encoding="utf-8")) if (out / "comparison.json").exists() else {}
    markdown = (out / "comparison.md").read_text(encoding="utf-8") if (out / "comparison.md").exists() else ""
    return code, payload, markdown


def _all_arms(**overrides: tuple[list[dict], list[dict]]) -> dict[str, tuple[list[dict], list[dict]]]:
    runs = {name: (_arm_items(), _arm_items()) for name in PHASE32_ARMS}
    runs.update(overrides)
    return runs


def _arm(payload: dict, name: str) -> dict:
    return next(arm for arm in payload["arms"] if arm["name"] == name)


def test_phase32_spec_names_one_arm_per_switch_with_the_slices_it_is_judged_on():
    spec = json.loads(PHASE32_SPEC.read_text(encoding="utf-8"))
    assert spec["schema_version"] == 3
    arms = {arm["name"]: arm for arm in spec["arms"]}
    assert tuple(arms) == PHASE32_ARMS
    assert arms["language_aware_ingest"]["switch"] == "RAG_LANGUAGE_AWARE_INGEST"
    assert arms["language_aware_ingest"]["judged"] == ["language:"]
    for name, switch in (("table_header_repeat", "RAG_TABLE_HEADER_REPEAT"), ("table_row_serialization", "RAG_TABLE_ROW_SERIALIZATION")):
        assert arms[name]["switch"] == switch
        assert arms[name]["judged"] == ["category:table", "category:table_split"]
    assert arms["caption_language"]["switch"] == "RAG_CAPTION_LANGUAGE"
    assert arms["caption_language"]["judged"] == ["image:"]
    assert "image" in spec["item_groups"]
    assert arms["doc_translation"]["switch"] == "RAG_DOC_TRANSLATION"
    assert arms["doc_translation"]["judged"] == ["category:cross_lingual", "pair:"]
    assert spec["live_checks"] == "03.2-53"


def test_phase32_spec_has_no_bge_m3_arm():
    spec = json.loads(PHASE32_SPEC.read_text(encoding="utf-8"))
    for arm in spec["arms"]:
        assert "bge" not in arm["name"].lower()
        assert arm["switch"] != "RAG_BGE_M3_SERVING"
        assert "RAG_EMBEDDING_PROFILES" not in json.dumps(arm)


def test_each_arm_reports_off_on_and_the_paired_difference_on_its_judged_slices(tmp_path: Path):
    worse = _arm_items(zh_general_001=True, zh_general_002=True)
    code, payload, markdown = _run_arms(tmp_path, _all_arms(language_aware_ingest=(worse, _arm_items())))
    arm = _arm(payload, "language_aware_ingest")
    rows = {(row["slice"], row["metric"]): row for row in arm["rows"]}
    assert {row["slice"] for row in arm["rows"]} == {"language:en", "language:zh", "language:it"}
    zh = rows[("language:zh", "recall_at_10")]
    assert zh["off"] == 0.5 and zh["on"] == 1.0
    assert zh["paired"]["mean_d"] == 0.5
    assert zh["beyond_band"] is True and zh["direction"] == "up"
    en = rows[("language:en", "recall_at_10")]
    assert en["paired"]["mean_d"] == 0 and en["beyond_band"] is False
    assert arm["status"] == "passed" and arm["failures"] == []
    assert code == 0
    assert "### language_aware_ingest" in markdown and "| language:zh | recall_at_10 |" in markdown


def test_table_arms_are_judged_on_table_and_table_split_and_caption_on_image_items(tmp_path: Path):
    _, payload, _ = _run_arms(tmp_path, _all_arms())
    for name in ("table_header_repeat", "table_row_serialization"):
        assert {row["slice"] for row in _arm(payload, name)["rows"]} == {"category:table", "category:table_split"}
    assert {row["slice"] for row in _arm(payload, "caption_language")["rows"]} == {"image:en"}
    assert {row["slice"] for row in _arm(payload, "doc_translation")["rows"]} == {"category:cross_lingual", "pair:en->it"}


def test_an_arm_whose_on_run_drops_a_gated_slice_fails_and_names_the_slice(tmp_path: Path):
    dropped = _arm_items(it_general_001=True, it_general_002=True, it_table_001=True)
    code, payload, markdown = _run_arms(tmp_path, _all_arms(table_row_serialization=(_arm_items(), dropped)))
    arm = _arm(payload, "table_row_serialization")
    assert arm["status"] == "failed"
    assert any(failure.startswith("language:it:recall_at_10 dropped by") for failure in arm["failures"])
    assert any(failure.startswith("overall:") for failure in arm["failures"])
    assert not any(failure.startswith("category:table:") for failure in arm["failures"]), "category:table is not a gated slice"
    assert payload["passed"] is False
    assert code == 10
    assert "language:it:recall_at_10 dropped by" in markdown


def test_a_drop_within_the_band_or_on_a_report_only_item_does_not_fail(tmp_path: Path):
    off = _arm_items() + [_arm_item(f"en-bulk-{index:03d}", "en") for index in range(60)]
    on = _arm_items() + [_arm_item(f"en-bulk-{index:03d}", "en", hit=index != 0) for index in range(60)]
    pending = [_arm_item("it-drafted-001", "it", "table_split", report_only_reason="native_review_pending")]
    pending_miss = [_arm_item("it-drafted-001", "it", "table_split", hit=False, report_only_reason="native_review_pending")]
    _, payload, _ = _run_arms(tmp_path, _all_arms(table_header_repeat=(off + pending, on + pending_miss)))
    arm = _arm(payload, "table_header_repeat")
    assert arm["status"] == "passed", arm["failures"]
    split = next(row for row in arm["rows"] if row["slice"] == "category:table_split" and row["metric"] == "recall_at_10")
    assert split["n"] == 4 and split["paired"]["mean_d"] == -0.25


def test_fixture_runs_are_wiring_proof_and_carry_no_recommendation(tmp_path: Path):
    _, payload, markdown = _run_arms(tmp_path, _all_arms())
    assert payload["wiring_proof"] is True
    assert "wiring proof" in payload["label"]
    assert all(arm["recommendation"] is None for arm in payload["arms"])
    assert "wiring proof" in markdown.lower()
    assert "Recommendation:" not in markdown
    assert "03.2-53" in markdown


def test_live_runs_carry_a_recommendation(tmp_path: Path):
    _, payload, markdown = _run_arms(tmp_path, _all_arms(), embedder="openai-3-small-1536")
    assert payload["wiring_proof"] is False and payload["label"] is None
    assert all(arm["recommendation"] for arm in payload["arms"])
    assert "Recommendation:" in markdown


def test_an_optional_arm_without_runs_is_not_run_and_a_required_one_fails(tmp_path: Path):
    runs = _all_arms()
    optional = [arm["name"] for arm in json.loads(PHASE32_SPEC.read_text(encoding="utf-8"))["arms"] if arm.get("optional")]
    assert optional == ["doc_translation"]
    del runs["doc_translation"]
    code, payload, markdown = _run_arms(tmp_path, runs)
    assert _arm(payload, "doc_translation")["status"] == "not_run"
    assert "This optional arm was not run." in markdown
    assert code == 0 and payload["passed"] is True
    del runs["caption_language"]
    code, payload, markdown = _run_arms(tmp_path / "required", runs)
    assert _arm(payload, "caption_language")["status"] == "failed"
    assert "This required arm did not run, so it fails the comparison." in markdown
    assert code == 10


def test_a_schema3_spec_needs_the_runs_manifest(tmp_path: Path):
    assert main(["--spec", str(PHASE32_SPEC), "--out", str(tmp_path / "out")]) == 2


def test_an_arm_records_its_run_ids_and_the_counting_rows_of_every_gated_slice(tmp_path: Path):
    off = _arm_items() + [_arm_item("it-drafted-001", "it", "table_split", report_only_reason="native_review_pending")]
    on = _arm_items() + [_arm_item("it-drafted-001", "it", "table_split", hit=False, report_only_reason="native_review_pending")]
    runs = _all_arms(table_header_repeat=(off, on))
    spec, runs_path = _arm_world(tmp_path, runs)
    manifest = json.loads(runs_path.read_text(encoding="utf-8"))
    for side in ("off", "on"):
        report = Path(manifest["table_header_repeat"][side])
        payload = json.loads(report.read_text(encoding="utf-8"))
        payload["run_id"] = f"run-{side}-0001"
        report.write_text(json.dumps(payload), encoding="utf-8")
    out = tmp_path / "out"
    assert main(["--spec", str(spec), "--runs", str(runs_path), "--out", str(out)]) == 0
    arm = _arm(json.loads((out / "comparison.json").read_text(encoding="utf-8")), "table_header_repeat")
    assert arm.get("runs") == {"off": "run-off-0001", "on": "run-on-0001"}
    gated = {(row["slice"], row["metric"]): row for row in arm.get("gated_rows", [])}
    assert {"overall", "language:en", "language:zh", "language:it", "category:table_split", "pair:en->it"} <= {key[0] for key in gated}
    assert not any(key[0] == "category:table" for key in gated), "category:table is not a gated slice"
    split = gated[("category:table_split", "recall_at_10")]
    assert split["n"] == 3 and split["paired"]["mean_d"] == 0.0, "the report-only item stays out of the counting rows"
    judged = next(row for row in arm["rows"] if row["slice"] == "category:table_split" and row["metric"] == "recall_at_10")
    assert judged["n"] == 4
