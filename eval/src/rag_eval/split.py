import hashlib
import json
import os
from pathlib import Path

from rag_sidecar.contracts.golden import GoldenItem, GoldenSplitManifest

SPLIT_RULE = "sha256-first8hex-mod100-lt70-dev"


def assign_split(item_id: str) -> str:
    bucket = int(hashlib.sha256(item_id.encode()).hexdigest()[:8], 16) % 100
    return "dev" if bucket < 70 else "test"


def load_manifest(path: Path) -> dict[str, str]:
    path = Path(path)
    if not path.exists():
        return {}
    manifest = GoldenSplitManifest.model_validate_json(path.read_text(encoding="utf-8"))
    return dict(manifest.assignments)


def write_manifest(path: Path, assignments: dict[str, str]) -> None:
    path = Path(path)
    manifest = GoldenSplitManifest(rule=SPLIT_RULE, assignments=assignments)
    payload = json.dumps(manifest.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, path)


def freeze_splits(items: list[GoldenItem], manifest_path: Path) -> list[GoldenItem]:
    assignments = load_manifest(manifest_path)
    seen: set[str] = set()
    frozen: list[GoldenItem] = []
    added = False
    for item in items:
        if item.id in seen:
            raise ValueError(f"duplicate golden item id: {item.id}")
        seen.add(item.id)
        recorded = assignments.get(item.id)
        if recorded is None:
            recorded = assign_split(item.id)
            assignments[item.id] = recorded
            added = True
        elif item.split != recorded:
            raise ValueError(
                f"item {item.id} has split {item.split!r} but the manifest froze {recorded!r}"
            )
        frozen.append(item if item.split == recorded else item.model_copy(update={"split": recorded}))
    if added:
        write_manifest(manifest_path, assignments)
    return frozen
