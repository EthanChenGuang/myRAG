from pathlib import Path

from rag_sidecar.contracts.golden import GoldenItem

SPLIT_RULE = "sha256-first8hex-mod100-lt70-dev"


def assign_split(item_id: str) -> str:
    return "test"


def load_manifest(path: Path) -> dict[str, str]:
    return {}


def write_manifest(path: Path, assignments: dict[str, str]) -> None:
    return None


def freeze_splits(items: list[GoldenItem], manifest_path: Path) -> list[GoldenItem]:
    return items
