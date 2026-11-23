from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class StageLatency(_Contract):
    p50_ms: float
    p95_ms: float
    n: int


class ProfileBudget(_Contract):
    total_p50_ms: float
    total_p95_ms: float
    stages: dict[str, float] = {}


class LatencyBudgets(_Contract):
    schema_version: Literal[1] = 1
    profiles: dict[str, ProfileBudget]
