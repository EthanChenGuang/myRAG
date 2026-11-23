from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.eval_run import GoldenFilter, RagRunOptions
from rag_sidecar.contracts.golden import Category, Language, Split


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MetricValue(_Contract):
    value: float | None
    n: int = Field(ge=0)


class SliceMetrics(_Contract):
    recall_at_5: MetricValue
    recall_at_10: MetricValue
    mrr: MetricValue
    correct_refusal_rate: MetricValue
    false_refusal_rate: MetricValue


class ItemResult(_Contract):
    item_id: str
    language: Language
    category: Category
    split: Split
    answerable: bool
    refused: bool
    span_count: int = Field(ge=0)
    spans_hit_at_5: int = Field(ge=0)
    spans_hit_at_10: int = Field(ge=0)
    first_hit_rank: int | None = Field(default=None, ge=1)


class EvalReport(_Contract):
    schema_version: Literal[1] = 1
    run_id: str
    tier: Literal["smoke", "nightly", "live"]
    run_config_hash: str
    corpus_sha256: str | None = None
    golden_sha256: str
    golden_filter: GoldenFilter
    embedder_id: str | None = None
    embedder_version: int | None = None
    deployment_mode: str
    request_options: RagRunOptions
    k_values: list[int]
    overall: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_category: dict[str, SliceMetrics]
    by_language_category: dict[str, SliceMetrics]
    by_split: dict[str, SliceMetrics]
    items: list[ItemResult]
    notes: list[str] = Field(default_factory=list)
