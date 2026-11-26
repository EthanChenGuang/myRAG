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
    constrained = text.split("export const RUN_CONFIG_CONSTRAINED_VALUES", 1)[1].split("};", 1)[0]
    return set(re.findall(r"'([A-Z0-9_]+)'", block)) | set(re.findall(r"^\s+([A-Z0-9_]+):", constrained, re.MULTILINE))


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


# ---------- gates on synthetic reports

from rag_sidecar.contracts.baseline import NoiseConfig  # noqa: E402
from rag_sidecar.contracts.eval_run import RagTrace, TraceCandidate, TraceIdentifier, TraceKeptChunk  # noqa: E402
from rag_sidecar.contracts.golden import GoldenItem  # noqa: E402
from test_report_runner import QUOTE, _manifest, _trace  # noqa: E402

from rag_eval import phase42_gate  # noqa: E402
from rag_eval.calibrate.refusal import CalibrationResult  # noqa: E402
from rag_eval.golden_io import write_golden  # noqa: E402
from rag_eval.harness_runner import HarnessError  # noqa: E402
from rag_eval.metrics import score_items  # noqa: E402
from rag_eval.phase42_gate import (  # noqa: E402
    descriptive_ids,
    diversity_gate,
    dictionary_gate,
    identifier_gate,
    main,
    off_identity_gate,
    refusal_cell_rule,
    run_phase42_gates,
    stem_rule,
    table_gate,
    versions_gate,
)
from rag_eval.phase_compare import RunOutput  # noqa: E402
from rag_eval.profile_compare import baseline_from_report  # noqa: E402
from rag_eval.report import build_report  # noqa: E402

NOISE = NoiseConfig.model_validate_json((REPO_ROOT / "eval" / "config" / "noise.json").read_text(encoding="utf-8"))
CALIBRATION = REPO_ROOT / "eval" / "reports" / "refusal-calibration-fixture" / "refusal-calibration-result.json"
SECOND = "the second passage names one more neutral fact"
EARLIER = "the earlier version described another neutral rule"
ASKED = "ab12"
NEAR = "ab13"


def _g(item_id, language, *, category="general", spans=None, groups=None, tags=(), answerable=True):
    spans = spans if spans is not None else [(f"doc.{language}.md", QUOTE)]
    return GoldenItem(
        id=item_id,
        question="question",
        language=language,
        category=category if answerable else "no_answer",
        answerable=answerable,
        expected_answer="answer" if answerable else None,
        gold_evidence=[{"document": doc, "section": "s", "quote": quote} for doc, quote in spans] if answerable else [],
        review_status="approved",
        provenance="synthetic_fixture",
        split="dev",
        tags=list(tags),
        evidence_groups=groups,
    )


GOLDEN = [
    _g("en-general-001", "en"),
    _g("it-general-001", "it"),
    _g("zh-general-001", "zh"),
    _g("en-flood-001", "en", category="duplicate_flood", spans=[("flood.en.md", QUOTE), ("single.en.md", SECOND)], groups=[[0], [1]]),
    _g("en-ident-001", "en", category="identifier_near_miss", tags=["asked_identifier:AB-12"]),
    _g("en-table-001", "en", category="table", tags=["feature:table_lookup"]),
    _g("en-version-001", "en", spans=[("version.en.md", QUOTE), ("version.en.md", EARLIER)], groups=[[0], [1]], tags=["feature:versions"]),
    _g("en-no_answer-001", "en", answerable=False),
]
BY_ID = {item.id: item for item in GOLDEN}


def _chunk(item_id, rank, doc, quote, **fields):
    return TraceKeptChunk(
        rank=rank,
        chunk_id=f"{item_id}-c{rank}",
        document_id=f"d-{doc}",
        document_name=doc,
        content=f"intro {quote} outro",
        similarity=0.5,
        kept_by="similarity",
        **fields,
    )


