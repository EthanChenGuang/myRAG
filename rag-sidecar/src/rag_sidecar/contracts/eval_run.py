from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ConversationTurn(_Contract):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class RagRunOptions(_Contract):
    max_results: int | None = Field(default=None, ge=1, le=100)
    organization_id: str | None = None
    user_id: str | None = None


class RagRunRequest(_Contract):
    schema_version: Literal[1] = 1
    item_id: str | None = None
    query: str = Field(min_length=1, max_length=4000)
    conversation: list[ConversationTurn] = Field(default_factory=list)
    rag_mode: Literal["strict", "balanced", "flexible"] = "strict"
    web_search: Literal[False] = False
    options: RagRunOptions = Field(default_factory=RagRunOptions)
