import json
import subprocess
import sys
from pathlib import Path

import pytest
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