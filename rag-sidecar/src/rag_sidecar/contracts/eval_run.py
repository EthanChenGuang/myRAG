from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.answers import AnswerGroundedness, CitationRecord, CitationStrategy
from rag_sidecar.contracts.ingest import DocType
from rag_sidecar.contracts.omit import omit_default_schema, omit_none_schema
from rag_sidecar.contracts.query import QueryFramework, QueryParamsOverride, QueryPlan, QueryTransformToggles
from rag_sidecar.contracts.retrieval import (
    ChunkingProfile,
    RetrievalFilters,
    RetrievalOverrides,
    VectorBackend,
    VersionScope,
)


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


TraceCacheState = Literal["hit", "miss", "bypass"]


def _omit_none(value: object) -> bool:
    return value is None


def _optional_any_schema(schema: dict) -> None:
    schema.pop("default", None)
    branches = [branch for branch in schema.pop("anyOf", None) or [] if branch.get("type") != "null"]
    if len(branches) == 1:
        schema.update(branches[0])
    elif branches:
        schema["anyOf"] = branches


BINDING_PROFILE_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,63}$"
BindingProfileId = Annotated[str, Field(pattern=BINDING_PROFILE_ID_PATTERN)]


class ConversationTurn(_Contract):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


StageName = Literal[
    "refs",
    "analyze",
    "embed",
    "search",
    "legacy_rank",
    "post_filter",
    "assemble",
    "voice_keyword_fallback",
    "local_rerank",
    "injection_check",
    "query_gate",
    "condense",
    "normalize_dates",
    "expand",
    "hyde",
    "decompose",
    "terminology",
    "semantic_cache",
]

STAGE_COUNT = len(get_args(StageName))

SemanticCacheBackend = Literal["off", "pgvector", "redisvl"]

_TimeoutMs = Annotated[int, Field(ge=1, le=60000)]


class StageTimeoutsMs(_Contract):
    refs: _TimeoutMs | None = None
    analyze: _TimeoutMs | None = None
    embed: _TimeoutMs | None = None
    search: _TimeoutMs | None = None
    legacy_rank: _TimeoutMs | None = None
    post_filter: _TimeoutMs | None = None
    assemble: _TimeoutMs | None = None
    voice_keyword_fallback: _TimeoutMs | None = None
    local_rerank: _TimeoutMs | None = None
    injection_check: _TimeoutMs | None = None
    query_gate: _TimeoutMs | None = None
    condense: _TimeoutMs | None = None
    normalize_dates: _TimeoutMs | None = None
    expand: _TimeoutMs | None = None
    hyde: _TimeoutMs | None = None
    decompose: _TimeoutMs | None = None
    terminology: _TimeoutMs | None = None
    semantic_cache: _TimeoutMs | None = None


class RagRunOptions(_Contract):
    max_results: int | None = Field(default=None, ge=1, le=100)
    organization_id: str | None = None
    user_id: str | None = None
    generator_model: str | None = None
    degrade: Literal["drop_top_candidate"] | None = None
    disabled_stages: list[StageName] | None = Field(default=None, max_length=STAGE_COUNT)
    stage_timeouts_ms: StageTimeoutsMs | None = None
    embedding_profile: str | None = None
    retrieval_overrides: RetrievalOverrides | None = None
    retrieval_filters: RetrievalFilters | None = None
    citations: bool = False
    groundedness: bool = False
    query_framework: QueryFramework | None = None
    query_layer: bool | None = None
    query_transforms: QueryTransformToggles | None = None
    semantic_cache: SemanticCacheBackend | None = None
    query_params: QueryParamsOverride | None = None
    cache_seed_answer: str | None = Field(default=None, min_length=1, max_length=4000)
    embedding_bindings: dict[DocType, BindingProfileId] | None = Field(default=None, max_length=6)
    domain_control_leg: DocType | None = None


