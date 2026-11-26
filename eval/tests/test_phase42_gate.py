import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.retrieval import RetrievalOverrides

from rag_eval.phase42_gate import PHASE42_SWITCHES, SELECTABLE, Phase42GateSpec, run_config_for, runs_for

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "eval" / "config" / "phase42-gates.json"
RUNS_DIR = REPO_ROOT / "eval" / "config" / "runs"
RUN_CONFIG_TS = REPO_ROOT / "eval" / "harness" / "run-config.mts"
TOP_LEVEL_KEYS = {"name", "env", "overrides", "chunking_profiles"}

FEATURE_RUNS = {
    "v2-diversity-collapse": {"RAG_DUP_CLUSTERS": "true", "RAG_RESULT_DIVERSITY": "collapse"},
    "v2-diversity-mmr": {"RAG_DUP_CLUSTERS": "true", "RAG_RESULT_DIVERSITY": "mmr"},
    "v2-identifier-on": {"RAG_IDENTIFIER_INDEX": "true", "RAG_IDENTIFIER_FILTER": "true"},
    "v2-table-lookup-on": {"RAG_TABLE_LOOKUP": "true"},
    "v2-version-scope-on": {"RAG_VERSION_SCOPE": "true"},
    "v2-lexical-dict-on": {"RAG_LEXICAL_DICTIONARY": "true"},
    "v2-lexical-stem-it-on": {"RAG_LEXICAL_STEM_IT": "true"},
}


def _spec() -> Phase42GateSpec:
    assert SPEC_PATH.is_file(), f"{SPEC_PATH} is not committed"
    return Phase42GateSpec.model_validate_json(SPEC_PATH.read_text(encoding="utf-8"))


def _raw_spec() -> dict:
    assert SPEC_PATH.is_file(), f"{SPEC_PATH} is not committed"
    return json.loads(SPEC_PATH.read_text(encoding="utf-8"))


def _allowlist() -> set[str]:
    text = RUN_CONFIG_TS.read_text(encoding="utf-8")
    block = text.split("export const RUN_CONFIG_ENV_ALLOWLIST", 1)[1].split("];", 1)[0]
    return set(re.findall(r"'([A-Z0-9_]+)'", block))


# ---------- spec


def test_spec_validates_with_every_gate_and_rule_carrying_its_decision():
    spec = _spec()
    gates = spec.gates
    assert gates.off_identity.decision == "D-37"
    assert gates.diversity.decision == "D-22"
    assert gates.identifier.decision == "D-32"
    assert gates.table.decision.startswith("ROADMAP")
    assert gates.versions.decision.startswith("ROADMAP")
    assert gates.dictionary.decision
    assert spec.rules.stem_it.decision == "D-10"
    assert "D-23" in spec.rules.refusal_mode_cells.decision and "D-24" in spec.rules.refusal_mode_cells.decision
    for name in SELECTABLE:
        for run in runs_for(spec, name):
            assert run in {entry.name for entry in spec.runs}


def test_spec_writes_the_numbers_of_each_gate():
    spec = _spec()
    g = spec.gates
    assert g.diversity.runs == ["v2-diversity-collapse", "v2-diversity-mmr"]
    assert g.diversity.slice == "category:duplicate_flood"
    assert g.diversity.intent_coverage_min == 1.0
    assert g.diversity.max_chunks_per_cluster == 1
    assert g.identifier.run == "v2-identifier-on"
    assert g.identifier.slice == "category:identifier_near_miss"
    assert g.identifier.identifier_precision_min == 1.0
    assert g.identifier.near_miss_leakage_max == 0.0
    assert g.identifier.descriptive.max_asked == 0
    assert "zero asked identifiers" in g.identifier.descriptive.definition
    assert g.table.tag == "feature:table_lookup" and g.table.leg == "table:0"
    assert g.versions.tag == "feature:versions" and g.versions.min_superseded_kept >= 1
    assert g.dictionary.run == "v2-lexical-dict-on"
    for gate in (g.diversity, g.identifier, g.table, g.versions, g.dictionary):
        assert gate.reference == "v2-default"
    stem = spec.rules.stem_it
    assert (stem.run, stem.slice, stem.metric, stem.outcomes) == ("v2-lexical-stem-it-on", "language:it", "recall_at_10", ["flip", "keep_off"])
    cells = spec.rules.refusal_mode_cells
    assert cells.modes == ["strict", "balanced", "flexible"]
    assert (cells.dev_fit_status, cells.holdout_status, cells.strict_not_below_base) == ("fitted", "calibrated", True)
    assert cells.outcomes == ["commit", "keep"]


