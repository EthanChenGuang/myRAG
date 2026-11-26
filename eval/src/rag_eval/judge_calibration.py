"""Judge calibration (Phase 5.3 D-28 to D-31). Placeholder until the implementation lands."""

from dataclasses import dataclass
from typing import Any

from rag_sidecar.contracts.judge_calibration import JudgeCalibration, JudgeCalibrationCell
from rag_sidecar.contracts.retrieval import ConfigProvenance


@dataclass(frozen=True)
class CellDetail:
    cell: JudgeCalibrationCell
    kappa_interval: tuple[float | None, float | None]
    positive_share: float | None


def judge_roles(config: Any) -> dict[str, Any]:
    return {}


def judge_fingerprint(role: str, config: Any, *, versions: Any = None, rubrics: Any = None) -> str:
    return "0" * 64


def calibrate_with_details(cases: Any, judge_factory: Any, gates: Any, source: str, **kwargs: Any) -> list[CellDetail]:
    return []


def calibrate(cases: Any, judge_factory: Any, gates: Any, source: str, **kwargs: Any) -> list[JudgeCalibrationCell]:
    return []


def effective_status(cell: Any, running_fingerprint: Any, today: Any, max_age_days: int) -> str:
    return "gating"


def merge_cells(existing: Any, cells: Any, running_fingerprints: Any) -> JudgeCalibration:
    return JudgeCalibration(cells=[], provenance=ConfigProvenance(source="defaults"))


def main(argv: list[str] | None = None, *, judge_factory: Any = None) -> int:
    return 0
