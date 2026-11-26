from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.answers import CitationStrategy
from rag_sidecar.contracts.eval_run import GoldenFilter, RagRunOptions
from rag_sidecar.contracts.golden import Category, Language, Provenance, Split
from rag_sidecar.contracts.groundedness import GroundednessScorer
from rag_sidecar.contracts.latency import CacheState, GroupBudget, Profile, StageLatency
from rag_sidecar.contracts.omit import omit_none_schema


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class MetricValue(_Contract):
    value: float | None
    n: int = Field(ge=0)


QuestionKind = Literal["fact_lookup", "context_heavy", "other"]
ReportOnlyReason = Literal["native_review_pending"]
NativeReviewBacklogState = Literal["pending", "existing_unreviewed"]


def _omit_none(value: object) -> bool:
    return value is None


def _optional_metric() -> "MetricValue | None":
    return Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)  # type: ignore[return-value]


class SliceMetrics(_Contract):
    recall_at_5: MetricValue
    recall_at_10: MetricValue
    mrr: MetricValue
    correct_refusal_rate: MetricValue
    false_refusal_rate: MetricValue
    false_refusal_upper_95: float | None = Field(default=None, ge=0, le=1)
    ndcg_at_context_k: MetricValue | None = _optional_metric()
    k_zero: MetricValue | None = _optional_metric()
    topk_redundancy: MetricValue | None = _optional_metric()
    intent_coverage: MetricValue | None = _optional_metric()
    identifier_precision: MetricValue | None = _optional_metric()
    near_miss_leakage: MetricValue | None = _optional_metric()
    false_answer_rate: MetricValue | None = _optional_metric()


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
    report_only_reason: ReportOnlyReason | None = Field(
        default=None, exclude_if=lambda value: value is None, json_schema_extra=omit_none_schema
    )
    context_k: int | None = Field(default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    ndcg_at_context_k: float | None = Field(
        default=None, ge=0, le=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    group_count: int | None = Field(default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    topk_redundancy: float | None = Field(
        default=None, ge=0, le=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    intent_coverage: bool | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    identifier_precise: bool | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    near_miss_leak: bool | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)


class NativeReviewBacklogEntry(_Contract):
    """One item a native speaker still has to read (D-45, XLG-02 delta)."""

    item_id: str
    language: Language
    state: NativeReviewBacklogState


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


InjectionConfigLabel = Literal["all_off", "recommended", "tagging_only", "other"]


class InjectionReport(_Contract):
    config_label: InjectionConfigLabel
    items: int = Field(ge=0)
    exposure_rate: dict[str, MetricValue] = Field(default_factory=dict)
    attack_success_rate: dict[str, MetricValue] = Field(default_factory=dict)
    false_positive_rate: dict[str, MetricValue] = Field(default_factory=dict)
    rules_false_positive_count: int = Field(ge=0)
    gate: Literal["absolute_zero", "report_only"]


class TransformOutcomeCounts(_Contract):
    """Per transform: traces where it ran, was off by config, or was skipped, with the skip reasons (D-28, D-38)."""

    run: int = Field(default=0, ge=0)
    disabled: int = Field(default=0, ge=0)
    skipped: int = Field(default=0, ge=0)
    skip_reasons: dict[str, int] = Field(default_factory=dict)


BudgetStatus = Literal["within", "over", "no_budget"]


class BudgetedLatency(_Contract):
    latency: StageLatency
    status: BudgetStatus


class QueryLayerReport(_Contract):
    """D-29, D-38: what the query layer did; counts, rates and latencies only, never query text (T-06-73)."""

    items: int = Field(ge=0)
    items_with_plan: int = Field(ge=0)
    gate_rules: dict[str, int] = Field(default_factory=dict)
    transforms: dict[str, TransformOutcomeCounts] = Field(default_factory=dict)
    llm_transform_share: MetricValue
    protected_token_losses: int = Field(ge=0)
    budget_profile: Profile
    query_budget: GroupBudget | None = None
    query_latency: BudgetedLatency | None = None
    query_latency_by_language: dict[str, BudgetedLatency] = Field(default_factory=dict)
    query_latency_by_category: dict[str, BudgetedLatency] = Field(default_factory=dict)


class SemanticCacheReport(_Contract):
    """D-42 e, spec rule 8: cache checks, bypasses, hits and misses, hit versus miss latency, near-miss wrong hits."""

    checks: int = Field(ge=0)
    hits: int = Field(ge=0)
    misses: int = Field(ge=0)
    failures: int = Field(ge=0)
    bypasses: dict[str, int] = Field(default_factory=dict)
    hit_rate: MetricValue
    hit_latency: StageLatency | None = None
    miss_latency: StageLatency | None = None
    near_miss_checks: int = Field(ge=0)
    near_miss_wrong_hits: int = Field(ge=0)
    near_miss_wrong_hit_rate: MetricValue | None = None


TableAnswerVerdict = Literal["correct", "wrong", "ambiguous"]
TableSplitStatus = Literal["gated", "report_only"]


class TableSplitItemRow(_Contract):
    """One scored table_split item (D-46): where its row chunk ranks, whether that chunk holds the header, the answer verdict."""

    item_id: str
    language: Language
    split: Split
    counts_in_gate: bool
    row_rank: int | None = Field(default=None, ge=1)
    header_in_context: bool | None = None
    answer_verdict: TableAnswerVerdict | None = None


class TableSplitSlice(_Contract):
    """table_split metrics of one slice; answer_correct_rate is None when the run produced no answers (not run, never 0)."""

    status: TableSplitStatus
    items: int = Field(ge=0)
    counting_items: int = Field(ge=0)
    row_recall_at_5: MetricValue
    row_recall_at_10: MetricValue
    header_in_context_rate: MetricValue
    answer_correct_rate: MetricValue | None = None


class TableSplitReport(_Contract):
    """D-46, EVAL-18: row Recall@k, header_in_context_rate and the deterministic answer check for table_split items."""

    answer_mode: bool
    overall: TableSplitSlice
    by_language: dict[str, TableSplitSlice] = Field(default_factory=dict)
    items: list[TableSplitItemRow] = Field(default_factory=list)


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
    gate_population: Literal["all", "production", "real"] = "all"
    rag_mode: Literal["strict", "balanced", "flexible"] = "strict"
    golden_set_version: int | None = Field(default=None, ge=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    golden_manifest_sha256: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    stale_count: int = Field(default=0, ge=0)
    stale_share: float = Field(default=0.0, ge=0, le=1)
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
    injection: InjectionReport | None = None
    query_layer: QueryLayerReport | None = None
    semantic_cache: SemanticCacheReport | None = None
    notes: list[str] = Field(default_factory=list)
    native_review_backlog: list[NativeReviewBacklogEntry] | None = Field(
        default=None, exclude_if=lambda value: value is None, json_schema_extra=omit_none_schema
    )
    table_split: TableSplitReport | None = Field(
        default=None, exclude_if=lambda value: value is None, json_schema_extra=omit_none_schema
    )
    ttft: dict[CacheState, StageLatency] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    pre_generation: dict[Profile, StageLatency] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
