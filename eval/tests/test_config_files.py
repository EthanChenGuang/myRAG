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

from rag_eval.config_files import CONFIG_TARGETS, REPO_ROOT, finalize_config, init_configs, write_config_atomically

PYTHON = sys.executable


def test_init_writes_four_valid_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(REPO_ROOT)
    assert init_configs() == 0
    for rel, model_cls, _factory in CONFIG_TARGETS:
        path = REPO_ROOT / rel
        assert path.is_file()
        payload = json.loads(path.read_text(encoding="utf-8"))
        model_cls.model_validate(payload)
        assert payload["provenance"]["source"] == "defaults"
        assert payload["config_hash"] is not None
        assert len(payload["config_hash"]) == 64


def test_init_is_idempotent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(REPO_ROOT)
    assert init_configs() == 0
    before = {(rel, (REPO_ROOT / rel).read_bytes()) for rel, _model, _factory in CONFIG_TARGETS}
    assert init_configs() == 0
    after = {(rel, (REPO_ROOT / rel).read_bytes()) for rel, _model, _factory in CONFIG_TARGETS}
    assert before == after


def test_init_refuses_to_overwrite_sweep_provenance(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(REPO_ROOT)
    path = REPO_ROOT / "eval/config/retrieval-params.json"
    backup = path.read_bytes() if path.is_file() else None
    swept = finalize_config(RetrievalParams(), provenance_source="sweep")
    write_config_atomically(path, swept)
    original = path.read_bytes()
    assert init_configs() != 0
    assert path.read_bytes() == original
    if backup is not None:
        path.write_bytes(backup)
    else:
        path.unlink(missing_ok=True)


def test_retrieval_params_default_content():
    model = finalize_config(RetrievalParams())
    data = model.model_dump(mode="json")
    assert data["rerank_input_cap"] == 75
    assert data["provenance"]["source"] == "defaults"


def test_refusal_calibration_default_target():
    model = finalize_config(RefusalCalibrationConfig())
    assert model.target_false_refusal == 0.05


def test_module_entrypoint():
    init_configs()
    result = subprocess.run(
        [PYTHON, "-m", "rag_eval.config_files", "init"],
        cwd=REPO_ROOT,
        env={**dict(__import__("os").environ), "PYTHONPATH": f"{REPO_ROOT}/eval/src:{REPO_ROOT}/rag-sidecar/src"},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr