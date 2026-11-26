"""Phase 5.3 Pitfall 3: every committed file that has a contract validates unchanged after additive contract fields."""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.export_schemas import CONTRACTS

from rag_eval.config_files import CONFIG_TARGETS, REPO_ROOT

FIXED_FILES: list[tuple[str, type[BaseModel]]] = [
    (rel, model)
    for rel, model in [
        *((rel, model) for rel, model, _factory in CONFIG_TARGETS),
        ("eval/config/gate-population.json", GatePopulationConfig),
        ("eval/config/noise.json", NoiseConfig),
        ("eval/config/latency-budgets.json", LatencyBudgets),
    ]
    if (REPO_ROOT / rel).is_file()
]


def _baselines() -> list[str]:
    root = REPO_ROOT / "eval" / "baselines"
    return sorted(str(path.relative_to(REPO_ROOT)) for path in root.rglob("*.json"))


@pytest.mark.parametrize(("rel", "model_cls"), FIXED_FILES, ids=[rel for rel, _ in FIXED_FILES])
def test_committed_config_file_validates(rel: str, model_cls: type[BaseModel]):
    model_cls.model_validate_json((REPO_ROOT / rel).read_bytes())


@pytest.mark.parametrize("rel", _baselines())
def test_committed_baseline_validates(rel: str):
    Baseline.model_validate_json((REPO_ROOT / rel).read_bytes())


def test_committed_contract_samples_validate():
    by_name = {model.__name__: model for model, _mode in CONTRACTS}
    data = json.loads((REPO_ROOT / "tests" / "fixtures" / "contracts" / "samples.json").read_text(encoding="utf-8"))
    entries = [*data["samples"].items()]
    entries += [(variant["model"], variant["value"]) for variant in data["variants"].values()]
    assert entries
    for name, payload in entries:
        model = by_name.get(name)
        assert model is not None, f"sample {name} has no registered contract"
        model.model_validate(payload)


def test_files_found():
    assert len(FIXED_FILES) >= 6
    assert len(_baselines()) >= 3
    assert all(Path(REPO_ROOT / rel).is_file() for rel in _baselines())


@pytest.mark.parametrize("rel", [rel for rel in _baselines() if "/history/" not in rel])
def test_committed_baseline_dumps_back_unchanged(rel: str):
    raw = json.loads((REPO_ROOT / rel).read_text(encoding="utf-8"))
    assert Baseline.model_validate(raw).model_dump(mode="json") == raw