def _default_kept(item):
    if item.id == "en-flood-001":
        return [_chunk(item.id, 1, "flood.en.md", QUOTE, dup_cluster_id="k1"), _chunk(item.id, 2, "single.en.md", SECOND)]
    if item.id == "en-ident-001":
        return [_chunk(item.id, 1, "doc.en.md", QUOTE, identifiers_norm=[ASKED])]
    if item.id == "en-version-001":
        return [
            _chunk(item.id, 1, "version.en.md", QUOTE, is_current=True, document_version=2),
            _chunk(item.id, 2, "version.en.md", EARLIER, is_current=False, document_version=1),
        ]
    return [_chunk(item.id, 1, span.document, span.quote) for span in item.gold_evidence[:1]]


def _table_candidates(legs):
    return [
        TraceCandidate(
            rank=1, chunk_id="en-table-001-c1", document_id="d-doc.en.md", document_name="doc.en.md",
            content=f"intro {QUOTE} outro", similarity=0.5, has_image=False, legs=legs,
        )
    ]


def _output(kept=None, misses=(), candidates=None, identifier=None, refused=("en-no_answer-001",)) -> RunOutput:
    traces: list[RagTrace] = []
    for item in GOLDEN:
        if item.id in refused:
            trace = _trace(item.id, [], refused=True)
        else:
            chunks = (kept or {}).get(item.id)
            if chunks is None:
                chunks = [_chunk(item.id, 1, "other.md", "unrelated text")] if item.id in misses else _default_kept(item)
            trace = _trace(item.id, []).model_copy(update={"kept": chunks})
        update = {"candidates": (candidates or {}).get(item.id, _table_candidates({"table:0": 1}) if item.id == "en-table-001" else [])}
        if identifier is not None:
            update["identifier"] = identifier.get(item.id, TraceIdentifier(asked=0, resolved=0))
        traces.append(trace.model_copy(update=update))
    report = build_report(_manifest(), score_items(traces, GOLDEN), GOLDEN)
    return RunOutput(report=report, traces=traces, golden=list(GOLDEN))


def _ident():
    return {"en-ident-001": TraceIdentifier(asked=1, resolved=1)}


def _reference_version():
    return {"en-version-001": [_chunk("en-version-001", 1, "version.en.md", QUOTE, is_current=True, document_version=2)]}


# ---------- off identity (D-37)


def test_off_identity_passes_with_zero_paired_differences_and_names_the_moved_cell():
    spec = _spec()
    gate = spec.gates.off_identity
    base = _output()
    baselines = {"prechunked": baseline_from_report(base.report, tag="b"), "ingest": baseline_from_report(base.report, tag="b")}
    modes = {run.name: run.fixture_mode for run in spec.runs}
    outputs = {name: _output() for name in runs_for(spec, "off_identity")}
    ok = off_identity_gate(gate, outputs, modes, baselines, NOISE)
    assert ok.passed is True and ok.decision == "D-37"
    outputs["off-ingest"] = _output(misses=("zh-general-001",))
    moved = off_identity_gate(gate, outputs, modes, baselines, NOISE)
    assert moved.passed is False
    assert any(line.startswith("off-ingest vs ingest baseline") and "language:zh" in line for line in moved.offenders)
    outputs["off-ingest"] = _output()
    outputs["v2-default-phase42-off"] = _output(misses=("it-general-001",))
    pair = off_identity_gate(gate, outputs, modes, baselines, NOISE)
    assert pair.passed is False
    assert all(line.startswith("v2-default-phase42-off vs v2-default") for line in pair.offenders)


# ---------- diversity (D-22)


def _diversity_outputs(**runs):
    outputs = {"v2-default": _output(), "v2-diversity-collapse": _output(), "v2-diversity-mmr": _output()}
    outputs.update(runs)
    return outputs


