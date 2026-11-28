"""No-slice-drop minimum sample size (owner decision 2026-11-28, option (a)): a slice with fewer than min_gate_n items is
reported as below_min_n and never decides a phase gate; larger slices keep the noise-band rule."""

import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.golden import GoldenItem
from test_report_runner import QUOTE, _manifest, _trace

from rag_eval import phase33_gate, phase42_gate, phase44_gate, phase_compare
from rag_eval.metrics import score_items
from rag_eval.phase_compare import RunOutput, category_noise_check, no_slice_drop_check, slice_drops
from rag_eval.profile_compare import baseline_from_report
from rag_eval.report import build_report

REPO_ROOT = Path(__file__).resolve().parents[2]
NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8"))
MARK = "below_min_n"
SPECS = {
    "phase42-gates.json": phase42_gate.Phase42GateSpec,
    "phase44-comparison.json": phase44_gate.Phase44GateSpec,
    "phase33-gates.json": phase33_gate.Phase33GatesSpec,
    "phase52-comparison.json": phase_compare.SwitchComparisonSpec,
}


def _item(item_id: str, category: str) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        question="question",
        language="en",
        category=category,
        answerable=True,
        expected_answer="answer",
        gold_evidence=[{"document": "doc.en.md", "section": "s", "quote": QUOTE}],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
    )


# 50 general items keep overall and language:en far above min_gate_n, so one flip stays inside the 0.02 floor there.
GOLDEN = (
    [_item(f"en-general-{i:03d}", "general") for i in range(50)]
    + [_item(f"en-table-{i:03d}", "table") for i in range(4)]
    + [_item(f"en-compound-{i:03d}", "compound") for i in range(10)]
)


def _output(misses=()) -> RunOutput:
    traces = [
        _trace(item.id, [("doc.en.md", "unrelated text" if item.id in misses else f"intro {QUOTE} outro")]) for item in GOLDEN
    ]
    report = build_report(_manifest(), score_items(traces, GOLDEN), GOLDEN)
    return RunOutput(report=report, traces=traces, golden=list(GOLDEN))


BASELINE = baseline_from_report(_output().report, tag="reference")


def _with_min(n: int) -> NoiseConfig:
    helper = getattr(phase_compare, "with_min_gate_n", None)
    assert helper is not None, "phase_compare.with_min_gate_n is missing"
    return helper(NOISE, n)


def test_a_four_item_slice_with_one_flip_is_reported_not_gated():
    gate = slice_drops(_output(misses=("en-table-000",)).report, BASELINE, NOISE)
    assert gate.passed is True
    assert gate.offenders == []
    notes = [line for line in gate.skipped if MARK in line]
    assert notes and all(line.startswith("category:table:") for line in notes)
    assert any("n=4" in line and "min_gate_n=10" in line for line in notes)


def test_a_ten_item_slice_with_one_flip_still_fails():
    gate = slice_drops(_output(misses=("en-compound-000",)).report, BASELINE, NOISE)
    assert gate.passed is False
    assert {o.slice for o in gate.offenders} == {"category:compound"}
    assert not [line for line in gate.skipped if MARK in line]


def test_min_gate_n_comes_from_the_rule_and_defaults_to_ten():
    assert getattr(phase_compare, "MIN_GATE_N", None) == 10
    moved = _output(misses=("en-table-000",)).report
    assert slice_drops(moved, BASELINE, _with_min(4)).passed is False
    assert slice_drops(moved, BASELINE, _with_min(5)).passed is True


def test_no_slice_drop_and_category_noise_checks_report_small_slices():
    moved = _output(misses=("en-table-000",))
    check = no_slice_drop_check(moved, BASELINE, NOISE)
    assert check.passed is True and any(MARK in line for line in check.detail)
    category = category_noise_check(moved, BASELINE, NOISE, exclude=[])
    assert category.passed is True and any(MARK in line for line in category.detail)
    failed = no_slice_drop_check(_output(misses=("en-compound-000",)), BASELINE, NOISE)
    assert failed.passed is False


def test_phase42_and_phase44_outcomes_keep_below_min_n_lines_out_of_the_verdict():
    on, reference = _output(misses=("en-table-000",)), _output()
    gate = phase42_gate.DictionaryGate(decision="D-09", description="d", run="on", reference="ref")
    outcome = phase42_gate.dictionary_gate(gate, {"on": on, "ref": reference}, NOISE)
    assert outcome.passed is True and outcome.offenders == []
    assert any(MARK in line for line in getattr(outcome, "below_min_n", []))
    lines = phase42_gate.drop_offenders(on, reference, NOISE, reference_name="ref")
    p44 = phase44_gate._outcome("on", "D-x", ["on", "ref"], {}, [f"on: {line}" for line in lines])
    assert p44.passed is True and p44.offenders == []
    assert any(MARK in line for line in getattr(p44, "below_min_n", []))
    gated = phase42_gate.dictionary_gate(gate, {"on": _output(misses=("en-compound-000",)), "ref": reference}, NOISE)
    assert gated.passed is False


@pytest.mark.parametrize("name", sorted(SPECS))
def test_committed_specs_register_the_rule(name):
    raw = json.loads((REPO_ROOT / "eval" / "config" / name).read_text(encoding="utf-8"))
    assert raw.get("no_slice_drop_rule") == {"version": 2, "min_gate_n": 10}
    spec = SPECS[name].model_validate(raw)
    assert getattr(getattr(spec, "no_slice_drop_rule", None), "min_gate_n", None) == 10


def test_a_spec_without_the_rule_defaults_to_ten_and_rejects_zero():
    raw = json.loads((REPO_ROOT / "eval" / "config" / "phase42-gates.json").read_text(encoding="utf-8"))
    raw.pop("no_slice_drop_rule", None)
    spec = phase42_gate.Phase42GateSpec.model_validate(raw)
    assert getattr(getattr(spec, "no_slice_drop_rule", None), "min_gate_n", None) == 10
    with pytest.raises(ValueError):
        phase42_gate.Phase42GateSpec.model_validate({**raw, "no_slice_drop_rule": {"version": 2, "min_gate_n": 0}})
