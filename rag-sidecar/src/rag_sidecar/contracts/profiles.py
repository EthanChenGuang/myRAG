from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from rag_sidecar.contracts.cache import TENANT_KEY_PATTERN
from rag_sidecar.contracts.eval_run import BindingProfileId
from rag_sidecar.contracts.golden import Provenance
from rag_sidecar.contracts.ingest import DocType
from rag_sidecar.contracts.report import MetricValue, SliceMetrics


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ComparisonSliceBlock(_Contract):
    overall: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_category: dict[str, SliceMetrics]
    by_language_pair: dict[str, SliceMetrics]


class ProfileMetricBlocks(_Contract):
    gated: ComparisonSliceBlock
    candidates: ComparisonSliceBlock


ServingMode = Literal["hosted", "sidecar"]
NonNegative = Annotated[float, Field(ge=0)]


class ServingModeMeasurement(_Contract):
    """Throughput, query latency and cost of one serving mode of a profile; every figure is null while the mode was not measured."""

    mode: ServingMode
    measured: bool
    source: str | None = None
    ingest_chunks_per_second: NonNegative | None = None
    query_embed_p50_ms: NonNegative | None = None
    query_embed_p95_ms: NonNegative | None = None
    usd_per_million_tokens: NonNegative | None = None
    run_tokens: Annotated[int, Field(ge=0)] | None = None
    run_cost_usd: NonNegative | None = None

    @model_validator(mode="after")
    def _figures_match_measured(self) -> "ServingModeMeasurement":
        figures = (
            self.ingest_chunks_per_second,
            self.query_embed_p50_ms,
            self.query_embed_p95_ms,
            self.usd_per_million_tokens,
            self.run_tokens,
            self.run_cost_usd,
        )
        if not self.measured and any(value is not None for value in figures):
            raise ValueError("an unmeasured serving mode carries no figures")
        if self.measured and all(value is None for value in figures):
            raise ValueError("a measured serving mode carries at least one figure")
        if (
            self.query_embed_p50_ms is not None
            and self.query_embed_p95_ms is not None
            and self.query_embed_p50_ms > self.query_embed_p95_ms
        ):
            raise ValueError("query_embed_p50_ms must not exceed query_embed_p95_ms")
        return self


class ProfileComparisonEntry(_Contract):
    profile_id: str
    metrics: ProfileMetricBlocks
    default_candidate: bool | None = None
    default_candidate_note: str | None = None
    serving: list[ServingModeMeasurement] | None = None


class PreMigrationSlice(_Contract):
    n: int = Field(ge=0)
    passed: bool
    recall_at_5: MetricValue
    recall_at_10: MetricValue
    mrr: MetricValue


class EmbeddingProfileComparison(_Contract):
    schema_version: Literal[1] = 1
    baseline_profile: str
    active_profile: str
    profiles: list[ProfileComparisonEntry]
    pre_migration: PreMigrationSlice
    gate_passed: bool
    backfill_run_id: str | None = None
    notes: list[str] = Field(default_factory=list)
    wiring_proof: bool = False
    label: str | None = None


class PreMigrationEvidence(_Contract):
    passed: bool
    n: int = Field(ge=0)


class ActivationEvidence(_Contract):
    target_profile: str
    baseline_profile: str
    gate_passed: bool
    pre_migration: PreMigrationEvidence
    backfill_run_id: str
    recorded_at: str

ISO_TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$"
SHA256_PATTERN = r"^[a-f0-9]{64}$"
BindingMetric = Literal["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]
Sha256 = Annotated[str, Field(pattern=SHA256_PATTERN)]


class BindingDocTypeSlice(_Contract):
    n: int = Field(ge=0)
    real_n: int = Field(ge=0)
    passed: bool
    by_language: dict[str, bool]

    @model_validator(mode="after")
    def _real_within_total(self) -> "BindingDocTypeSlice":
        if self.real_n > self.n:
            raise ValueError("real_n must not exceed n")
        return self


class BindingActivationEvidence(_Contract):
    binding_id: UUID
    target_profile: BindingProfileId
    doc_type: DocType
    tenant_key: Annotated[str, Field(pattern=TENANT_KEY_PATTERN)] | None
    baseline_global_profile: BindingProfileId
    baseline_binding_profile: BindingProfileId | None
    gate_passed: bool
    doc_type_slice: BindingDocTypeSlice
    other_slices_passed: bool
    backfill_run_id: UUID
    recorded_at: str = Field(pattern=ISO_TIMESTAMP_PATTERN)

    @field_validator("recorded_at")
    @classmethod
    def _parseable_timestamp(cls, value: str) -> str:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value


class BindingArm(_Contract):
    profile_id: BindingProfileId
    report_path: str = Field(min_length=1)
    doc_type_slice: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_language_pair: dict[str, SliceMetrics]
    by_doc_type: dict[str, SliceMetrics]
    latency_ms: dict[str, Annotated[float, Field(ge=0)] | None] = Field(default_factory=dict)


class BindingCandidateResult(_Contract):
    profile_id: BindingProfileId
    model: str = Field(min_length=1)
    report_path: str = Field(min_length=1)
    doc_type_slice: SliceMetrics
    by_language: dict[str, SliceMetrics]
    deltas_vs_baseline: dict[BindingMetric, float | None]
    deltas_vs_control: dict[BindingMetric, float | None]
    beats_baseline: bool
    beats_control: bool
    language_regressions: list[str]
    pair_regressions: list[str]
    other_slice_regressions: list[str]
    refusal_regressions: list[str]
    latency_ms: dict[str, Annotated[float, Field(ge=0)] | None] = Field(default_factory=dict)
    supported_languages: list[str] = Field(default_factory=list)
    undeclared_languages: list[str] = Field(default_factory=list)
    recommended: bool

    @model_validator(mode="after")
    def _recommended_has_no_regression(self) -> "BindingCandidateResult":
        if self.recommended and not (
            self.beats_baseline
            and self.beats_control
            and not self.language_regressions
            and not self.pair_regressions
            and not self.other_slice_regressions
            and not self.refusal_regressions
        ):
            raise ValueError("a recommended candidate must beat baseline and control with no regression")
        return self


class BindingComparisonHashes(_Contract):
    corpus_sha256: Sha256
    golden_sha256: Sha256
    noise_sha256: Sha256
    retrieval_params_hash: Sha256
    catalog_version: int = Field(ge=1)


class BindingComparison(_Contract):
    schema_version: Literal[1] = 1
    doc_type: DocType
    baseline: BindingArm
    control: BindingArm
    candidates: list[BindingCandidateResult] = Field(min_length=1)
    provenance_counts: dict[Provenance, Annotated[int, Field(ge=0)]]
    hashes: BindingComparisonHashes
    reembed_run_ids: dict[str, UUID]
    fixture_embedder: bool
    gate_passed: bool
    recommended_profile: BindingProfileId | None = None
    notes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _verdict_is_consistent(self) -> "BindingComparison":
        ids = [candidate.profile_id for candidate in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate profile ids must be unique")
        recommended = [candidate.profile_id for candidate in self.candidates if candidate.recommended]
        expected = [self.recommended_profile] if self.recommended_profile is not None else []
        if recommended != expected:
            raise ValueError("recommended_profile must name the one recommended candidate")
        if self.gate_passed != (self.recommended_profile is not None):
            raise ValueError("gate_passed must be true exactly when a candidate is recommended")
        return self
