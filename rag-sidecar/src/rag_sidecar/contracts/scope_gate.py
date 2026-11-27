"""Scope gate contracts (Phase 6.2 D-26, D-27): the per-request result and the tool-written calibration file.

T-06.2-03: counts, codes and scores only, never query, centroid or example text.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.retrieval import RefusalMode, _Contract

ScopeGateLabel = Literal["in_scope", "out_of_scope", "unsure"]
ScopeGateReason = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
EMBEDDING_PROFILE_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,63}$"
Rate = Annotated[float, Field(ge=0, le=1)]


class ScopeGateResult(_Contract):
    label: ScopeGateLabel
    score: float | None
    negative_score: float | None
    reason: ScopeGateReason
    centroid_count: int = Field(ge=0)
    latency_ms: float = Field(ge=0)


class ScopeGateCalibrationCell(_Contract):
    embedding_profile_id: str = Field(pattern=EMBEDDING_PROFILE_ID_PATTERN)
    rag_mode: RefusalMode
    threshold: float | None
    margin: float | None = Field(ge=0)
    false_refusal_rate: Rate | None
    false_refusal_n: int = Field(ge=0)
    correct_refusal_rate: Rate | None
    correct_refusal_n: int = Field(ge=0)
    false_refusal_upper_95: Rate | None = None
    status: Literal["calibrated", "uncalibrated"]

    @model_validator(mode="after")
    def _calibrated_has_threshold(self) -> "ScopeGateCalibrationCell":
        if self.status == "calibrated" and (self.threshold is None or self.margin is None):
            raise ValueError("a calibrated cell needs threshold and margin")
        return self


class ScopeGateCalibration(_Contract):
    """Written only by `python -m rag_eval.calibrate scope` (06.2-26); one cell per profile and mode."""

    schema_version: Literal[1] = 1
    recorded_at: datetime
    source: Literal["fixture", "live"]
    cells: list[ScopeGateCalibrationCell] = Field(default_factory=list)

    @model_validator(mode="after")
    def _one_cell_per_key(self) -> "ScopeGateCalibration":
        keys = [(cell.embedding_profile_id, cell.rag_mode) for cell in self.cells]
        if len(set(keys)) != len(keys):
            raise ValueError("cells must not repeat an (embedding_profile_id, rag_mode) pair")
        return self
