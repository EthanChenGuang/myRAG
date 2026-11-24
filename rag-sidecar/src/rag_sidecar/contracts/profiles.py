from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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


class ProfileComparisonEntry(_Contract):
    profile_id: str
    metrics: ProfileMetricBlocks
    default_candidate: bool | None = None
    default_candidate_note: str | None = None


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