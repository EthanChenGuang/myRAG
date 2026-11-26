from typing import Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.golden import _Contract
from rag_sidecar.contracts.omit import omit_none_schema

Profile = Literal["chat", "embed", "voice"]
CacheState = Literal["hit", "miss", "bypass"]


class StageLatency(_Contract):
    p50_ms: float = Field(ge=0)
    p95_ms: float = Field(ge=0)
    n: int = Field(ge=0)

    @model_validator(mode="after")
    def _p50_not_above_p95(self) -> "StageLatency":
        if self.p50_ms > self.p95_ms:
            raise ValueError("p50_ms must not exceed p95_ms")
        return self


class GroupBudget(_Contract):
    """D-29: a budget for a group of stages measured as one span, such as the pre-retrieval query stage."""

    p50_ms: float | None = Field(default=None, gt=0)
    p95_ms: float = Field(gt=0)

    @model_validator(mode="after")
    def _p50_not_above_p95(self) -> "GroupBudget":
        if self.p50_ms is not None and self.p50_ms > self.p95_ms:
            raise ValueError("p50_ms must not exceed p95_ms")
        return self


class ProfileBudget(_Contract):
    total_p50_ms: float = Field(gt=0)
    total_p95_ms: float = Field(gt=0)
    stages: dict[str, float] = Field(default_factory=dict)
    groups: dict[str, GroupBudget] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _valid(self) -> "ProfileBudget":
        if self.total_p50_ms > self.total_p95_ms:
            raise ValueError("total_p50_ms must not exceed total_p95_ms")
        if any(budget <= 0 for budget in self.stages.values()):
            raise ValueError("stage budgets must be positive")
        return self


class ScorerBudget(_Contract):
    p50_ms: float = Field(gt=0)
    p95_ms: float = Field(gt=0)

    @model_validator(mode="after")
    def _p50_not_above_p95(self) -> "ScorerBudget":
        if self.p50_ms > self.p95_ms:
            raise ValueError("p50_ms must not exceed p95_ms")
        return self


class GroundednessBudgets(_Contract):
    hhem_2_1_open: ScorerBudget | None = None
    hhem_2_3_vectara: ScorerBudget | None = None
    report_only: Literal[True] = True


class AnswerCheckBudgets(_Contract):
    """D-28, D-61: report-only budgets for the post-stream checks and the guard's per-delta overhead."""

    claim_check: ScorerBudget | None = None
    groundedness_judge: ScorerBudget | None = None
    output_guard: ScorerBudget | None = None
    report_only: Literal[True] = True


class TtftBudget(ScorerBudget):
    """D-26: time to first answer text delta, per channel and cache state; report-only for live traffic."""


class PreGenerationBudget(_Contract):
    """D-26: time until the generator call starts, per channel; the CI gate reads p95."""

    p95_ms: float = Field(gt=0)


def _omit_none(value: object) -> bool:
    return value is None


class LatencyBudgets(_Contract):
    schema_version: Literal[1] = 1
    profiles: dict[Profile, ProfileBudget]
    groundedness: GroundednessBudgets | None = None
    ttft: dict[Profile, dict[CacheState, TtftBudget]] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    pre_generation: dict[Profile, PreGenerationBudget] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    answer_checks: AnswerCheckBudgets | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