def test_diversity_collapse_passes_and_fails_on_an_item_above_one_chunk_per_cluster():
    gate = _spec().gates.diversity
    ok = diversity_gate(gate, _diversity_outputs(), NOISE)
    assert ok.passed is True, ok.offenders
    assert ok.numbers["v2-diversity-collapse.intent_coverage"] == 1.0
    flooded = [
        _chunk("en-flood-001", 1, "flood.en.md", QUOTE, dup_cluster_id="k1"),
        _chunk("en-flood-001", 2, "flood.en.md", QUOTE, dup_cluster_id="k1"),
        _chunk("en-flood-001", 3, "single.en.md", SECOND),
    ]
    result = diversity_gate(gate, _diversity_outputs(**{"v2-diversity-collapse": _output(kept={"en-flood-001": flooded})}), NOISE)
    assert result.passed is False
    assert result.offenders == ["v2-diversity-collapse: en-flood-001 topk_redundancy 0.6667 > 1/3 = 0.3333"]


def test_diversity_mmr_fails_when_one_intent_has_no_kept_chunk():
    gate = _spec().gates.diversity
    only_a = [_chunk("en-flood-001", 1, "flood.en.md", QUOTE, dup_cluster_id="k1")]
    result = diversity_gate(gate, _diversity_outputs(**{"v2-diversity-mmr": _output(kept={"en-flood-001": only_a})}), NOISE)
    assert result.passed is False
    assert result.offenders[0] == "v2-diversity-mmr: category:duplicate_flood intent_coverage 0.0000 < 1.0000"
    assert not any("topk_redundancy" in line or "duplicate_flood:" in line for line in result.offenders)


def test_diversity_fails_when_another_slice_drops_against_the_default_run():
    gate = _spec().gates.diversity
    result = diversity_gate(gate, _diversity_outputs(**{"v2-diversity-collapse": _output(misses=("zh-general-001",))}), NOISE)
    assert result.passed is False
    assert any("v2-diversity-collapse: language:zh:recall_at_10 dropped" in line for line in result.offenders)
    assert not any("duplicate_flood" in line for line in result.offenders)


# ---------- identifier (D-32)


def _identifier_outputs(on=None, reference=None):
    return {"v2-identifier-on": on or _output(identifier=_ident()), "v2-default": reference or _output()}


def test_descriptive_slice_is_the_items_with_zero_asked_identifiers_in_the_identifier_run():
    assert descriptive_ids(_output(identifier=_ident()), 0) == sorted(i.id for i in GOLDEN if i.id != "en-ident-001")
    assert descriptive_ids(_output(), 0) == []


def test_identifier_gate_passes_and_fails_on_near_miss_leakage():
    gate = _spec().gates.identifier
    ok = identifier_gate(gate, _identifier_outputs(), NOISE)
    assert ok.passed is True, ok.offenders
    assert (ok.numbers["identifier_precision"], ok.numbers["near_miss_leakage"]) == (1.0, 0.0)
    leaking = [_chunk("en-ident-001", 1, "doc.en.md", QUOTE, identifiers_norm=[ASKED]), _chunk("en-ident-001", 2, "doc.en.md", "x", identifiers_norm=[NEAR])]
    result = identifier_gate(gate, _identifier_outputs(on=_output(kept={"en-ident-001": leaking}, identifier=_ident())), NOISE)
    assert result.passed is False
    assert "category:identifier_near_miss near_miss_leakage 1.0000 > 0.0000" in result.offenders
    assert "category:identifier_near_miss identifier_precision 0.0000 < 1.0000" in result.offenders


def test_identifier_gate_fails_when_precision_is_not_measured_on_every_item():
    gate = _spec().gates.identifier
    unmeasured = [_chunk("en-ident-001", 1, "doc.en.md", QUOTE)]
    result = identifier_gate(gate, _identifier_outputs(on=_output(kept={"en-ident-001": unmeasured}, identifier=_ident())), NOISE)
    assert result.passed is False
    assert "category:identifier_near_miss identifier_precision not measured" in result.offenders


