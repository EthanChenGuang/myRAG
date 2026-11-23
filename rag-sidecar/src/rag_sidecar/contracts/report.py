from pydantic import BaseModel

from rag_sidecar.contracts.eval_run import RagRunOptions


class MetricValue(BaseModel):
    value: float | None
    n: int


class SliceMetrics(BaseModel):
    recall_at_5: MetricValue
    recall_at_10: MetricValue
    mrr: MetricValue
    correct_refusal_rate: MetricValue
    false_refusal_rate: MetricValue


class ItemResult(BaseModel):
    item_id: str
    language: str
    category: str
    answerable: bool
    refused: bool
    span_count: int
    spans_hit_at_5: int
    spans_hit_at_10: int
    first_hit_rank: int | None = None


class EvalReport(BaseModel):
    schema_version: int
    run_id: str
    tier: str
    run_config_hash: str
    corpus_sha256: str | None = None
    golden_sha256: str
    embedder_id: str | None = None
    embedder_version: int | None = None
    deployment_mode: str
    request_options: RagRunOptions
    k_values: list[int]
    overall: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_category: dict[str, SliceMetrics]
    by_language_category: dict[str, SliceMetrics]
    items: list[ItemResult]
    notes: list[str]
