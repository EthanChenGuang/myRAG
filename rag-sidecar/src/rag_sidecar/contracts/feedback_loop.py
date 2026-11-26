"""Feedback-loop contracts (Phase 5.1.1 D-03 to D-25, D-03a, D-29).

Shapes for the retrieval log, the feedback request bodies, the review queue and expert labels, the hand-off
files to Phases 4.1.1 and 6.1, mining, the loop statistics, the weekly and failure reports, the gate population
and the ship check. Report contracts carry counts, ids, hashes and codes only, never question, answer or chunk text.
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN
from rag_sidecar.contracts.config_change import WeeklyGatesSection
from rag_sidecar.contracts.golden import (
    ITEM_ID_PATTERN,
    UNANSWERABLE_CATEGORIES,
    UUID_PATTERN,
    Category,
    Language,
    Split,
)
from rag_sidecar.contracts.omit import OmitNoneModel, omit_none_schema

LANGUAGE_CODE_PATTERN = r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$"
REVIEW_TAG_PATTERN = r"^[a-z_]{1,32}$"
REASON_CODE_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"
SHA256_PATTERN = r"^[a-f0-9]{64}$"
TENANT_HASH_PATTERN = r"^[a-f0-9]{8,64}$"

UuidStr = Annotated[str, Field(pattern=UUID_PATTERN)]
LanguageCode = Annotated[str, Field(pattern=LANGUAGE_CODE_PATTERN)]
ReviewTag = Annotated[str, Field(pattern=REVIEW_TAG_PATTERN)]
ReasonCode = Annotated[str, Field(pattern=REASON_CODE_PATTERN)]
Sha256Hex = Annotated[str, Field(pattern=SHA256_PATTERN)]
TenantKey = Annotated[str, Field(pattern=TENANT_KEY_PATTERN)]
TenantHash = Annotated[str, Field(pattern=TENANT_HASH_PATTERN)]
ChunkId = Annotated[str, Field(min_length=1, max_length=128)]
Timestamp = Annotated[str, Field(min_length=1, max_length=64)]
Count = Annotated[int, Field(ge=0)]
Rate = Annotated[float, Field(ge=0, le=1)]

Channel = Literal["chat", "embed", "voice"]
LogPipeline = Literal["legacy", "v2"]
LogStatus = Literal["ok", "empty", "error", "degraded"]
LogOutcome = Literal["answered", "refused_no_context", "kb_unavailable", "degraded_answer", "unknown"]
LogRagMode = Literal["strict", "balanced", "flexible", "bypass"]
FeedbackKind = Literal["answer", "refusal", "embed"]
RefusalVote = Literal["expected_answer", "correct_refusal"]
RefusalFeedbackReason = Literal["answer_exists", "wrong_language", "other"]
EmbedVote = Literal["helpful", "not_helpful"]
EmbedFeedbackReason = Literal["wrong", "incomplete", "not_relevant"]
LoggedFeedbackReason = Literal[
    "wrong",
    "incomplete",
    "not_from_documents",
    "bad_citation",
    "not_relevant",
    "answer_exists",
    "wrong_language",
    "other",
]
MiningReason = Literal[
    "feedback_negative",
    "refusal_disputed",
    "groundedness_flagged",
    "refused_high_score",
    "zero_results",
    "low_score",
    "no_source_opened",
]
ReviewItemStatus = Literal["open", "labelled", "skipped", "exported"]
Triage = Literal["dictionary", "training", "golden", "kb_gap", "not_a_failure"]
DictionaryRelation = Literal["synonym", "abbreviation", "translation", "misspelling"]
TrainingSplit = Literal["train", "held_out"]
FailureLayer = Literal["retrieval", "rerank_or_assembly", "refusal", "generation", "groundedness", "injection"]
GatePopulation = Literal["all", "production", "real"]
RealProvenance = Literal["production", "human", "historical"]

MAX_LOG_CANDIDATES = 50
MAX_QUERY_CHARS = 2000


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _no_repeats(values: list[Any], what: str) -> list[Any]:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    return values


def _unique(**kwargs: Any) -> Any:
    return Field(json_schema_extra={"uniqueItems": True}, **kwargs)


class _LanguageSnapshot(_Contract):
    """D-03a language fields: codes only, never text; `und` is the code for undetermined."""

    query_language: LanguageCode | None = None
    query_language_confidence: float | None = Field(default=None, ge=0, le=1)
    chunk_languages: list[LanguageCode] = _unique(default_factory=list)
    answer_language: LanguageCode | None = None

    @field_validator("chunk_languages")
    @classmethod
    def _distinct_chunk_languages(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "chunk_languages")


class RetrievalLogCandidate(OmitNoneModel):
    _omit_when_none = ("rerank_score", "fused_score", "language")

    chunk_id: ChunkId
    document_id: UuidStr
    rank: int = Field(ge=1)
    similarity: float
    rerank_score: float | None = Field(default=None, json_schema_extra=omit_none_schema)
    fused_score: float | None = Field(default=None, json_schema_extra=omit_none_schema)
    kept: bool
    language: LanguageCode | None = Field(default=None, json_schema_extra=omit_none_schema)


class RetrievalLogEntry(_LanguageSnapshot):
    id: UuidStr | None = None
    trace_id: str = Field(min_length=1, max_length=128)
    user_id: UuidStr | None = None
    organization_id: UuidStr | None = None
    chat_id: UuidStr | None = None
    answer_id: UuidStr | None = None
    tenant_key: TenantKey | None = None
    channel: Channel
    rag_mode: LogRagMode | None = None
    pipeline: LogPipeline
    retrieval_config_hash: str | None = Field(default=None, max_length=128)
    query_masked: str | None = Field(default=None, max_length=MAX_QUERY_CHARS)
    query_fingerprint: Sha256Hex | None = None
    status: LogStatus
    refusal_decision: str | None = Field(default=None, max_length=64)
    refusal_reason: str | None = Field(default=None, max_length=64)
    outcome: LogOutcome
    candidates: list[RetrievalLogCandidate] = Field(default_factory=list, max_length=MAX_LOG_CANDIDATES)
    candidate_count: Count
    top_score: float | None = None
    latency_ms: Count
    stage_latency: dict[str, Annotated[float, Field(ge=0)]] = Field(default_factory=dict)
    feedback_vote: Literal[-1, 1] | None = None
    feedback_kind: FeedbackKind | None = None
    feedback_reasons: list[LoggedFeedbackReason] = _unique(default_factory=list)
    feedback_at: Timestamp | None = None
    source_opened_count: int = Field(default=0, ge=0, le=20)
    created_at: Timestamp | None = None

    @field_validator("feedback_reasons")
    @classmethod
    def _distinct_reasons(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "feedback_reasons")

    @model_validator(mode="after")
    def _check_rules(self) -> "RetrievalLogEntry":
        if (self.query_masked is None) != (self.query_fingerprint is None):
            raise ValueError("query_masked and query_fingerprint are both set or both null")
        if (self.feedback_vote is None) != (self.feedback_kind is None):
            raise ValueError("feedback_vote and feedback_kind are both set or both null")
        return self


class RefusalFeedbackRequest(_Contract):
    vote: RefusalVote
    reasons: list[RefusalFeedbackReason] = _unique(default_factory=list, max_length=3)

    @field_validator("reasons")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "reasons")


class EmbedFeedbackRequest(_Contract):
    token: str = Field(min_length=1, max_length=4096)
    vote: EmbedVote
    reasons: list[EmbedFeedbackReason] = _unique(default_factory=list, max_length=3)

    @field_validator("reasons")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "reasons")


class SourceSignalRequest(_Contract):
    kind: Literal["source_opened"]


class ExpertEvidenceSpan(_Contract):
    chunk_id: ChunkId
    document_id: UuidStr
    document_name: str = Field(min_length=1, max_length=512)
    section: str = Field(max_length=512)
    quote: str = Field(min_length=2, max_length=2000)


class DictionaryTerm(_Contract):
    observed_term: str = Field(min_length=1, max_length=200)
    canonical_term: str = Field(min_length=1, max_length=200)
    relation: DictionaryRelation
    canonical_language: LanguageCode | None = Field(
        default=None, description="Target language of canonical_term; required when relation is translation."
    )

    @model_validator(mode="after")
    def _translation_needs_language(self) -> "DictionaryTerm":
        if self.relation == "translation" and self.canonical_language is None:
            raise ValueError("a translation needs canonical_language")
        return self


class ExpertLabel(_Contract):
    """D-18 label. A later contract version may add optional fields with defaults; unknown keys stay forbidden."""

    answerable: bool
    category: Category
    language: Language
    expected_answer: str | None = Field(default=None, max_length=4000)
    evidence: list[ExpertEvidenceSpan] = Field(default_factory=list, max_length=20)
    triage: list[Triage] = _unique(min_length=1)
    not_relevant_chunk_ids: list[ChunkId] = _unique(default_factory=list, max_length=50)
    dictionary_terms: list[DictionaryTerm] = Field(default_factory=list, max_length=20)
    paraphrased_question: str | None = Field(default=None, min_length=1, max_length=1000)
    pii_checked: bool = False
    confirm_near_duplicate_of: str | None = Field(default=None, pattern=ITEM_ID_PATTERN)

    @field_validator("triage", "not_relevant_chunk_ids")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "triage and not_relevant_chunk_ids entries")

    @model_validator(mode="after")
    def _check_rules(self) -> "ExpertLabel":
        if (self.category in UNANSWERABLE_CATEGORIES) == self.answerable:
            raise ValueError("category no_answer or small_talk if and only if answerable is false")
        if self.answerable:
            if not (self.expected_answer and self.expected_answer.strip()):
                raise ValueError("an answerable label needs a non-empty expected_answer")
            if not self.evidence:
                raise ValueError("an answerable label needs at least one evidence span")
        elif self.evidence:
            raise ValueError("a label that is not answerable carries no evidence")
        if "golden" in self.triage and not self.pii_checked:
            raise ValueError("golden triage requires pii_checked true")
        if "dictionary" in self.triage and not self.dictionary_terms:
            raise ValueError("dictionary triage requires at least one dictionary term")
        cited = {span.chunk_id for span in self.evidence}
        if cited & set(self.not_relevant_chunk_ids):
            raise ValueError("a chunk cited as evidence cannot be marked not relevant")
        if len({(span.chunk_id, span.quote) for span in self.evidence}) != len(self.evidence):
            raise ValueError("evidence contains identical spans")
        return self


class ReviewItem(_LanguageSnapshot):
    """D-14 queue row as the review routes return it; the snapshot survives the log purge."""

    id: UuidStr
    tenant_key: TenantKey
    retrieval_log_id: UuidStr | None = None
    trace_id: str = Field(min_length=1, max_length=128)
    query_masked: str | None = Field(default=None, max_length=MAX_QUERY_CHARS)
    answer_masked: str | None = Field(default=None, max_length=20000)
    channel: Channel
    outcome: LogOutcome
    candidates: list[RetrievalLogCandidate] = Field(default_factory=list, max_length=MAX_LOG_CANDIDATES)
    retrieval_config_hash: str | None = Field(default=None, max_length=128)
    reasons: list[MiningReason] = _unique(default_factory=list)
    occurrences: int = Field(default=1, ge=1)
    tags: list[ReviewTag] = Field(default_factory=list)
    status: ReviewItemStatus
    triage: list[Triage] = _unique(default_factory=list)
    label: ExpertLabel | None = None
    labelled_by: UuidStr | None = None
    labelled_at: Timestamp | None = None
    split: Split | None = None
    split_group: str | None = Field(default=None, min_length=1, max_length=128)
    mining_window: str | None = Field(default=None, max_length=64)
    mined_at: Timestamp
    expires_at: Timestamp | None = None

    @field_validator("reasons", "triage")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "reasons and triage entries")


class ReviewItemListResponse(_Contract):
    items: list[ReviewItem] = Field(max_length=50)
    next_cursor: str | None = Field(default=None, max_length=256)


class DictionaryCandidate(_Contract):
    """D-17 hand-off to Phase 4.1.1 (TERM-12): canonical_language is the target language of a translation."""

    tenant_key: TenantKey
    language: LanguageCode
    observed_term: str = Field(min_length=1, max_length=200)
    canonical_term: str = Field(min_length=1, max_length=200)
    relation: DictionaryRelation
    canonical_language: LanguageCode | None = Field(
        default=None, description="Target language of canonical_term; required when relation is translation."
    )
    example_review_item_ids: list[UuidStr] = _unique(min_length=1, max_length=20)
    occurrences: int = Field(ge=1)

    @field_validator("example_review_item_ids")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "example_review_item_ids")

    @model_validator(mode="after")
    def _translation_needs_language(self) -> "DictionaryCandidate":
        if self.relation == "translation" and self.canonical_language is None:
            raise ValueError("a translation needs canonical_language")
        return self


class TrainingPositive(_Contract):
    chunk_id: ChunkId
    document_id: UuidStr
    quote: str = Field(min_length=2, max_length=2000)


class TrainingNegative(_Contract):
    chunk_id: ChunkId
    document_id: UuidStr
    rank: int = Field(ge=1)
    score: float
    confirmed: bool = Field(
        description=(
            "true only when the domain expert marked this candidate not relevant; "
            "Phase 6.1 uses confirmed negatives first"
        )
    )


class TrainingPair(_Contract):
    """D-17 hand-off to Phase 6.1: ids only, no chunk text; held_out pairs must never be trained on."""

    tenant_key: TenantKey
    query_masked: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    language: LanguageCode
    positive: TrainingPositive
    hard_negatives: list[TrainingNegative] = Field(default_factory=list, max_length=10)
    document_group: str = Field(min_length=1, max_length=128)
    split: TrainingSplit
    source: Literal["production_feedback"]
    review_item_id: UuidStr

    @model_validator(mode="after")
    def _check_negatives(self) -> "TrainingPair":
        ids = [negative.chunk_id for negative in self.hard_negatives]
        if len(ids) != len(set(ids)):
            raise ValueError("hard negatives must not repeat a chunk")
        if self.positive.chunk_id in ids:
            raise ValueError("the positive chunk cannot be a hard negative")
        return self


class ScoreThresholds(_Contract):
    similarity: float = Field(ge=-1, le=1)
    rerank: float


class FeedbackMiningConfig(_Contract):
    """D-13 thresholds per scorer kind; reported, never tuned automatically."""

    schema_version: Literal[1] = 1
    per_tenant_limit: int = Field(default=50, ge=1, le=500)
    window_days: int = Field(default=7, ge=1, le=31)
    low_score_ceiling: ScoreThresholds
    refused_high_score_floor: ScoreThresholds
    open_item_ttl_days: int = Field(default=90, ge=1, le=365)


class MiningReasonCounts(_Contract):
    feedback_negative: Count = 0
    refusal_disputed: Count = 0
    groundedness_flagged: Count = 0
    refused_high_score: Count = 0
    zero_results: Count = 0
    low_score: Count = 0
    no_source_opened: Count = 0


class MiningTenantResult(_Contract):
    tenant_hash: TenantHash
    inserted: Count
    by_reason: MiningReasonCounts


class MiningRunResult(_Contract):
    schema_version: Literal[1] = 1
    status: Literal["completed", "disabled"]
    disabled_reason: ReasonCode | None = None
    since: Timestamp
    until: Timestamp
    config_sha256: Sha256Hex | None = None
    purged_log_rows: Count = 0
    purged_review_items: Count = 0
    total_inserted: Count = 0
    tenants: list[MiningTenantResult] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_status(self) -> "MiningRunResult":
        if self.status == "disabled":
            if self.disabled_reason is None:
                raise ValueError("a disabled run names its reason")
            if self.tenants or self.total_inserted:
                raise ValueError("a disabled run inserts nothing")
        else:
            if self.disabled_reason is not None:
                raise ValueError("a completed run has no disabled_reason")
            if self.config_sha256 is None:
                raise ValueError("a completed run records the config sha256")
            if self.total_inserted != sum(tenant.inserted for tenant in self.tenants):
                raise ValueError("total_inserted must equal the sum over tenants")
        return self


class ChannelCounts(_Contract):
    chat: Count = 0
    embed: Count = 0
    voice: Count = 0


class OutcomeCounts(_Contract):
    answered: Count = 0
    refused_no_context: Count = 0
    kb_unavailable: Count = 0
    degraded_answer: Count = 0
    unknown: Count = 0


class VoteCounts(_Contract):
    answer_up: Count = 0
    answer_down: Count = 0
    refusal_up: Count = 0
    refusal_down: Count = 0
    embed_up: Count = 0
    embed_down: Count = 0


class TriageCounts(_Contract):
    dictionary: Count = 0
    training: Count = 0
    golden: Count = 0
    kb_gap: Count = 0
    not_a_failure: Count = 0


class TenantLoopStats(_Contract):
    tenant_hash: TenantHash
    retrievals: Count
    retrievals_by_channel: ChannelCounts
    outcomes: OutcomeCounts
    refusal_rate: Rate | None = None
    zero_result_rate: Rate | None = None
    low_score_rate: Rate | None = None
    votes: VoteCounts
    thumbs_down_rate: Rate | None = None
    refusal_disputes: Count = 0
    source_open_rate: Rate | None = None
    items_mined: Count = 0
    items_labelled: Count = 0
    items_skipped: Count = 0
    items_exported: Count = 0
    triage: TriageCounts


class FeedbackLoopStats(_Contract):
    schema_version: Literal[1] = 1
    since: Timestamp
    until: Timestamp
    tenants: list[TenantLoopStats] = Field(default_factory=list)


class FailureEntry(_Contract):
    item_id: str = Field(pattern=ITEM_ID_PATTERN)
    run_id: str = Field(min_length=1, max_length=128)
    layer: FailureLayer
    category: Category
    language: LanguageCode | None = None
    domain_set: TenantHash | None = None


class LayerCounts(_Contract):
    retrieval: Count = 0
    rerank_or_assembly: Count = 0
    refusal: Count = 0
    generation: Count = 0
    groundedness: Count = 0
    injection: Count = 0


class FailureReport(_Contract):
    """Phase 7 D-23 failure report, taken over by Phase 5.1.1 D-02: ids and codes only."""

    schema_version: Literal[1] = 1
    generated_at: Timestamp
    since: Timestamp
    run_ids: list[str] = Field(default_factory=list)
    previous_report_sha256: Sha256Hex | None = None
    by_layer: LayerCounts
    entries: list[FailureEntry] = Field(default_factory=list)

    @model_validator(mode="after")
    def _counts_match(self) -> "FailureReport":
        if sum(self.by_layer.model_dump().values()) != len(self.entries):
            raise ValueError("by_layer counts must sum to the number of entries")
        return self


class EvalTrendPoint(_Contract):
    domain_set: TenantHash
    run_id: str = Field(min_length=1, max_length=128)
    started_at: Timestamp
    gate_population: GatePopulation
    config_hash: str | None = Field(default=None, max_length=128)
    manifest_hash: Sha256Hex | None = None
    recall_at_5: Rate | None = None
    recall_at_10: Rate | None = None
    mrr: Rate | None = None
    correct_refusal_rate: Rate | None = None
    false_refusal_rate: Rate | None = None


class WeeklyReport(_Contract):
    schema_version: Literal[1] = 1
    generated_at: Timestamp
    since: Timestamp
    until: Timestamp
    stats: FeedbackLoopStats | None = None
    stats_skipped_reason: ReasonCode | None = None
    trend: list[EvalTrendPoint] = Field(default_factory=list)
    failures: FailureReport | None = None
    gates: WeeklyGatesSection | None = Field(
        default=None, exclude_if=lambda value: value is None, json_schema_extra=omit_none_schema
    )

    @model_validator(mode="after")
    def _stats_or_reason(self) -> "WeeklyReport":
        if (self.stats is None) == (self.stats_skipped_reason is None):
            raise ValueError("a weekly report has either stats or stats_skipped_reason")
        return self


class GatePopulationConfig(_Contract):
    """D-23. The provenances that count as real are named here and in the GoldenItem Provenance Literal only."""

    mode: Literal["legacy", "real"] = "legacy"
    provenances: list[RealProvenance] = _unique(default_factory=lambda: ["production", "human"], min_length=1)
    min_items: int = Field(default=100, ge=1)

    @field_validator("provenances")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "provenances")


class ShipCheckResult(_Contract):
    """D-24 ship rule result; passed exactly when no reason code is listed."""

    schema_version: Literal[1] = 1
    passed: bool
    reasons: list[ReasonCode] = _unique(default_factory=list)
    target_metric: str = Field(pattern=r"^[a-z][a-z0-9_@.]{0,63}$")
    target_delta: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    resamples: int = Field(default=10000, ge=1)
    seed: int = 0
    baseline_hash: Sha256Hex
    candidate_hash: Sha256Hex
    manifest_hash: Sha256Hex | None = None
    gate_population: GatePopulation

    @field_validator("reasons")
    @classmethod
    def _distinct(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "reasons")

    @model_validator(mode="after")
    def _passed_iff_no_reason(self) -> "ShipCheckResult":
        if self.passed == bool(self.reasons):
            raise ValueError("passed is true exactly when reasons is empty")
        if self.ci_low is not None and self.ci_high is not None and self.ci_low > self.ci_high:
            raise ValueError("ci_low must not exceed ci_high")
        return self