def test_spec_off_identity_covers_both_fixture_modes_with_every_switch_off():
    spec = _spec()
    by_name = {run.name: run for run in spec.runs}
    modes = {by_name[name].fixture_mode for name in spec.gates.off_identity.against_baseline}
    assert modes == {"prechunked", "ingest"}
    assert set(spec.baselines) == {"prechunked", "ingest"}
    for path in (*spec.baselines.values(), spec.noise):
        assert (REPO_ROOT / path).is_file()
    assert set(spec.phase42_off_env) == PHASE42_SWITCHES
    assert spec.phase42_off_env["RAG_RESULT_DIVERSITY"] == "off"
    assert all(value == "false" for key, value in spec.phase42_off_env.items() if key != "RAG_RESULT_DIVERSITY")
    for name in spec.gates.off_identity.against_baseline:
        config = run_config_for(spec, by_name[name])
        assert config["env"] == spec.phase42_off_env


def test_spec_names_ndcg_and_ttft_only_as_report_only():
    raw = _raw_spec()
    assert {entry["metric"] for entry in raw["report_only"]} == {"ndcg_at_context_k", "ttft"}
    gates_text = json.dumps(raw["gates"]) + json.dumps(raw["rules"])
    assert "ndcg" not in gates_text and "ttft" not in gates_text


def test_spec_rejects_an_unknown_run_and_a_reference_of_another_fixture_mode():
    raw = _raw_spec()
    unknown = json.loads(json.dumps(raw))
    unknown["gates"]["table"]["run"] = "v2-missing"
    with pytest.raises(ValidationError, match="unknown runs"):
        Phase42GateSpec.model_validate(unknown)
    moved = json.loads(json.dumps(raw))
    for run in moved["runs"]:
        if run["name"] == "v2-table-lookup-on":
            run["fixture_mode"] = "ingest"
    with pytest.raises(ValidationError, match="same fixture mode"):
        Phase42GateSpec.model_validate(moved)
    partial = json.loads(json.dumps(raw))
    partial["phase42_off_env"].pop("RAG_TABLE_LOOKUP")
    with pytest.raises(ValidationError, match="phase42_off_env"):
        Phase42GateSpec.model_validate(partial)


# ---------- run configs


@pytest.mark.parametrize("name", sorted(FEATURE_RUNS))
def test_run_config_sets_only_its_phase42_switches_on_top_of_the_phase41_default(name):
    path = RUNS_DIR / f"{name}.json"
    assert path.is_file(), f"run config {name} is not committed"
    config = json.loads(path.read_text(encoding="utf-8"))
    default = json.loads((RUNS_DIR / "v2-default.json").read_text(encoding="utf-8"))
    assert set(config) <= TOP_LEVEL_KEYS, f"rejected top-level key(s): {set(config) - TOP_LEVEL_KEYS}"
    assert config["name"] == name
    rejected = set(config["env"]) - _allowlist()
    assert not rejected, f"variables outside RUN_CONFIG_ENV_ALLOWLIST: {sorted(rejected)}"
    assert config["env"] == {**default["env"], **FEATURE_RUNS[name]}
    assert set(config["env"]) - set(default["env"]) <= PHASE42_SWITCHES
    if config.get("overrides") is not None:
        RetrievalOverrides.model_validate(config["overrides"])
    spec = _spec()
    entry = next(run for run in spec.runs if run.name == name)
    assert entry.base == f"eval/config/runs/{name}.json"


@pytest.mark.skipif(
    shutil.which("npx") is None or not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists(), reason="tsx is not installed"
)
def test_run_configs_load_through_the_typescript_run_config_loader(tmp_path):
    paths = [RUNS_DIR / f"{name}.json" for name in sorted(FEATURE_RUNS)]
    for path in paths:
        assert path.is_file(), f"run config {path.name} is not committed"
    script = tmp_path / "load.mts"
    script.write_text(
        f"import {{ loadRunConfig }} from {json.dumps(str(RUN_CONFIG_TS))};\n"
        "for (const file of process.argv.slice(2)) {\n"
        "  const config = loadRunConfig(file);\n"
        "  console.log(JSON.stringify({ name: config.name, env: config.env, overrides: config.overrides }));\n"
        "}\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        ["npx", "tsx", str(script), *map(str, paths)], cwd=REPO_ROOT, capture_output=True, text=True, check=False, timeout=180
    )
    assert result.returncode == 0, result.stderr[-2000:]
    loaded = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    assert [entry["name"] for entry in loaded] == sorted(FEATURE_RUNS)
    for entry in loaded:
        assert entry["overrides"] is None
        for key, value in FEATURE_RUNS[entry["name"]].items():
            assert entry["env"][key] == value
