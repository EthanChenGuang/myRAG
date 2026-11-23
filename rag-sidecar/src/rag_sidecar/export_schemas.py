import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from rag_sidecar.contracts import (
    Baseline,
    ConversationTurn,
    DraftedItemBatch,
    EvalReport,
    GateResult,
    GoldenItem,
    GoldenSplitManifest,
    JudgeConfig,
    JudgeReport,
    NoiseConfig,
    RagRunRequest,
    RagTrace,
    RunManifest,
    SidecarError,
    SidecarHealth,
    SidecarInfo,
    SidecarReady,
)
from rag_sidecar.contracts.samples import build_samples

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "rag-sidecar" / "schemas"
SAMPLES_PATH = REPO_ROOT / "tests" / "fixtures" / "contracts" / "samples.json"

Mode = Literal["validation", "serialization"]

CONTRACTS: list[tuple[type[BaseModel], Mode]] = [
    (ConversationTurn, "validation"),
    (RagRunRequest, "validation"),
    (RagTrace, "serialization"),
    (RunManifest, "serialization"),
    (GoldenItem, "serialization"),
    (GoldenSplitManifest, "serialization"),
    (DraftedItemBatch, "serialization"),
    (EvalReport, "serialization"),
    (Baseline, "serialization"),
    (NoiseConfig, "serialization"),
    (GateResult, "serialization"),
    (JudgeConfig, "serialization"),
    (JudgeReport, "serialization"),
    (SidecarHealth, "serialization"),
    (SidecarReady, "serialization"),
    (SidecarInfo, "serialization"),
    (SidecarError, "serialization"),
]


def _write_atomic(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _dump(value: object) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n"


def export_all(out_dir: Path = SCHEMAS_DIR, samples_path: Path = SAMPLES_PATH) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    samples_path.parent.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for model, mode in CONTRACTS:
        target = out_dir / f"{model.__name__}.schema.json"
        _write_atomic(target, _dump(model.model_json_schema(mode=mode)))
        written.append(target)
    expected = {path.name for path in written}
    for stale in out_dir.glob("*.schema.json"):
        if stale.name not in expected:
            stale.unlink()
    _write_atomic(samples_path, _dump(build_samples()))
    written.append(samples_path)
    return written


def main() -> None:
    for path in export_all():
        print(f"[export_schemas] wrote {path.name}")


if __name__ == "__main__":
    main()
