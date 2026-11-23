from pydantic import BaseModel

from rag_sidecar.contracts.report import MetricValue


class JudgeConfig(BaseModel):
    judge_model: str
    judge_family: str
    provider: str
    base_url: str
    temperature: float
    embedding_model: str
    max_concurrency: int = 4


class JudgeItemScore(BaseModel):
    item_id: str
    language: str
    category: str
    library: str
    metric: str
    score: float | None = None
    skipped_reason: str | None = None


class JudgeReport(BaseModel):
    schema_version: int = 1
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
