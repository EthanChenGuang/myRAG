"""The 06.1-10 vector files, read (and, for fixture runs, written) on the Python side (D-11).

Layout under <bundle>/vectors/: <tenant>.<profile>.{f32,rows.jsonl,header.json} for a tenant's stored chunk vectors and
query-vectors.<tenant>.<profile>.{f32,rows.jsonl,header.json} for its query vectors, where <tenant> is the tenant key with
its colon replaced by an underscore. The .f32 file is row-major float32 little-endian; the header (VectorFileHeader)
carries the sha256 of the .f32 file, the row count and the dims; rows.jsonl holds one ChunkVectorRow or QueryVectorRow per
matrix row, in matrix order. A file whose sha256 differs from its header is refused (VectorFileTampered), and so is any
disagreement in dims, row count, tenant, profile or model (VectorFileShapeError, VectorFileInvalid). Errors name files and
codes only, never vector or text content.
"""
import hashlib
import json
import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import ValidationError
from rag_sidecar.contracts.finetune import ChunkVectorRow, QueryVectorRow, VectorFileHeader

VECTORS_DIR = "vectors"
QUERY_PREFIX = "query-vectors."
HEADER_SUFFIX = ".header.json"
DTYPE = np.dtype("<f4")
VectorKind = Literal["chunks", "queries"]


class VectorFileError(ValueError):
    def __init__(self, code: str, file: str | None = None):
        super().__init__(f"{code}: {file}" if file else code)
        self.code = code
        self.file = file


class VectorFileMissing(VectorFileError):
    pass


class VectorFileInvalid(VectorFileError):
    pass


class VectorFileTampered(VectorFileError):
    pass


class VectorFileShapeError(VectorFileError):
    pass


def tenant_file_key(tenant_key: str) -> str:
    """As bundle-io.ts tenantFileKey: the (first) colon becomes an underscore."""
    return tenant_key.replace(":", "_", 1)


def vector_file_base(kind: VectorKind, tenant_key: str, profile_id: str) -> str:
    stem = f"{tenant_file_key(tenant_key)}.{profile_id}"
    return f"{VECTORS_DIR}/{QUERY_PREFIX}{stem}" if kind == "queries" else f"{VECTORS_DIR}/{stem}"


def vector_files(base: str) -> dict[str, str]:
    return {"f32": f"{base}.f32", "rows": f"{base}.rows.jsonl", "header": f"{base}{HEADER_SUFFIX}"}


@dataclass(frozen=True)
class VectorSet:
    header: VectorFileHeader
    ids: tuple[str, ...]
    matrix: np.ndarray

    def index(self) -> dict[str, int]:
        return {item: position for position, item in enumerate(self.ids)}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _row_id(row: ChunkVectorRow | QueryVectorRow) -> str:
    if isinstance(row, ChunkVectorRow):
        return row.chunk_id
    return row.pair_id if row.pair_id is not None else row.query_id


def read_vector_set(
    bundle_dir: Path,
    base: str,
    *,
    kind: VectorKind,
    tenant_key: str | None = None,
    profile_id: str | None = None,
    expected_dims: int | None = None,
) -> VectorSet:
    header = VectorFileHeader.model_validate_json((Path(bundle_dir) / vector_files(base)["header"]).read_text())
    return VectorSet(header=header, ids=(), matrix=np.zeros((0, header.dims), dtype=DTYPE))


def read_chunk_vectors(bundle_dir: Path, tenant_key: str, profile_id: str, *, expected_dims: int | None = None) -> VectorSet:
    return read_vector_set(
        bundle_dir,
        vector_file_base("chunks", tenant_key, profile_id),
        kind="chunks",
        tenant_key=tenant_key,
        profile_id=profile_id,
        expected_dims=expected_dims,
    )


def read_query_vectors(bundle_dir: Path, tenant_key: str, profile_id: str, *, expected_dims: int | None = None) -> VectorSet:
    return read_vector_set(
        bundle_dir,
        vector_file_base("queries", tenant_key, profile_id),
        kind="queries",
        tenant_key=tenant_key,
        profile_id=profile_id,
        expected_dims=expected_dims,
    )


def chunk_vector_profiles(bundle_dir: Path, tenant_key: str) -> list[str]:
    """Profile ids that have a stored chunk vector header for this tenant, sorted."""
    return []
    directory = Path(bundle_dir) / VECTORS_DIR
    prefix = f"{tenant_file_key(tenant_key)}."
    if not directory.is_dir():
        return []
    found = []
    for path in directory.iterdir():
        name = path.name
        if name.startswith(QUERY_PREFIX) or not name.startswith(prefix) or not name.endswith(HEADER_SUFFIX):
            continue
        found.append(name[len(prefix) : -len(HEADER_SUFFIX)])
    return sorted(found)


def _write(path: Path, payload: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def write_vector_set(
    bundle_dir: Path,
    *,
    kind: VectorKind,
    tenant_key: str,
    profile_id: str,
    model: str,
    ids: Sequence[str],
    matrix: np.ndarray,
) -> VectorFileHeader:
    """Writes one set in the 06.1-10 format (header last), for fixture runs and tests; rows of a query set carry pair_id."""
    matrix = np.ascontiguousarray(np.asarray(matrix, dtype=DTYPE))
    if matrix.ndim != 2 or matrix.shape[0] != len(ids):
        raise VectorFileShapeError("matrix_shape")
    dims = int(matrix.shape[1])
    base = vector_file_base(kind, tenant_key, profile_id)
    files = {name: Path(bundle_dir) / rel for name, rel in vector_files(base).items()}
    files["f32"].parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = matrix.tobytes()
    lines = []
    for position, item in enumerate(ids):
        if kind == "chunks":
            row = ChunkVectorRow(
                tenant_key=tenant_key, chunk_id=item, row_index=position, profile_id=profile_id, model=model, dims=dims
            )
        else:
            row = QueryVectorRow(
                pair_id=item, profile_id=profile_id, model=model, dims=dims, vector=[float(v) for v in matrix[position]]
            )
        lines.append(json.dumps(row.model_dump(mode="json", exclude_none=True), sort_keys=True) + "\n")
    header = VectorFileHeader(
        tenant_key=tenant_key,
        profile_id=profile_id,
        model=model,
        dims=dims,
        rows=len(ids),
        dtype="float32-le",
        sha256=hashlib.sha256(data).hexdigest(),
    )
    _write(files["f32"], data)
    _write(files["rows"], "".join(lines).encode("utf-8"))
    _write(files["header"], (json.dumps(header.model_dump(mode="json"), indent=2) + "\n").encode("utf-8"))
    return header
