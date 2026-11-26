from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Callable, TypeVar

from pydantic import BaseModel, ValidationError
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from rag_sidecar.contracts.quality_gates import QualityGates, default_quality_gates
from rag_sidecar.contracts.query import QueryParams
from rag_sidecar.contracts.retrieval import (
    ChunkingSweepReport,
    ConfigProvenance,
    DupClusterParamsFile,
    RefusalCalibrationConfig,
    RefusalThresholds,
    RetrievalParams,
    compute_config_hash,
)

from rag_eval.paths import REPO_ROOT

T = TypeVar("T", bound=BaseModel)

CONFIG_TARGETS: list[tuple[str, type[BaseModel], Callable[[], BaseModel]]] = [
    ("eval/config/retrieval-params.json", RetrievalParams, RetrievalParams),
    ("eval/config/query-params.json", QueryParams, QueryParams),
    ("eval/config/refusal-thresholds.json", RefusalThresholds, lambda: RefusalThresholds(cells=[])),
    ("eval/config/refusal-calibration.json", RefusalCalibrationConfig, RefusalCalibrationConfig),
    (
        "eval/reports/chunking-sweep.json",
        ChunkingSweepReport,
        lambda: ChunkingSweepReport(profiles=[], provenance=ConfigProvenance(source="defaults")),
    ),
    ("eval/config/dup-cluster-params.json", DupClusterParamsFile, DupClusterParamsFile),
    ("eval/config/quality-gates.json", QualityGates, default_quality_gates),
]

PROTECTED_SOURCES = frozenset({"sweep", "calibration", "fixture", "live"})

GATE_POPULATION_REL = "eval/config/gate-population.json"
GATE_POPULATION_PATH = REPO_ROOT / GATE_POPULATION_REL


def load_gate_population(path: Path | None = None) -> tuple[GatePopulationConfig, str]:
    """D-23: the gate population switch and the sha256 of the exact bytes it was read from."""
    source = GATE_POPULATION_PATH if path is None else Path(path)
    raw = source.read_bytes()
    try:
        config = GatePopulationConfig.model_validate_json(raw)
    except ValidationError as exc:
        raise ValueError(f"{source}: not a valid GatePopulationConfig: {exc}") from exc
    return config, hashlib.sha256(raw).hexdigest()


def write_gate_population(config: GatePopulationConfig, path: Path | None = None) -> None:
    write_config_atomically(GATE_POPULATION_PATH if path is None else Path(path), config)


def finalize_config(model: T, *, provenance_source: str = "defaults") -> T:
    with_prov = model.model_copy(update={"provenance": ConfigProvenance(source=provenance_source)})  # type: ignore[attr-defined]
    digest = compute_config_hash(with_prov)
    return with_prov.model_copy(update={"config_hash": digest})  # type: ignore[attr-defined]


def _stable_json(model: BaseModel) -> str:
    return json.dumps(model.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def write_config_atomically(path: Path, model: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = _stable_json(model)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _existing_provenance(path: Path, model_cls: type[BaseModel]) -> str | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        model = model_cls.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError, ValueError):
        return None
    provenance = getattr(model, "provenance", None)
    return provenance.source if provenance is not None else None


def init_configs() -> int:
    for rel, model_cls, factory in CONFIG_TARGETS:
        path = REPO_ROOT / rel
        existing = _existing_provenance(path, model_cls)
        if existing in PROTECTED_SOURCES:
            print(
                f"error: refusing to overwrite {rel} (provenance source is {existing!r})",
                file=sys.stderr,
            )
            return 1
        write_config_atomically(path, finalize_config(factory()))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.config_files", description="myRAG eval config writers")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="write the default Phase 4 and Phase 6 config files when missing or still at defaults")
    args = parser.parse_args(argv)
    if args.command == "init":
        return init_configs()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())