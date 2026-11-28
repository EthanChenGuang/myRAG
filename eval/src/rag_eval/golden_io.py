import hashlib
import json
import os
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.eval_run import GoldenFilter
from rag_sidecar.contracts.golden import GoldenItem


def load_golden(path: Path) -> list[GoldenItem]:
    path = Path(path)
    items: list[GoldenItem] = []
    first_line_of: dict[str, int] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if not line.strip():
            continue
        try:
            item = GoldenItem.model_validate_json(line)
        except ValidationError as exc:
            raise ValueError(f"{path}: line {number}: invalid golden item: {exc}") from exc
        if item.id in first_line_of:
            raise ValueError(
                f"{path}: line {number}: duplicate golden item id {item.id!r} (first seen on line {first_line_of[item.id]})"
            )
        first_line_of[item.id] = number
        items.append(item)
    return items


def select_golden(items: list[GoldenItem], golden_filter: GoldenFilter) -> list[GoldenItem]:
    statuses = set(golden_filter.review_statuses)
    return [item for item in items if item.review_status in statuses]


class UnsafeWriteTarget(ValueError):
    """The target or its .tmp sibling is a symlink; nothing is written through it."""


def write_private_atomic(path: Path, data: bytes) -> None:
    """Writes data to <path>.tmp (mode 0600, created without following a symlink), then renames it over path.

    A symlinked target or .tmp sibling is refused; a stale regular .tmp file is replaced.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    for candidate in (path, tmp):
        if candidate.is_symlink():
            raise UnsafeWriteTarget(f"refusing to write through a symlink: {candidate.name}")
    tmp.unlink(missing_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(tmp, flags, 0o600)
    except FileExistsError:
        raise UnsafeWriteTarget(f"refusing to write: {tmp.name} reappeared while writing") from None
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
        if path.is_symlink():
            raise UnsafeWriteTarget(f"refusing to write through a symlink: {path.name}")
        os.replace(tmp, path)
    except BaseException:
        if not tmp.is_symlink():
            tmp.unlink(missing_ok=True)
        raise


def write_golden(path: Path, items: list[GoldenItem]) -> None:
    path = Path(path)
    ordered = sorted(items, key=lambda item: item.id)
    ids = [item.id for item in ordered]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate golden item id in write_golden input")
    payload = "".join(
        json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n" for item in ordered
    )
    write_private_atomic(path, payload.encode("utf-8"))


def golden_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def item_sha256(item: GoldenItem) -> str:
    """sha256 of the canonical JSON of one validated item, so JSONL whitespace and key order do not change it."""

    text = json.dumps(item.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
