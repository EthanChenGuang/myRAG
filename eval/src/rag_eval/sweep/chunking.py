from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

LEGACY_ID = "legacy"


class ChunkingUsageError(Exception):
    pass


@dataclass(frozen=True)
class Preset:
    child_tokens: int
    parent_tokens: int
    preset: str
    slug: str


def parse_presets(text: str) -> list[Preset]:
    return []


def run_chunking_sweep(run_config: Path, presets: list[Preset], out: Path, **kwargs: Any) -> Any:
    return None


def decide_chunking_profile(report: Path, doc_type: str, profile_id: str, decided_by: str, out_dir: Path, **kwargs: Any) -> Any:
    return None
