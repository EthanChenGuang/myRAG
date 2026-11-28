"""Plan 04.4-18 (D-50, T-04.4-57): the cluster-DF gate spec is the pre-registered Phase 4.4 spec with only the run environments changed.

eval/config/phase44-comparison.json is pinned by hash. The plan named sha256 adc5a96e70a0774308879fc8dd33c9412b697683bae43f41806766412100e6e8,
the file before the owner's min_gate_n v2 registration (commit 50346847, D-37 pre-registration, which only added no_slice_drop_rule);
the pin below is the file as registered with that rule, and the rule is equal in both specs.
"""

import hashlib
import json
from pathlib import Path

from rag_eval.phase44_gate import Phase44GateSpec, _check_scoring, run_config_for

REPO_ROOT = Path(__file__).resolve().parents[2]
ORIGINAL = REPO_ROOT / "eval" / "config" / "phase44-comparison.json"
DERIVED = REPO_ROOT / "eval" / "config" / "phase44-cluster-df-comparison.json"
CLUSTER_RUN = REPO_ROOT / "eval" / "config" / "runs" / "v2-lexical-bm25-cluster-df-on.json"
BM25_RUN = REPO_ROOT / "eval" / "config" / "runs" / "v2-lexical-bm25-on.json"
ORIGINAL_SHA256 = "2a613e1eaa344bd5304e7fad0573f70832915fb2ddb33512691e2f18e4624f88"
CLUSTER_BASE = "eval/config/runs/v2-lexical-bm25-cluster-df-on.json"
BM25_RUNS = ("v2-lexical-bm25-on-prechunked", "v2-lexical-bm25-on-ingest", "v2-lexical-bm25-on-rerank-none-prechunked")
REFERENCE_RUNS = ("v2-default-prechunked", "v2-default-ingest", "v2-default-rerank-none-prechunked")
EQUAL_KEYS = ("schema_version", "phase", "noise", "no_slice_drop_rule", "budgets", "baselines", "off_env", "gates", "report_only", "commands")


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_pre_registered_spec_is_unchanged():
    assert hashlib.sha256(ORIGINAL.read_bytes()).hexdigest() == ORIGINAL_SHA256


def test_the_cluster_run_config_is_the_bm25_run_plus_the_two_switches():
    bm25, cluster = _load(BM25_RUN), _load(CLUSTER_RUN)
    assert cluster["name"] == "v2-lexical-bm25-cluster-df-on"
    assert cluster["env"] == {**bm25["env"], "RAG_DUP_CLUSTERS": "true", "RAG_LEXICAL_DF_MODE": "cluster"}
    assert cluster["overrides"] == bm25["overrides"]
    assert set(cluster) == set(bm25)


def test_every_gate_threshold_and_command_is_equal_and_only_the_run_environments_differ():
    original, derived = _load(ORIGINAL), _load(DERIVED)
    for key in EQUAL_KEYS:
        assert derived[key] == original[key], key
    assert set(derived) == set(original)
    assert [run["name"] for run in derived["runs"]] == [run["name"] for run in original["runs"]]
    assert derived["notes"][: len(original["notes"])] == original["notes"]
    added = derived["notes"][len(original["notes"]) :]
    assert len(added) == 2
    assert "pre-registered by plan 04.4-18 before any cluster-mode run was looked at" in added[1].lower()
    for before, after in zip(original["runs"], derived["runs"], strict=True):
        name = before["name"]
        assert after["fixture_mode"] == before["fixture_mode"], name
        assert after.get("phase44_off", False) == before.get("phase44_off", False), name
        if name in BM25_RUNS:
            assert after["base"] == CLUSTER_BASE, name
            assert after.get("env", {}) == before.get("env", {}), name
        elif name in REFERENCE_RUNS:
            assert after["base"] == before["base"], name
            assert after["env"] == {**before.get("env", {}), "RAG_DUP_CLUSTERS": "true"}, name
        else:
            assert after == before, name
        changed = {key for key in set(before) | set(after) if before.get(key) != after.get(key)}
        assert changed <= {"base", "env"}, name


def test_both_specs_load_and_pass_the_scoring_check():
    for path in (ORIGINAL, DERIVED):
        spec = Phase44GateSpec.model_validate_json(path.read_text(encoding="utf-8"))
        configs = {run.name: run_config_for(spec, run) for run in spec.runs}
        _check_scoring(spec, configs)


def test_the_derived_pairs_share_clusters_and_differ_only_in_scoring():
    spec = Phase44GateSpec.model_validate_json(DERIVED.read_text(encoding="utf-8"))
    configs = {run.name: run_config_for(spec, run) for run in spec.runs}
    pairs = [(pair.run, pair.reference) for pair in [*spec.gates.on.pairs, *spec.report_only]]
    assert len(pairs) == 3
    for run, reference in pairs:
        on, ref = configs[run]["env"], configs[reference]["env"]
        assert on["RAG_DUP_CLUSTERS"] == ref["RAG_DUP_CLUSTERS"] == "true"
        assert on["RAG_LEXICAL_DF_MODE"] == "cluster" and "RAG_LEXICAL_DF_MODE" not in ref
        differing = {key for key in set(on) | set(ref) if on.get(key) != ref.get(key)}
        assert differing == {"RAG_LEXICAL_SCORING", "RAG_LEXICAL_DF_MODE"}, (run, differing)
    for name in spec.gates.off_identity.runs:
        assert "RAG_LEXICAL_DF_MODE" not in configs[name]["env"] and "RAG_DUP_CLUSTERS" not in configs[name]["env"]