def test_identifier_gate_fails_when_the_descriptive_slice_drops():
    gate = _spec().gates.identifier
    on = _output(misses=("it-general-001",), identifier=_ident())
    result = identifier_gate(gate, _identifier_outputs(on=on), NOISE)
    assert result.passed is False
    assert any(line.startswith("descriptive:recall_at_10 dropped") for line in result.offenders)
    no_block = identifier_gate(gate, _identifier_outputs(on=_output()), NOISE)
    assert "descriptive slice has 0 item(s), fewer than 1" in no_block.offenders


# ---------- table (ROADMAP criterion 3)


def test_table_gate_passes_and_fails_when_the_gold_candidate_has_no_table_list():
    gate = _spec().gates.table
    ok = table_gate(gate, {"v2-table-lookup-on": _output(), "v2-default": _output()}, NOISE)
    assert ok.passed is True, ok.offenders
    assert ok.numbers == {"items": 1, "items_with_leg": 1}
    no_leg = _output(candidates={"en-table-001": _table_candidates({"lexical:0": 1})})
    result = table_gate(gate, {"v2-table-lookup-on": no_leg, "v2-default": _output()}, NOISE)
    assert result.offenders == ["en-table-001: no gold candidate carries the table:0 list"]
    missed = table_gate(gate, {"v2-table-lookup-on": _output(misses=("en-table-001",)), "v2-default": _output()}, NOISE)
    assert "en-table-001: a gold unit has no kept chunk" in missed.offenders


# ---------- versions (ROADMAP criterion 5)


def test_versions_gate_passes_and_fails_on_an_unlabelled_superseded_chunk():
    gate = _spec().gates.versions
    reference = _output(kept=_reference_version())
    ok = versions_gate(gate, {"v2-version-scope-on": _output(), "v2-default": reference}, NOISE)
    assert ok.passed is True, ok.offenders
    assert ok.numbers == {"items": 1, "superseded_kept": 1}
    unlabelled = [
        _chunk("en-version-001", 1, "version.en.md", QUOTE, is_current=True, document_version=2),
        _chunk("en-version-001", 2, "version.en.md", EARLIER, is_current=False),
    ]
    result = versions_gate(gate, {"v2-version-scope-on": _output(kept={"en-version-001": unlabelled}), "v2-default": reference}, NOISE)
    assert result.offenders == ["en-version-001: superseded chunk en-version-001-c2 has no document_version"]


def test_versions_gate_fails_when_the_off_run_keeps_a_superseded_chunk():
    gate = _spec().gates.versions
    result = versions_gate(gate, {"v2-version-scope-on": _output(), "v2-default": _output()}, NOISE)
    assert result.offenders == ["en-version-001: v2-default keeps superseded chunk en-version-001-c2"]


# ---------- dictionary


def test_dictionary_gate_passes_without_a_drop_and_fails_on_one():
    gate = _spec().gates.dictionary
    assert dictionary_gate(gate, {"v2-lexical-dict-on": _output(), "v2-default": _output()}, NOISE).passed is True
    result = dictionary_gate(gate, {"v2-lexical-dict-on": _output(misses=("en-general-001",)), "v2-default": _output()}, NOISE)
    assert result.passed is False
    assert any(line.startswith("category:general:recall_at_10 dropped") for line in result.offenders)


# ---------- stemming rule (D-10)


def test_stemming_rule_flips_on_an_it_gain_beyond_the_band_without_a_drop():
    rule = _spec().rules.stem_it
    result = stem_rule(rule, {"v2-lexical-stem-it-on": _output(), "v2-default": _output(misses=("it-general-001",))}, NOISE)
    assert result.outcome == "flip", result.reasons
    assert result.numbers["gain"] == 1.0 and result.numbers["band"] == NOISE.floor


