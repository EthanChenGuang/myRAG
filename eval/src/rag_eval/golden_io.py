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


def write_golden(path: Path, items: list[GoldenItem]) -> None:
    path = Path(path)
    ordered = sorted(items, key=lambda item: item.id)
    ids = [item.id for item in ordered]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate golden item id in write_golden input")
    payload = "".join(
        json.dumps(item.model_dump(mode="json"), ensure_ascii=False, sort_keys=True) + "\n" for item in ordered
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(payload.encode("utf-8"))
    os.replace(tmp, path)


def golden_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def item_sha256(item: GoldenItem) -> str:
    """sha256 of the canonical JSON of one validated item, so JSONL whitespace and key order do not change it."""

    text = json.dumps(item.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
