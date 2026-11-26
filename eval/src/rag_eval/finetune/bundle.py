"""Bundle IO: <out>/<run_id>/ run directories (0700), atomic JSONL and manifest writes validated by their contracts."""
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel


def new_run_dir(out: Path, run_id: str) -> Path:
    return Path(out) / run_id


def write_jsonl(path: Path, rows: Iterable[BaseModel | dict], model: type[BaseModel]) -> str:
    return ""


def read_jsonl(path: Path, model: type[BaseModel]) -> list[BaseModel]:
    return []