class RagRunRequest(_Contract):
    schema_version: Literal[1] = 1
    item_id: str | None = None
    query: str = Field(min_length=1, max_length=4000)
    conversation: list[ConversationTurn] = Field(default_factory=list)
    rag_mode: Literal["strict", "balanced", "flexible"] = "strict"
    web_search: Literal[False] = False
    options: RagRunOptions = Field(default_factory=RagRunOptions)
    include_answer: bool = False


class TraceQueryContext(_Contract):
    is_temporal_query: bool
    is_financial_query: bool
    required_precision: Literal["low", "medium", "high", "exact"]
    suggested_threshold: float
    search_strategy: Literal["semantic_only", "temporal_boost", "exact_match", "multi_stage"]


class TraceCandidate(_Contract):
    rank: int = Field(ge=1)
    chunk_id: str
    document_id: str
    document_name: str | None = None
    content: str
    similarity: float
    final_score: float | None = None
    match_reason: str | None = None
    has_image: bool
    rerank_score: float | None = None
    fused_score: float | None = None
    language: str | None = None
    legs: dict[str, int] = Field(default_factory=dict)


class TraceKeptChunk(_Contract):
    rank: int = Field(ge=1)
    chunk_id: str
    document_id: str
    document_name: str
    content: str
    similarity: float
    kept_by: Literal["similarity", "name", "image", "rerank", "fused"]
    dup_cluster_id: str | None = Field(
        default=None, min_length=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    document_version: int | None = Field(
        default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    is_current: bool | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    identifiers_norm: list[Annotated[str, Field(min_length=1, max_length=200)]] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    variant_index: int | None = Field(default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema)


class TraceUsedDocument(_Contract):
    document_id: str
    name: str
    similarity: float | None = None
    image_url: str | None = None


TraceTransformName = Literal["condense", "normalize_dates", "expand", "hyde", "decompose", "translate"]
TraceTransformStatus = Literal["ok", "skipped", "disabled", "degraded", "error", "timeout", "aborted"]


class TraceQueryTransform(_Contract):
    kind: str
    text: str
    transform: TraceTransformName | None = None
    status: TraceTransformStatus | None = None
    reason: str | None = Field(default=None, max_length=64)


TraceCitation = CitationRecord


class TraceRetrievalVersions(_Contract):
    lexical: int = Field(ge=0)
    rerank_text: int = Field(ge=0)


class TraceRefusal(_Contract):
    decision: Literal["refuse", "answer", "not_applied"]
    basis: str
    reason: str
    top_score: float | None = None
    threshold: float | None = None
    cell_key: str | None = None


class TraceSecurityVersions(_Contract):
    rules_version: str = Field(min_length=1)
    detectors_version: str = Field(min_length=1)


class TraceEffectiveConfig(_Contract):
    rag_env: dict[str, str]
    rag_prompt_sha256: dict[str, str]
    deployment_mode: str
    embedding_model: str
    endpoint_version: str
    generator_model: str | None = None
    security: TraceSecurityVersions | None = None


InjectionCheckMode = Literal["flag", "drop", "downweight"]


class TraceInjectionChecked(_Contract):
    chunk_id: str = Field(min_length=1)
    document: str


class TraceInjectionFlagged(_Contract):
    chunk_id: str = Field(min_length=1)
    document: str
    detectors: list[str] = Field(min_length=1)
    rule_ids: list[str] = Field(default_factory=list)


class TraceInjection(_Contract):
    mode: InjectionCheckMode
    checked: list[TraceInjectionChecked] = Field(default_factory=list)
    flagged: list[TraceInjectionFlagged] = Field(default_factory=list)
    dropped: list[str] = Field(default_factory=list)
    downweighted: list[str] = Field(default_factory=list)
    detectors_unavailable: list[str] = Field(default_factory=list)


BackendFallbackReason = Literal["backend_not_ready", "backend_error", "backend_slow", "filter_unsupported"]


class TraceRetrievalBackend(_Contract):
    backend: VectorBackend
    fallback_reason: BackendFallbackReason | None = None
    tenant_validation_dropped: int = Field(default=0, ge=0)


RefusalReason = Literal[
    "no_relevant_context", "below_threshold", "below_similarity_floor", "injection_filtered", "identifier_not_found"
]


class TraceIdentifier(_Contract):
    """D-31, T-04.2-04: identifier filter counts and at most 3 suggestions from the caller's tenant."""

    asked: int = Field(ge=0)
    resolved: int = Field(ge=0)
    near_miss_dropped: int = Field(default=0, ge=0)
    fallback: bool = False
    suggestions: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(default_factory=list, max_length=3)


class TraceAttributeFilter(_Contract):
    """Phase 3.3 D-29, D-30, F-25: attribute filter counts and flags; never an attribute key or value."""

    mode: Literal["hard", "soft"]
    explicit: bool
    matched_attributes: int = Field(ge=0)
    resolved_documents: int = Field(ge=0)
    applied: bool
    fallback: bool
    too_broad: bool


class RagTrace(_Contract):
    schema_version: Literal[1] = 1
    item_id: str | None = None
    query: str
    query_context: TraceQueryContext
    retrieval_strategy: str
    query_transforms: list[TraceQueryTransform] = Field(default_factory=list)
    query_plan: QueryPlan | None = None
    candidates: list[TraceCandidate]
    kept: list[TraceKeptChunk]
    used_documents: list[TraceUsedDocument]
    context: str
    refused: bool
    refusal_reason: RefusalReason | None = None
    query_language: str | None = None
    retrieval_versions: TraceRetrievalVersions | None = None
    refusal: TraceRefusal | None = None
    retrieval_config_hash: str | None = None
    context_tokens: int | None = Field(default=None, ge=0)
    stage_counts: dict[str, dict[str, float]] = Field(default_factory=dict)
    answer: str | None = None
    citations: list[CitationRecord]
    citation_strategy: CitationStrategy | None = None
    invalid_citations: int = Field(default=0, ge=0)
    groundedness: AnswerGroundedness | None = None
    injection: TraceInjection | None = None
    retrieval_backend: TraceRetrievalBackend | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=omit_none_schema,
    )
    stage_latency_ms: dict[str, float]
    stage_status: dict[str, str] = Field(default_factory=dict)
    effective_config: TraceEffectiveConfig
    config_hash: str
    ttft_ms: float | None = Field(default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    pre_generation_ms: float | None = Field(
        default=None, ge=0, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    cache: TraceCacheState | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    version_scope: VersionScope | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=_optional_any_schema
    )
    topk_redundancy: float | None = Field(
        default=None, ge=0, le=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    identifier: TraceIdentifier | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    attribute_filter: TraceAttributeFilter | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )


class RunEmbedder(_Contract):
    id: str
    version: str
    source_sha256: str


class GoldenFilter(_Contract):
    review_statuses: list[Literal["approved", "draft"]] = Field(min_length=1)
    gate_split: Literal["dev"]


class RunConfigRecord(_Contract):
    name: str = Field(min_length=1)
    env: dict[str, str] = Field(default_factory=dict)
    overrides: RetrievalOverrides | None = None
    chunking_profiles: list[ChunkingProfile] = Field(default_factory=list)


class RunManifest(_Contract):
    schema_version: Literal[1] = 1
    run_id: str
    tier: Literal["smoke", "nightly", "live"]
    created_at: str
    git_sha: str | None = None
    deployment_mode: str
    embedder: RunEmbedder | None = None
    corpus_sha256: str | None = None
    golden_path: str
    golden_sha256: str
    golden_filter: GoldenFilter
    sql_sha256: dict[str, str]
    request_options: RagRunOptions
    embedding_profile: str | None = None
    effective_config_hash: str
    run_config_hash: str
    item_count: int = Field(ge=0)
    edge_errors: int = Field(ge=0)
    run_config: RunConfigRecord | None = None
    rag_mode: Literal["strict", "balanced", "flexible"] = Field(
        default="strict", exclude_if=lambda value: value == "strict", json_schema_extra=omit_default_schema
    )
