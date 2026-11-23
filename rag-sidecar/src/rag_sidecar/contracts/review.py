from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.golden import Language


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


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
