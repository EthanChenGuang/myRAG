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
    generator_model: str | None = None


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


class TraceKeptChunk(_Contract):
    rank: int = Field(ge=1)
    chunk_id: str
    document_id: str
    document_name: str
    content: str
    similarity: float
    kept_by: Literal["similarity", "name", "image"]


class TraceUsedDocument(_Contract):
    document_id: str
    name: str
    similarity: float | None = None
    image_url: str | None = None


class TraceQueryTransform(_Contract):
    kind: str
    text: str


class TraceCitation(_Contract):
    document_id: str
    chunk_id: str | None = None


class TraceEffectiveConfig(_Contract):
    rag_env: dict[str, str]
    rag_prompt_sha256: dict[str, str]
    deployment_mode: str
    embedding_model: str
    endpoint_version: str
    generator_model: str | None = None


class RagTrace(_Contract):
    schema_version: Literal[1] = 1
    item_id: str | None = None
    query: str
    query_context: TraceQueryContext
    retrieval_strategy: str
    query_transforms: list[TraceQueryTransform] = Field(default_factory=list)
    candidates: list[TraceCandidate]
    kept: list[TraceKeptChunk]
    used_documents: list[TraceUsedDocument]
    context: str
    refused: bool
    refusal_reason: Literal["no_relevant_context"] | None = None
    answer: str | None = None
    citations: list[TraceCitation]
    stage_latency_ms: dict[str, float]
    stage_status: dict[str, str] = Field(default_factory=dict)
    effective_config: TraceEffectiveConfig
    config_hash: str


class RunEmbedder(_Contract):
    id: str
    version: str
    source_sha256: str


class GoldenFilter(_Contract):
    review_statuses: list[Literal["approved", "draft"]] = Field(min_length=1)
    gate_split: Literal["dev"]


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
    effective_config_hash: str
    run_config_hash: str
    item_count: int = Field(ge=0)
    edge_errors: int = Field(ge=0)
