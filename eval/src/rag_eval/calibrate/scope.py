"""Scope gate calibration (plan 06.2-26): skeleton, filled in by the GREEN commit."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig

LEGACY_PROFILE_ID = "openai-3-small-1536"


class ScopeCalibrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ScopeRow:
    item_id: str
    split: str
    answerable: bool
    score: float


@dataclass
class ScopeCalibrationResult:
    source: str = ""
    profile_id: str = ""
    rows: int = 0
    excluded: dict[str, int] = field(default_factory=dict)


def mode_targets(config: RefusalCalibrationConfig) -> dict[str, float]:
    return {}


def fit_scope_cells(rows: Any, profile_id: str, targets: dict[str, float], **_: Any) -> list[Any]:
    return []


def stable_json(model: Any) -> str:
    return ""


def run_scope_calibration(report_dir: Path, **_: Any) -> ScopeCalibrationResult:
    return ScopeCalibrationResult()
