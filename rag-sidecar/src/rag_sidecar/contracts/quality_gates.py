"""Absolute quality gates on top of the noise band (Phase 5.3 D-04 to D-09): the gate file and its result."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .languages import Language
from .retrieval import ConfigProvenance, RefusalMode

MetricForm = Literal["claim_level", "score_0_1", "holistic"]
METRIC_FORMS: dict[str, MetricForm] = {
    "faithfulness": "claim_level",
    "answer_relevance": "score_0_1",
    "holistic_quality": "holistic",
}

CODE_PATTERN = r"^[a-z0-9_]+$"
SLICE_PATTERN = r"^[a-z0-9_]+(:[A-Za-z0-9_.|-]+)*$"

GateCheckResult = Literal["passed", "failed", "insufficient_n", "report_only", "skipped"]
CompositionCheckResult = Literal["passed", "failed", "warning", "insufficient_n"]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _share(**kwargs: object) -> float:
    return Field(ge=0, le=1, **kwargs)  # type: ignore[return-value]


def _check_gateable_metrics(value: dict[str, float], where: str) -> dict[str, float]:
    for metric in value:
        form = METRIC_FORMS.get(metric)
        if form is None:
            raise ValueError(f"{where}: unknown metric {metric}")
        if form == "holistic":
            raise ValueError(f"{where}: metric {metric} is holistic and cannot gate")
    for metric, limit in value.items():
        if not 0 <= limit <= 1:
            raise ValueError(f"{where}: {metric} must be between 0 and 1")
    return value


class QualityGatesComposition(_Contract):
    no_answer_share_min: float = _share()
    no_answer_share_target: float = _share()
    excluded_categories: list[str] = Field(default_factory=list)
    required_no_answer_kinds: list[str] = Field(default_factory=list)
    min_items_per_language: int = Field(ge=0)

    @model_validator(mode="after")
    def _target_not_below_min(self) -> "QualityGatesComposition":
        if self.no_answer_share_target < self.no_answer_share_min:
            raise ValueError("no_answer_share_target must not be below no_answer_share_min")
        if len(set(self.excluded_categories)) != len(self.excluded_categories):
            raise ValueError("excluded_categories must not repeat")
        if len(set(self.required_no_answer_kinds)) != len(self.required_no_answer_kinds):
            raise ValueError("required_no_answer_kinds must not repeat")
        return self


class QualityGatesCeilings(_Contract):
    """A null ceiling is report-only (D-04)."""

    false_answer_rate: dict[RefusalMode, float | None]
    false_refusal_rate: dict[RefusalMode, float | None]
    min_n: int = Field(ge=1)

    @field_validator("false_answer_rate", "false_refusal_rate")
    @classmethod
    def _shares(cls, value: dict[str, float | None]) -> dict[str, float | None]:
        for mode, limit in value.items():
            if limit is not None and not 0 <= limit <= 1:
                raise ValueError(f"ceiling for {mode} must be between 0 and 1")
        return value


class QualityGatesFloors(_Contract):
    """Judge metric floors per tier; a holistic or unknown metric is rejected (D-09, D-30)."""

    smoke: dict[str, float] = Field(default_factory=dict)
    nightly: dict[str, float] = Field(default_factory=dict)

    @field_validator("smoke", "nightly")
    @classmethod
    def _gateable(cls, value: dict[str, float]) -> dict[str, float]:
        return _check_gateable_metrics(value, "floors")


class QualityGatesJudge(_Contract):
    kappa_floor: float = Field(ge=-1, le=1)
    accuracy_floor: float = _share()
    min_labels_per_language: int = Field(ge=1)
    seed_min_labels_per_language: int = Field(ge=1)
    pass_threshold: dict[str, float] = Field(default_factory=dict)
    length_bias_max_delta: float = _share()
    perturbation_max_delta: float = _share()
    max_age_days: int = Field(ge=1)

    @field_validator("pass_threshold")
    @classmethod
    def _gateable(cls, value: dict[str, float]) -> dict[str, float]:
        return _check_gateable_metrics(value, "judge.pass_threshold")


class QualityGatesLifecycle(_Contract):
    max_stale_share: float = _share()
    re_review_days: int = Field(ge=1)


class QualityGates(_Contract):
    schema_version: Literal[1] = 1
    composition: QualityGatesComposition
    ceilings: QualityGatesCeilings
    floors: QualityGatesFloors
    judge: QualityGatesJudge
    lifecycle: QualityGatesLifecycle
    provenance: ConfigProvenance
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class GateCheckRow(_Contract):
    """One absolute check on one slice; skipped and insufficient_n are never counted as passed."""

    check: str = Field(pattern=CODE_PATTERN)
    slice: str = Field(pattern=SLICE_PATTERN)
    measured: float | None = None
    numerator: int | None = Field(default=None, ge=0)
    denominator: int | None = Field(default=None, ge=0)
    limit: float | None = None
    limit_kind: Literal["max", "min"]
    result: GateCheckResult
    reason: str | None = Field(default=None, pattern=CODE_PATTERN)


class CompositionLanguageResult(_Contract):
    language: Language
    items: int = Field(ge=0)
    no_answer: int = Field(ge=0)
    share: float | None = Field(default=None, ge=0, le=1)
    min: float = _share()
    target: float = _share()
    result: CompositionCheckResult
    kinds: dict[str, int] = Field(default_factory=dict)


class CompositionResult(_Contract):
    languages: list[CompositionLanguageResult] = Field(default_factory=list)
    missing_required_kinds: list[str] = Field(default_factory=list)


class AbsoluteGateResult(_Contract):
    passed: bool
    mode: Literal["enforce", "report"]
    rag_mode: RefusalMode
    checks: list[GateCheckRow] = Field(default_factory=list)
    composition: CompositionResult
    stale_count: int = Field(default=0, ge=0)
    stale_share: float = Field(default=0.0, ge=0, le=1)
    stale_result: GateCheckResult
    failed: list[str] = Field(default_factory=list)
    exit_code: Literal[0, 11, 12]

    @model_validator(mode="after")
    def _consistent(self) -> "AbsoluteGateResult":
        if len(set(self.failed)) != len(self.failed):
            raise ValueError("failed must not repeat")
        if self.mode == "report" and self.exit_code != 0:
            raise ValueError("report mode always exits 0")
        return self
