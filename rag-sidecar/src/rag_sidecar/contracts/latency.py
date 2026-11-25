from typing import Literal

from pydantic import Field, model_validator

from rag_sidecar.contracts.golden import _Contract

Profile = Literal["chat", "embed", "voice"]


class StageLatency(_Contract):
    p50_ms: float = Field(ge=0)
    p95_ms: float = Field(ge=0)
    n: int = Field(ge=0)

    @model_validator(mode="after")
    def _p50_not_above_p95(self) -> "StageLatency":
        if self.p50_ms > self.p95_ms:
            raise ValueError("p50_ms must not exceed p95_ms")
        return self


class ProfileBudget(_Contract):
    total_p50_ms: float = Field(gt=0)
    total_p95_ms: float = Field(gt=0)
    stages: dict[str, float] = Field(default_factory=dict)

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


class LatencyBudgets(_Contract):
    schema_version: Literal[1] = 1
    profiles: dict[Profile, ProfileBudget]
    groundedness: GroundednessBudgets | None = None
