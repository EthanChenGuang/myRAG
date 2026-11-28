"""Bundle IO: <out>/<run_id>/ run directories (0700), atomic JSONL and manifest writes validated by their contracts."""
import hashlib
import json
import os
import re
from collections.abc import Iterable
from pathlib import Path

from pydantic import BaseModel
from rag_sidecar.contracts.finetune import RUN_ID_PATTERN, DatasetManifest

MANIFEST_FILE = "manifest.json"
CHUNKS_FILE = "chunks.jsonl"
_RUN_ID = re.compile(RUN_ID_PATTERN)


def check_run_id(run_id: str) -> str:
    if not _RUN_ID.fullmatch(run_id or ""):
        raise ValueError("run_id must match " + RUN_ID_PATTERN)
    return run_id


def new_run_dir(out: Path, run_id: str) -> Path:
    """Create <out>/<run_id> with mode 0700 (whatever the umask); an existing run directory is refused."""
    check_run_id(run_id)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    run_dir = out / run_id
    os.mkdir(run_dir, 0o700)
    os.chmod(run_dir, 0o700)
    return run_dir


def _atomic_write(path: Path, payload: bytes) -> str:
    path = Path(path)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return hashlib.sha256(payload).hexdigest()


def _validated(row: BaseModel | dict, model: type[BaseModel]) -> BaseModel:
    if isinstance(row, model):
        return row
    if isinstance(row, BaseModel):
        raise TypeError(f"expected {model.__name__}, got {type(row).__name__}")
    return model.model_validate(row)


def _line(row: BaseModel) -> str:
    return json.dumps(row.model_dump(mode="json", exclude_none=True), ensure_ascii=False, sort_keys=True) + "\n"


def write_jsonl(path: Path, rows: Iterable[BaseModel | dict], model: type[BaseModel]) -> str:
    """Validate every row as `model`, then write the file atomically (mode 0600); returns the file's sha256."""
    payload = "".join(_line(_validated(row, model)) for row in rows).encode("utf-8")
    return _atomic_write(path, payload)


class JsonlWriter:
    """Streams validated rows to a temporary file and publishes it with os.replace on close(); abort() leaves nothing."""

    def __init__(self, path: Path, model: type[BaseModel]):
        self.path = Path(path)
        self.model = model
        self.count = 0
        self._tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        fd = os.open(self._tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        self._handle = os.fdopen(fd, "wb")
        self._hash = hashlib.sha256()

    def write(self, row: BaseModel | dict) -> None:
        data = _line(_validated(row, self.model)).encode("utf-8")
        self._handle.write(data)
        self._hash.update(data)
        self.count += 1

    def close(self) -> str:
        self._handle.flush()
        os.fsync(self._handle.fileno())
        self._handle.close()
        os.replace(self._tmp, self.path)
        return self._hash.hexdigest()

    def abort(self) -> None:
        if not self._handle.closed:
            self._handle.close()
        self._tmp.unlink(missing_ok=True)


def read_jsonl(path: Path, model: type[BaseModel]) -> list[BaseModel]:
    rows: list[BaseModel] = []
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").split("\n"), start=1):
        if not line.strip():
            continue
        try:
            rows.append(model.model_validate_json(line))
        except ValueError as exc:
            raise ValueError(f"{Path(path).name}: line {number}: not a valid {model.__name__}") from exc
    return rows


def write_manifest(run_dir: Path, manifest: DatasetManifest) -> str:
    payload = json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    return _atomic_write(Path(run_dir) / MANIFEST_FILE, payload.encode("utf-8"))


def read_manifest(run_dir: Path) -> DatasetManifest:
    return DatasetManifest.model_validate_json((Path(run_dir) / MANIFEST_FILE).read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()
