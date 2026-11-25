"""Route parse fixtures once per candidate set of L1 thresholds (D-41)."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any


def route_candidates(fixtures_dir: Path, fixture_ids: Sequence[str], candidates: Sequence[dict[str, Any]], combo: str) -> list[dict[str, list[dict[str, Any]]]]:
    return [{} for _ in candidates]


def main(argv: list[str] | None = None) -> int:
    return 1