def test_stemming_rule_keeps_off_without_a_gain_or_with_a_drop():
    rule = _spec().rules.stem_it
    flat = stem_rule(rule, {"v2-lexical-stem-it-on": _output(), "v2-default": _output()}, NOISE)
    assert flat.outcome == "keep_off"
    assert flat.reasons == [f"language:it recall_at_10 gain 0.0000 does not exceed the noise band {NOISE.floor:.4f}"]
    dropped = stem_rule(
        rule, {"v2-lexical-stem-it-on": _output(misses=("zh-general-001",)), "v2-default": _output(misses=("it-general-001",))}, NOISE
    )
    assert dropped.outcome == "keep_off"
    assert any("language:zh:recall_at_10 dropped" in reason for reason in dropped.reasons)


# ---------- refusal-cell rule (D-23, D-24)


def _calibration(**changes) -> CalibrationResult:
    result = CalibrationResult.model_validate_json(CALIBRATION.read_text(encoding="utf-8"))
    cells = []
    for record in result.cells:
        key = record.cell.key
        if key.split("|")[3] == "cross":
            cells.append(record)
            continue
        update = changes.get(key)
        if update is None and record.cell.status == "failed_holdout":
            update = {"status": "calibrated"}
        cells.append(record.model_copy(update={"cell": record.cell.model_copy(update=update)}) if update else record)
    return result.model_copy(update={"cells": cells})


def test_refusal_cell_rule_commits_when_every_mode_cell_is_calibrated_and_strict_is_not_below_base():
    rule = _spec().rules.refusal_mode_cells
    result = refusal_cell_rule(rule, _calibration())
    assert result.outcome == "commit", result.reasons
    assert result.numbers == {"mode_cells_evaluated": 9, "bases_skipped_insufficient_data": 3}


def test_refusal_cell_rule_keeps_on_a_failed_holdout_or_a_strict_threshold_below_base():
    rule = _spec().rules.refusal_mode_cells
    committed = refusal_cell_rule(rule, CalibrationResult.model_validate_json(CALIBRATION.read_text(encoding="utf-8")))
    assert committed.outcome == "keep"
    assert "cohere|fake-quality-v1|it|same|balanced: holdout check not passed (failed_holdout)" in committed.reasons
    low = _calibration(**{"cohere|fake-quality-v1|en|same|strict": {"threshold": 0.01}})
    below = refusal_cell_rule(rule, low)
    assert below.outcome == "keep"
    assert below.reasons == ["cohere|fake-quality-v1|en|same|strict: threshold 0.0100 below the base cell's 0.1362"]


# ---------- the command


def _spec_with(tmp_path):
    base = _output()
    baseline_path = tmp_path / "baseline.json"
    baseline_path.write_text(baseline_from_report(base.report, tag="b").model_dump_json(), encoding="utf-8")
    spec = _spec()
    path = tmp_path / "spec.json"
    payload = json.loads(spec.model_dump_json())
    payload["baselines"] = {"prechunked": str(baseline_path), "ingest": str(baseline_path)}
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _passing_world():
    world = {name: _output() for name in ("off-prechunked", "off-ingest", "v2-default-phase42-off", "v2-diversity-collapse", "v2-diversity-mmr", "v2-table-lookup-on", "v2-lexical-dict-on", "v2-lexical-stem-it-on", "v2-version-scope-on")}
    world["v2-default"] = _output(kept=_reference_version())
    world["v2-default-phase42-off"] = _output(kept=_reference_version())
    world["v2-identifier-on"] = _output(identifier=_ident())
    return world


def _fake(world, seen):
    def runner(request):
        seen.append(request.name)
        return world[request.name]

    return runner


