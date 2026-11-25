from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.answers import CitationStrategy
from rag_sidecar.contracts.eval_run import GoldenFilter, RagRunOptions
from rag_sidecar.contracts.golden import Category, Language, Provenance, Split
from rag_sidecar.contracts.groundedness import GroundednessScorer
from rag_sidecar.contracts.latency import StageLatency


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MetricValue(_Contract):
    value: float | None
    n: int = Field(ge=0)


QuestionKind = Literal["fact_lookup", "context_heavy", "other"]


class SliceMetrics(_Contract):
    recall_at_5: MetricValue
    recall_at_10: MetricValue
    mrr: MetricValue
    correct_refusal_rate: MetricValue
    false_refusal_rate: MetricValue
    false_refusal_upper_95: float | None = Field(default=None, ge=0, le=1)


class ItemResult(_Contract):
    item_id: str
    language: Language
    category: Category
    evidence_language: Language | None = None
    split: Split
    provenance: Provenance
    answerable: bool
    refused: bool
    span_count: int = Field(ge=0)
    spans_hit_at_5: int = Field(ge=0)
    spans_hit_at_10: int = Field(ge=0)
    first_hit_rank: int | None = Field(default=None, ge=1)
    doc_type: str | None = None
    question_kind: QuestionKind | None = None
    rerank_status: str | None = None
    lexical_hit_at_10: bool | None = None


StrategyKey = CitationStrategy | Literal["none"]
ScoringScorer = Literal["hhem_2_3_vectara", "hhem_2_1_open"]


class GroundednessLabelCounts(_Contract):
    verified: int = Field(default=0, ge=0)
    possibly_unreliable: int = Field(default=0, ge=0)
    not_checked: int = Field(default=0, ge=0)


class StrategySlice(_Contract):
    items: int = Field(ge=0)
    invalid_citation_rate: MetricValue | None = None
    citation_coverage: MetricValue | None = None
    cited_gold_hit: MetricValue | None = None
    raw_invalid_markers: int | None = Field(default=None, ge=0)
    generation_latency: StageLatency | None = None
    faithfulness: MetricValue | None = None


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
    embedder_source_sha256: str | None = None
    deployment_mode: str
    request_options: RagRunOptions
    k_values: list[int]
    overall: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_category: dict[str, SliceMetrics]
    by_language_category: dict[str, SliceMetrics]
    by_language_pair: dict[str, SliceMetrics] = Field(default_factory=dict)
    by_doc_type: dict[str, SliceMetrics] = Field(default_factory=dict)
    by_question_kind: dict[str, SliceMetrics] = Field(default_factory=dict)
    by_split: dict[str, SliceMetrics]
    by_provenance: dict[str, SliceMetrics] = Field(default_factory=dict)
    by_provenance_category: dict[str, SliceMetrics] = Field(default_factory=dict)
    gate_population: Literal["all", "production"] = "all"
    rerank_skipped_rate: MetricValue | None = None
    lexical_leg_hit_rate_at_10: MetricValue | None = None
    items: list[ItemResult]
    latency: dict[str, StageLatency] | None = None
    invalid_citation_rate: MetricValue | None = None
    citation_coverage: MetricValue | None = None
    cited_gold_hit: MetricValue | None = None
    raw_invalid_markers: int | None = Field(default=None, ge=0)
    groundedness_labels: dict[GroundednessScorer, dict[str, GroundednessLabelCounts]] = Field(default_factory=dict)
    groundedness_latency: dict[ScoringScorer, StageLatency] = Field(default_factory=dict)
    by_strategy: dict[StrategyKey, StrategySlice] = Field(default_factory=dict)
    notes: list[str] = Field(default_factory=list)
