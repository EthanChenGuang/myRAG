from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(frozen=True)


class ReviewQueueItem(_Contract):
    trace_id: str = ""
    observation_id: str = ""
    captured_at: str = ""
    tenant_key: str = ""
    language: str | None = None
    query_masked: str = ""
    answer_masked: str = ""
    context_masked: str = ""
    model: str = ""
    tags: list[str] = []