def test_every_gate_passes_writes_gates_json_and_readme_and_records_both_decisions(tmp_path):
    seen: list[str] = []
    result = run_phase42_gates(_spec_with(tmp_path), tmp_path / "out", runner=_fake(_passing_world(), seen))
    assert result.passed is True, [g.offenders for g in result.gates if not g.passed]
    assert [g.name for g in result.gates] == list(phase42_gate.GATE_NAMES)
    assert {d.name: d.outcome for d in result.decisions} == {"stem_it": "keep_off", "refusal_mode_cells": "keep"}
    payload = json.loads((tmp_path / "out" / "gates.json").read_text(encoding="utf-8"))
    assert {g["name"]: g["decision"] for g in payload["gates"]}["diversity"] == "D-22"
    readme = (tmp_path / "out" / "README.md").read_text(encoding="utf-8")
    assert "### stem_it (D-10): `keep_off`" in readme and "Verdict: **PASS**" in readme
    assert len(seen) == len(set(seen)) == 11


def test_only_diversity_runs_only_the_diversity_runs(tmp_path):
    seen: list[str] = []
    result = run_phase42_gates(_spec_with(tmp_path), tmp_path / "out", runner=_fake(_passing_world(), seen), only=["diversity"])
    assert [g.name for g in result.gates] == ["diversity"] and result.decisions == []
    assert sorted(seen) == ["v2-default", "v2-diversity-collapse", "v2-diversity-mmr"]


def test_main_exit_codes(tmp_path, monkeypatch, capsys):
    spec = _spec_with(tmp_path)
    world = _passing_world()
    monkeypatch.setattr(phase42_gate, "default_runner", _fake(world, []))
    assert main(["--spec", str(spec), "--out", str(tmp_path / "a"), "--only", "dictionary"]) == 0
    world["v2-lexical-dict-on"] = _output(misses=("en-general-001",))
    assert main(["--spec", str(spec), "--out", str(tmp_path / "b"), "--only", "dictionary"]) == 1
    assert main(["--spec", str(spec), "--out", str(tmp_path / "c"), "--only", "stem_it"]) == 0
    assert main(["--spec", str(spec), "--out", str(tmp_path / "d"), "--only", "nonsense"]) == 2
    assert "unknown gate(s) nonsense" in capsys.readouterr().err

    def broken(request):
        raise HarnessError(f"run {request.name}: harness exited with exit code 1", exit_code=1)

    monkeypatch.setattr(phase42_gate, "default_runner", broken)
    assert main(["--spec", str(spec), "--out", str(tmp_path / "e"), "--only", "dictionary"]) == 3


def test_a_missing_run_config_file_is_a_usage_error_naming_the_file(tmp_path, capsys):
    path = _spec_with(tmp_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    for run in payload["runs"]:
        if run["name"] == "v2-lexical-dict-on":
            run["base"] = "eval/config/runs/v2-not-there.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    assert main(["--spec", str(path), "--out", str(tmp_path / "o"), "--only", "dictionary"]) == 2
    assert "eval/config/runs/v2-not-there.json" in capsys.readouterr().err


def test_reuse_reads_finished_runs_instead_of_running_the_harness(tmp_path, monkeypatch):
    golden_path = tmp_path / "golden.jsonl"
    write_golden(golden_path, GOLDEN)
    reuse = tmp_path / "previous"
    for name, output in {"v2-lexical-dict-on": _output(), "v2-default": _output()}.items():
        directory = reuse / "harness" / name
        directory.mkdir(parents=True)
        (directory / "report.json").write_text(output.report.model_dump_json(), encoding="utf-8")
        (directory / "traces.jsonl").write_text("".join(t.model_dump_json() + "\n" for t in output.traces), encoding="utf-8")
        (directory / "run.json").write_text(_manifest().model_copy(update={"golden_path": str(golden_path)}).model_dump_json(), encoding="utf-8")

    def never(request):
        raise AssertionError(f"harness ran for {request.name}")

    monkeypatch.setattr(phase42_gate, "default_runner", never)
    spec = _spec_with(tmp_path)
    assert main(["--spec", str(spec), "--out", str(tmp_path / "o"), "--only", "dictionary", "--reuse", str(reuse)]) == 0
    assert main(["--spec", str(spec), "--out", str(tmp_path / "p"), "--only", "table", "--reuse", str(reuse)]) == 2
