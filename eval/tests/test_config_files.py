import json
import subprocess
import sys
from pathlib import Path

import pytest
from rag_sidecar.contracts.judge_calibration import JudgeCalibration
from rag_sidecar.contracts.monitor import MonitorAlertsConfig
from rag_sidecar.contracts.quality_gates import QualityGates
from rag_sidecar.contracts.release_gate import ReleaseGateConfig
from rag_sidecar.contracts.retrieval import (
    ChunkingSweepReport,
    RefusalCalibrationConfig,
    RefusalThresholds,
    RetrievalParams,
)

import rag_eval.config_files as config_files_module
from rag_eval.config_files import CONFIG_TARGETS, REPO_ROOT, finalize_config, init_configs, write_config_atomically

PYTHON = sys.executable


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """init_configs writes under a temporary repo root, never over the committed files."""
    monkeypatch.setattr(config_files_module, "REPO_ROOT", tmp_path)
    return tmp_path


def test_init_writes_four_valid_files(root: Path):
    assert init_configs() == 0
    for rel, model_cls, _factory in CONFIG_TARGETS:
        path = root / rel
        assert path.is_file()
        payload = json.loads(path.read_text(encoding="utf-8"))
        model_cls.model_validate(payload)
        assert payload["provenance"]["source"] == "defaults"
        assert payload["config_hash"] is not None
        assert len(payload["config_hash"]) == 64


def test_init_is_idempotent(root: Path):
    assert init_configs() == 0
    before = {(rel, (root / rel).read_bytes()) for rel, _model, _factory in CONFIG_TARGETS}
    assert init_configs() == 0
    after = {(rel, (root / rel).read_bytes()) for rel, _model, _factory in CONFIG_TARGETS}
    assert before == after


def test_init_refuses_to_overwrite_sweep_provenance(root: Path):
    path = root / "eval/config/retrieval-params.json"
    swept = finalize_config(RetrievalParams(), provenance_source="sweep")
    write_config_atomically(path, swept)
    original = path.read_bytes()
    assert init_configs() != 0
    assert path.read_bytes() == original


def test_init_refuses_to_overwrite_the_committed_calibrated_thresholds(root: Path):
    committed = REPO_ROOT / "eval/config/refusal-thresholds.json"
    target = root / "eval/config/refusal-thresholds.json"
    target.parent.mkdir(parents=True)
    target.write_bytes(committed.read_bytes())
    assert RefusalThresholds.model_validate_json(committed.read_text(encoding="utf-8")).provenance.source == "calibration"
    assert init_configs() != 0
    assert target.read_bytes() == committed.read_bytes()


def test_retrieval_params_default_content():
    model = finalize_config(RetrievalParams())
    data = model.model_dump(mode="json")
    assert data["rerank_input_cap"] == 75
    assert data["provenance"]["source"] == "defaults"


def test_refusal_calibration_default_target():
    model = finalize_config(RefusalCalibrationConfig())
    assert model.target_false_refusal == 0.05


