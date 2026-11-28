"""Plan 04.4-22 (D-57, T-04.4-65): the tenant rerank statistics spec is pre-registered, pinned by hash, and shares the noise bands, the
slice rule, the budgets and the baselines of the pinned Phase 4.4 spec; the new gate kinds are checked on synthetic inputs."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig

from rag_eval.phase44_gate import (
    LocalStatsGateSpec,
    PoolIndependenceGate,
    RefusalGate,
    RunPair,
    check_local_stats_arms,
    is_local_stats_spec,
    local_stats_run_config,
    pool_independence_gate,
    refusal_rate_gate,
    rerank_inversions,
)
from rag_eval.phase_compare import ComparisonError

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC = REPO_ROOT / "eval" / "config" / "phase44-local-rerank-stats-comparison.json"
PINNED_44 = REPO_ROOT / "eval" / "config" / "phase44-comparison.json"
SPEC_SHA256 = "37054fc730f9a5a943a0c54841af356440cee8e8060f758f8e60450792fe6b2e"
PINNED_44_SHA256 = "2a613e1eaa344bd5304e7fad0573f70832915fb2ddb33512691e2f18e4624f88"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_both_specs_are_pinned():
    assert hashlib.sha256(SPEC.read_bytes()).hexdigest() == SPEC_SHA256
    assert hashlib.sha256(PINNED_44.read_bytes()).hexdigest() == PINNED_44_SHA256


def test_bands_slice_rule_budgets_and_baselines_equal_the_pinned_44_spec():
    spec, pinned = _load(SPEC), _load(PINNED_44)
    for key in ("noise", "no_slice_drop_rule", "budgets"):
        assert spec[key] == pinned[key], key
    assert spec["no_slice_drop_rule"] == {"version": 2, "min_gate_n": 10}
    assert {k: spec["baselines"][k] for k in ("prechunked", "ingest")} == pinned["baselines"]
    assert spec["baselines"]["voice"] == "eval/baselines/fixture-voice-baseline.json"
    assert spec["commands"]["characterization"][: len(pinned["commands"]["characterization"])] == pinned["commands"]["characterization"]


def test_the_spec_validates_and_every_arm_serves_its_switch_value():
    spec = LocalStatsGateSpec.model_validate_json(SPEC.read_text(encoding="utf-8"))
    assert is_local_stats_spec(SPEC) and not is_local_stats_spec(PINNED_44)
    configs = {run.name: local_stats_run_config(spec, run) for run in spec.runs}
    check_local_stats_arms(spec, configs)
    assert configs["voice-tenant-prechunked"]["entry_profile"] == "voice"
    assert configs["off-prechunked"] == {"name": "off-prechunked", "env": {"RAG_RERANK_LOCAL_STATS": "pool"}, "overrides": None}
    for name, config in configs.items():
        assert config["env"]["RAG_RERANK_LOCAL_STATS"] == ("tenant" if "-tenant-" in name else "pool"), name
    g = spec.gates
    assert [p.run for p in g.no_slice_drop.pairs] == [p.run for p in g.refusal.pairs]
    assert g.pool_independence.max_inversions == 0 and g.pool_independence.min_compared_pairs == 1
    assert any("Outcome rule, fixed in advance" in note for note in spec.notes)


def test_a_mislabelled_arm_or_a_pair_that_differs_beyond_the_switch_is_refused():
    raw = _load(SPEC)
    swapped = json.loads(json.dumps(raw))
    swapped["gates"]["no_slice_drop"]["pairs"][0] = {"run": "v2-default-pool-prechunked", "reference": "v2-default-tenant-prechunked"}
    with pytest.raises(ValidationError, match="tenant arm against a pool arm"):
        LocalStatsGateSpec.model_validate(swapped)
    other = json.loads(json.dumps(raw))
    for run in other["runs"]:
        if run["name"] == "v2-default-tenant-prechunked":
            run["env"] = {"RAG_RERANKER": "none"}
    with pytest.raises(ValidationError, match="must differ only in"):
        LocalStatsGateSpec.model_validate(other)
    spec = LocalStatsGateSpec.model_validate(raw)
    configs = {run.name: local_stats_run_config(spec, run) for run in spec.runs}
    configs["v2-default-tenant-prechunked"]["env"]["RAG_RERANK_LOCAL_STATS"] = "pool"
    with pytest.raises(ComparisonError, match="tenant arm"):
        check_local_stats_arms(spec, configs)


def test_rerank_inversions_count_strict_flips_and_skip_ties():
    a = {"i1": {"x": 0.9, "y": 0.5, "z": 0.5, "w": 0.1}, "i2": {"p": 1.0}}
    same = {"i1": {"x": 0.8, "y": 0.4, "z": 0.2, "v": 1.0}, "i2": {"p": 0.3}}
    assert rerank_inversions(a, same) == {"items": 1, "pairs": 2, "inversions": 0, "offending_items": []}
    flipped = {"i1": {"x": 0.1, "y": 0.4, "z": 0.2}}
    assert rerank_inversions(a, flipped) == {"items": 1, "pairs": 2, "inversions": 2, "offending_items": ["i1"]}


def test_pool_independence_fails_on_an_inversion_and_on_nothing_compared():
    gate = PoolIndependenceGate(decision="d", description="", pairs=[RunPair(run="a", reference="b")], min_compared_pairs=1, report_only_pairs=[RunPair(run="c", reference="d")])
    ok, extra = pool_independence_gate(gate, {"a": {"i": {"x": 1, "y": 0.5}}, "b": {"i": {"x": 0.7, "y": 0.1}}, "c": {"i": {"x": 1, "y": 0.5}}, "d": {"i": {"x": 0.1, "y": 0.5}}})
    assert ok.passed and ok.numbers["a~b.inversions"] == 0
    assert extra[0].numbers["inversions"] == 1
    bad, _ = pool_independence_gate(gate, {"a": {"i": {"x": 1, "y": 0.5}}, "b": {"i": {"x": 0.1, "y": 0.5}}, "c": {}, "d": {}})
    assert not bad.passed
    empty, _ = pool_independence_gate(gate, {"a": {}, "b": {}, "c": {}, "d": {}})
    assert not empty.passed and "not measured" in empty.offenders[0]


def _overall(**values):
    return SimpleNamespace(report=SimpleNamespace(overall=SimpleNamespace(**{k: (None if v is None else SimpleNamespace(value=v)) for k, v in values.items()})))


def test_refusal_rate_gate_fails_only_on_a_worsening_beyond_the_floor():
    gate = RefusalGate(decision="d", description="", pairs=[RunPair(run="t", reference="p")], metrics={"correct_refusal_rate": "higher", "false_refusal_rate": "lower", "false_answer_rate": "lower"})
    noise = NoiseConfig(floor=0.02)
    same = {"t": _overall(correct_refusal_rate=0.5, false_refusal_rate=0.1, false_answer_rate=None), "p": _overall(correct_refusal_rate=0.5, false_refusal_rate=0.1, false_answer_rate=None)}
    assert refusal_rate_gate(gate, same, noise).passed
    better = {"t": _overall(correct_refusal_rate=0.6, false_refusal_rate=0.0, false_answer_rate=0.0), "p": _overall(correct_refusal_rate=0.5, false_refusal_rate=0.1, false_answer_rate=0.1)}
    assert refusal_rate_gate(gate, better, noise).passed
    worse = {"t": _overall(correct_refusal_rate=0.4, false_refusal_rate=0.1, false_answer_rate=0.0), "p": _overall(correct_refusal_rate=0.5, false_refusal_rate=0.1, false_answer_rate=0.0)}
    assert not refusal_rate_gate(gate, worse, noise).passed
