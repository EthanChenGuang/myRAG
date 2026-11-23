from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.eval_run import RagTrace, RunManifest


def load_traces(path: Path) -> list[RagTrace]:
    path = Path(path)
    traces: list[RagTrace] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if not line.strip():
            continue
        try:
            traces.append(RagTrace.model_validate_json(line))
        except ValidationError as exc:
            raise ValueError(f"{path}: line {number}: invalid trace: {exc}") from exc
    return traces


def load_manifest(path: Path) -> RunManifest:
    path = Path(path)
    try:
        return RunManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as exc:
        raise ValueError(f"{path}: invalid run manifest: {exc}") from exc
