from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from rag_sidecar.contracts.golden import Language


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


ReviewReason = Literal[
    "sampled",
    "feedback_negative",
    "groundedness_flagged",
    "refusal_disputed",
    "refused_high_score",
    "zero_results",
    "low_score",
    "no_source_opened",
    "claim_unsupported",
    "output_guard",
    "version_conflict",
]


class ReviewQueueItem(_Contract):
    trace_id: str = Field(min_length=1)
    observation_id: str = Field(min_length=1)
    captured_at: str = Field(min_length=1)
    tenant_key: str
    language: Language | None = None
    query_masked: str
    answer_masked: str
    context_masked: str
    model: str
    tags: list[str] = Field(default_factory=list)
    reasons: list[ReviewReason] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})

    @field_validator("reasons")
    @classmethod
    def _no_repeats(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("review reasons must not repeat")
        return value