def test_module_entrypoint_refuses_the_committed_calibrated_files():
    before = {rel: (REPO_ROOT / rel).read_bytes() for rel, _model, _factory in CONFIG_TARGETS if (REPO_ROOT / rel).is_file()}
    result = subprocess.run(
        [PYTHON, "-m", "rag_eval.config_files", "init"],
        cwd=REPO_ROOT,
        env={**dict(__import__("os").environ), "PYTHONPATH": f"{REPO_ROOT}/eval/src:{REPO_ROOT}/rag-sidecar/src"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1, result.stderr
    assert "refusing to overwrite" in result.stderr
    after = {rel: (REPO_ROOT / rel).read_bytes() for rel in before}
    assert before == after

QUERY_PARAMS_REL = "eval/config/query-params.json"


def test_config_targets_include_query_params():
    assert QUERY_PARAMS_REL in [rel for rel, _model, _factory in CONFIG_TARGETS]


def test_init_writes_query_params_with_sorted_keys_and_d08_defaults(root: Path):
    assert init_configs() == 0
    path = root / QUERY_PARAMS_REL
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    payload = json.loads(text)
    assert payload["schema_version"] == 1
    assert list(payload) == sorted(payload)
    assert payload["max_sub_questions"] == 4
    assert payload["max_searches"] == 8
    assert payload["query_budget_ms"] == {"chat": 1200, "embed": 1200, "voice": 300}
    first = path.read_bytes()
    assert init_configs() == 0
    assert path.read_bytes() == first


def test_committed_query_params_matches_defaults():
    path = REPO_ROOT / QUERY_PARAMS_REL
    assert path.is_file()
    model_cls = dict((rel, model) for rel, model, _factory in CONFIG_TARGETS).get(QUERY_PARAMS_REL)
    assert model_cls is not None
    committed = model_cls.model_validate_json(path.read_text(encoding="utf-8"))
    assert committed == finalize_config(model_cls())


@pytest.mark.parametrize(
    ("rel", "model_cls"),
    [
        ("eval/config/retrieval-params.json", RetrievalParams),
        ("eval/config/refusal-thresholds.json", RefusalThresholds),
        ("eval/config/refusal-calibration.json", RefusalCalibrationConfig),
        ("eval/config/quality-gates.json", QualityGates),
        ("eval/config/monitor-alerts.json", MonitorAlertsConfig),
        ("eval/config/release-gate.json", ReleaseGateConfig),
        ("eval/config/judge-calibration.json", JudgeCalibration),
    ],
)
def test_committed_config_rewrites_byte_identical_with_its_hash(tmp_path: Path, rel: str, model_cls):
    """Phase 4.2 D-46: new optional contract fields leave the committed files and their config_hash unchanged."""
    from rag_sidecar.contracts.retrieval import compute_config_hash

    source = REPO_ROOT / rel
    model = model_cls.model_validate_json(source.read_bytes())
    target = tmp_path / Path(rel).name
    write_config_atomically(target, model)
    assert target.read_bytes() == source.read_bytes()
    assert model.config_hash == compute_config_hash(model)


QUALITY_GATES_REL = "eval/config/quality-gates.json"


def test_committed_quality_gates_hold_the_d04_defaults():
    """Phase 5.3 D-02, D-04: the hand-edited gate file validates in pr-smoke and starts at the D-04 values."""
    factories = {rel: (model, factory) for rel, model, factory in CONFIG_TARGETS}
    assert QUALITY_GATES_REL in factories
    model_cls, factory = factories[QUALITY_GATES_REL]
    committed = model_cls.model_validate_json((REPO_ROOT / QUALITY_GATES_REL).read_text(encoding="utf-8"))
    assert committed == finalize_config(factory())
    assert committed.provenance.source == "defaults"
    assert committed.composition.no_answer_share_min == 0.15
    assert committed.composition.no_answer_share_target == 0.20
    assert committed.composition.excluded_categories == ["small_talk"]
    assert committed.composition.min_items_per_language == 20
    assert committed.ceilings.false_answer_rate == {"strict": 0.05, "balanced": None, "flexible": None}
    assert committed.ceilings.false_refusal_rate == {"strict": 0.25, "balanced": 0.25, "flexible": 0.25}
    assert committed.ceilings.min_n == 10
    assert committed.floors.smoke == {}
    assert committed.floors.nightly == {"faithfulness": 0.85, "answer_relevance": 0.75}
    assert committed.lifecycle.max_stale_share == 0.10
    assert committed.lifecycle.re_review_days == 90
    assert committed.judge.max_age_days == 35


PHASE53_FILES = (
    "eval/config/monitor-alerts.json",
    "eval/config/release-gate.json",
    "eval/config/judge-calibration.json",
)


@pytest.mark.parametrize("rel", PHASE53_FILES)
def test_phase53_config_files_are_targets_at_their_defaults(rel: str):
    """Phase 5.3 D-02: each file validates in pr-smoke and starts with provenance.source = defaults."""
    factories = {target: (model, factory) for target, model, factory in CONFIG_TARGETS}
    assert rel in factories
    model_cls, factory = factories[rel]
    committed = model_cls.model_validate_json((REPO_ROOT / rel).read_text(encoding="utf-8"))
    assert committed == finalize_config(factory())
    assert committed.provenance.source == "defaults"


def test_committed_monitor_alerts_hold_the_d24_and_d44_numbers():
    committed = MonitorAlertsConfig.model_validate_json(
        (REPO_ROOT / "eval/config/monitor-alerts.json").read_text(encoding="utf-8")
    )
    rules = {rule.id: rule for rule in committed.rules}
    assert len(rules) == 13
    assert "language_drop" not in rules
    rate = [rule for rule in committed.rules if rule.kind == "rate"]
    assert len(rate) == 8
    assert {(r.ratio, r.min_abs_delta, r.min_z, r.min_sample, r.baseline_min_sample) for r in rate} == {
        (2.0, 0.05, 3.0, 50, 200)
    }
    psi = rules["top_score_psi"]
    assert (psi.warn, psi.alert, psi.min_sample, psi.baseline_min_sample) == (0.10, 0.25, 300, 1000)
    assert rules["latency_p95"].ratio == 1.5
    assert rules["online_judge_mean"].drop == 0.10
    assert (committed.drift.jsd_warn, committed.drift.jsd_alert, committed.drift.gap_alert) == (0.10, 0.20, 0.15)


def test_committed_release_gate_and_empty_judge_calibration():
    release = ReleaseGateConfig.model_validate_json(
        (REPO_ROOT / "eval/config/release-gate.json").read_text(encoding="utf-8")
    )
    assert release.status_context == "rag-release-gate"
    assert release.required_parts == ["nightly_absolute", "judge_floors", "ship_check", "pr_smoke"]
    calibration = JudgeCalibration.model_validate_json(
        (REPO_ROOT / "eval/config/judge-calibration.json").read_text(encoding="utf-8")
    )
    assert calibration.cells == []
