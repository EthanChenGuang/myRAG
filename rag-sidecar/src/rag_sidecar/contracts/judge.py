from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.golden import Category, Language
from rag_sidecar.contracts.report import MetricValue


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class JudgeConfig(_Contract):
    judge_model: str
    judge_family: str
    provider: Literal["openrouter"]
    base_url: str
    temperature: float = Field(ge=0.0, le=0.0)
    embedding_model: str
    max_concurrency: int = Field(default=4, ge=1)


class JudgeItemScore(_Contract):
    item_id: str
    language: Language
    category: Category
    library: Literal["deepeval", "ragas"]
    metric: Literal["faithfulness", "answer_relevance", "context_recall"]
    score: float | None = Field(default=None, ge=0.0, le=1.0)
    skipped_reason: str | None = None


class JudgeReport(_Contract):
    schema_version: Literal[1] = 1
    run_id: str
    run_config_hash: str
    judge_model: str
    judge_family: str
    generator_model: str
    generator_family: str
    items: list[JudgeItemScore]
    overall: dict[str, MetricValue]
    by_language: dict[str, dict[str, MetricValue]]
    by_category: dict[str, dict[str, MetricValue]]
