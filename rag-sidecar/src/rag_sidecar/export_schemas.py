import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from rag_sidecar.contracts import ConversationTurn, RagRunRequest, RagTrace, RunManifest

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"

Mode = Literal["validation", "serialization"]

CONTRACTS: list[tuple[type[BaseModel], Mode]] = [
    (ConversationTurn, "validation"),
    (RagRunRequest, "validation"),
    (RagTrace, "serialization"),
    (RunManifest, "serialization"),
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


def export_all(schemas_dir: Path = SCHEMAS_DIR) -> list[Path]:
    schemas_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for model, mode in CONTRACTS:
        schema = model.model_json_schema(mode=mode)
        text = json.dumps(schema, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
        target = schemas_dir / f"{model.__name__}.schema.json"
        _write_atomic(target, text)
        written.append(target)
    expected = {path.name for path in written}
    for stale in schemas_dir.glob("*.schema.json"):
        if stale.name not in expected:
            stale.unlink()
    return written


def main() -> None:
    for path in export_all():
        print(f"[export_schemas] wrote {path.name}")


if __name__ == "__main__":
    main()
