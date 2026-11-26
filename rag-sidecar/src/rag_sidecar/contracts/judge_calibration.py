"""Judge calibration contracts (Phase 5.3 D-28 to D-31).

eval/config/judge-calibration.json holds numbers only and no tenant id; it is written only by
rag_eval.judge_calibration. `uncalibrated` (D-29) is derived at read time from age and fingerprint, never stored.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .languages import Language
from .monitor import SHA256_PATTERN, Sha256, Timestamp
from .quality_gates import METRIC_FORMS
from .retrieval import ConfigProvenance

JudgeRole = Literal["nightly", "online"]
JudgeLibrary = Literal["deepeval", "ragas"]
JudgeCellStatus = Literal["gating", "report_only"]
JudgeCellReason = Literal[
    "kappa_below_floor",
    "accuracy_below_floor",
    "n_below_minimum",
    "labels_not_confirmed",
    "length_bias",
    "perturbation",
    "kappa_undefined",
]
JudgeLabelSource = Literal["seed", "review_queue", "mixed"]
SeedVariant = Literal["base", "long", "short", "expanded", "assertive"]
SeedReviewStatus = Literal["draft", "approved"]

METRIC_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"
SEED_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,95}$"
REVIEWER_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"
CELL_KEY_PATTERN = r"^[a-f0-9]{64}\|(nightly|online)\|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?\|(deepeval|ragas)\.[a-z][a-z0-9_]{0,63}$"

Metric = Annotated[str, Field(pattern=METRIC_PATTERN)]
SeedId = Annotated[str, Field(pattern=SEED_ID_PATTERN)]
SignedDelta = Annotated[float, Field(ge=-1, le=1)]
Share = Annotated[float, Field(ge=0, le=1)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _known_metric(metric: str) -> str:
    if metric not in METRIC_FORMS:
        raise ValueError(f"unknown metric {metric}")
    return metric


class JudgeCalibrationCell(_Contract):
    """One (judge fingerprint, role, language, library.metric) cell: agreement numbers, no text (D-28, D-29)."""

    key: str = Field(pattern=CELL_KEY_PATTERN)
    fingerprint: Sha256
    role: JudgeRole
    language: Language
    library: JudgeLibrary
    metric: Metric
    status: JudgeCellStatus
    reasons: list[JudgeCellReason] = Field(default_factory=list)
    kappa: float | None = Field(default=None, ge=-1, le=1)
    accuracy: Share | None = None
    n: int = Field(ge=0)
    source: JudgeLabelSource
    unsupported_recall: Share | None = None
    unsupported_precision: Share | None = None
    length_bias_delta: SignedDelta | None = None
    expanded_delta: SignedDelta | None = None
    assertive_delta: SignedDelta | None = None
    labels_human_confirmed: bool
    recorded_at: Timestamp

    @field_validator("metric")
    @classmethod
    def _metric(cls, value: str) -> str:
        return _known_metric(value)

    @model_validator(mode="after")
    def _consistent(self) -> "JudgeCalibrationCell":
        expected = f"{self.fingerprint}|{self.role}|{self.language}|{self.library}.{self.metric}"
        if self.key != expected:
            raise ValueError(f"key must be {expected}")
        if len(set(self.reasons)) != len(self.reasons):
            raise ValueError("reasons must not repeat")
        if self.status == "gating":
            if self.reasons:
                raise ValueError("a gating cell carries no reasons")
            if self.kappa is None or self.accuracy is None:
                raise ValueError("a gating cell needs kappa and accuracy")
            if not self.labels_human_confirmed:
                raise ValueError("a gating cell needs labels confirmed by a human")
            if METRIC_FORMS[self.metric] == "holistic":
                raise ValueError(f"metric {self.metric} is holistic and cannot gate")
        elif not self.reasons:
            raise ValueError("a report_only cell names at least one reason")
        return self


class JudgeCalibration(_Contract):
    schema_version: Literal[1] = 1
    cells: list[JudgeCalibrationCell] = Field(default_factory=list)
    running_fingerprints: dict[JudgeRole, Sha256] = Field(default_factory=dict)
    provenance: ConfigProvenance
    config_hash: str | None = Field(default=None, pattern=SHA256_PATTERN)

    @model_validator(mode="after")
    def _unique_keys(self) -> "JudgeCalibration":
        keys = [cell.key for cell in self.cells]
        if len(set(keys)) != len(keys):
            raise ValueError("cell keys must not repeat")
        return self


class JudgeSeedCase(_Contract):
    """One synthetic, neutral seed case (D-31). A draft case cannot produce a gating cell (H-5)."""

    id: SeedId
    language: Language
    question: str = Field(min_length=1, max_length=2000)
    contexts: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(min_length=1)
    answer: str = Field(min_length=1, max_length=4000)
    expected: dict[Metric, bool] = Field(min_length=1)
    unsupported_content: bool
    variant: SeedVariant = "base"
    base_id: SeedId | None = None
    pair_id: SeedId | None = None
    perturbation_group: SeedId | None = None
    review_status: SeedReviewStatus = "draft"
    reviewed_by: str | None = Field(default=None, pattern=REVIEWER_PATTERN)

    @field_validator("expected")
    @classmethod
    def _metrics(cls, value: dict[str, bool]) -> dict[str, bool]:
        for metric in value:
            _known_metric(metric)
        return value

    @model_validator(mode="after")
    def _consistent(self) -> "JudgeSeedCase":
        if self.variant == "base":
            if self.base_id is not None:
                raise ValueError("a base case has no base_id")
        elif self.base_id is None:
            raise ValueError(f"a {self.variant} variant needs base_id")
        if self.base_id == self.id:
            raise ValueError("base_id must name another case")
        if self.review_status == "approved" and self.reviewed_by is None:
            raise ValueError("an approved case needs reviewed_by")
        return self
