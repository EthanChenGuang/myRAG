from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator, model_validator

from rag_sidecar.contracts.ingest import DocType

from .languages import Language
from .scopes import ScopeFilter

FilterLanguage = Language

Pairing = Literal["same", "cross"]
RefusalCellStatus = Literal["calibrated", "uncalibrated", "insufficient_data", "failed_holdout"]
RefusalCellSource = Literal["fixture", "live"]
ConfigProvenanceSource = Literal["defaults", "sweep", "calibration", "fixture", "live"]
ChunkingProfileStatus = Literal["building", "ready", "active", "retired"]
ParentMode = Literal["none", "structure", "fixed"]
ChunkingPreset = Literal["128/512", "256/1024", "256/2048", "custom"]
ChunkingDecisionSource = Literal["fixture", "live"]
VectorBackend = Literal["pgvector", "weaviate", "qdrant"]
ExternalVectorBackend = Literal["weaviate", "qdrant"]

_CHUNKING_ERROR_CODES = frozenset(
    {
        "child_exceeds_embedding_input",
        "parent_below_twice_child",
        "parent_tokens_required",
    }
)
_CHUNKING_WARNING_CODES = frozenset(
    {
        "ratio_outside_4_8",
        "top_k_parent_over_budget",
    }
)


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ConfigProvenance(_Contract):
    source: ConfigProvenanceSource


def _optional_positive_number_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    branches = schema.pop("anyOf", None) or []
    for branch in branches:
        if branch.get("type") == "number":
            schema.update(branch)


class RetrievalLegWeights(_Contract):
    dense: float = Field(default=1.0, gt=0)
    lexical: float = Field(default=1.0, gt=0)
    exact_id: float = Field(default=1.0, gt=0)
    domain: float | None = Field(
        default=None,
        gt=0,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_positive_number_schema,
    )
    translation: float | None = Field(
        default=None,
        gt=0,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_positive_number_schema,
    )


def _stable_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_config_hash(model: BaseModel, *, exclude: frozenset[str] = frozenset({"provenance", "config_hash"})) -> str:
    data = model.model_dump(mode="json")
    for key in exclude:
        data.pop(key, None)
    digest = hashlib.sha256(_stable_json(data).encode("utf-8")).hexdigest()
    return digest


class RetrievalParams(_Contract):
    schema_version: Literal[1] = 1
    candidate_pool_size: int = Field(default=75, ge=1, le=200)
    rerank_input_cap: int = Field(default=75, ge=50, le=100)
    final_top_k: int = Field(default=8, ge=1, le=100)
    rrf_k: int = Field(default=60, ge=1)
    leg_weights: RetrievalLegWeights = Field(default_factory=RetrievalLegWeights)
    sub_question_coverage: bool = True
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class RetrievalOverrides(_Contract):
    candidate_pool_size: int | None = Field(default=None, ge=1, le=200)
    rerank_input_cap: int | None = Field(default=None, ge=50, le=100)
    final_top_k: int | None = Field(default=None, ge=1, le=100)
    rrf_k: int | None = Field(default=None, ge=1)
    leg_weights: RetrievalLegWeights | None = None
    rerank_model: str | None = Field(default=None, min_length=1)
    chunking_profile_by_doc_type: dict[DocType, Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=dict)
    backend: VectorBackend | None = None


class DateRangeFilter(_Contract):
    from_: Annotated[date, Field(alias="from")]
    to: date
    include_undated: bool = False

    @model_validator(mode="after")
    def _from_before_to(self) -> "DateRangeFilter":
        if self.from_ > self.to:
            raise ValueError("date_range.from must be on or before date_range.to")
        return self


class InvoiceFilter(_Contract):
    supplier: str = Field(min_length=1)
    amount_min: Annotated[str, Field(pattern=r"^-?\d+(\.\d{1,4})?$")]
    amount_max: Annotated[str, Field(pattern=r"^-?\d+(\.\d{1,4})?$")]
    currency: Annotated[str, Field(min_length=3, max_length=3)]

    @model_validator(mode="after")
    def _amount_order(self) -> "InvoiceFilter":
        if float(self.amount_min) > float(self.amount_max):
            raise ValueError("invoice.amount_min must be less than or equal to amount_max")
        return self


def _optional_object_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    branches = schema.pop("anyOf", None) or []
    for branch in branches:
        if branch.get("type") != "null":
            schema.update(branch)


def _optional_boolean_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)


def _reject_empty_list(values: list[Any] | None, field: str) -> list[Any] | None:
    if values is None:
        return None
    if not values:
        raise ValueError(f"{field} must not be an empty list")
    return values


class RetrievalFilters(_Contract):
    date_range: DateRangeFilter | None = None
    sources: list[str] | None = None
    document_ids: list[UUID] | None = None
    doc_types: list[DocType] | None = None
    languages: list[FilterLanguage] | None = None
    invoice: InvoiceFilter | None = None
    current_only: Literal[True] = True
    scopes: ScopeFilter | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_object_schema,
    )
    include_untagged: bool = Field(
        default=False,
        exclude_if=lambda value: value is False,
        json_schema_extra=_optional_boolean_schema,
    )

    @model_validator(mode="after")
    def _untagged_needs_scopes(self) -> "RetrievalFilters":
        if self.include_untagged and self.scopes is None:
            raise ValueError("include_untagged requires scopes")
        return self

    @field_validator("sources", mode="after")
    @classmethod
    def _non_empty_sources(cls, value: list[str] | None) -> list[str] | None:
        return _reject_empty_list(value, "sources")  # type: ignore[return-value]

    @field_validator("document_ids", mode="after")
    @classmethod
    def _non_empty_document_ids(cls, value: list[UUID] | None) -> list[UUID] | None:
        return _reject_empty_list(value, "document_ids")  # type: ignore[return-value]

    @field_validator("doc_types", mode="after")
    @classmethod
    def _non_empty_doc_types(cls, value: list[DocType] | None) -> list[DocType] | None:
        return _reject_empty_list(value, "doc_types")  # type: ignore[return-value]

    @field_validator("languages", mode="after")
    @classmethod
    def _non_empty_languages(cls, value: list[FilterLanguage] | None) -> list[FilterLanguage] | None:
        return _reject_empty_list(value, "languages")  # type: ignore[return-value]


class RefusalMetricBlock(_Contract):
    no_answer_count: int = Field(ge=0)
    answerable_count: int = Field(ge=0)
    false_refusal_rate: float = Field(ge=0, le=1)
    false_refusal_rate_upper_bound: float = Field(ge=0, le=1)
    correct_refusal_rate: float = Field(ge=0, le=1)


class RefusalCell(_Contract):
    key: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    query_language: FilterLanguage
    pairing: Pairing
    threshold: float | None = None
    status: RefusalCellStatus
    tokenizer_version: int = Field(ge=0)
    rerank_text_version: int = Field(ge=0)
    config_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source: RefusalCellSource
    recorded_at: str
    holdout_evaluations: int = Field(ge=0)
    dev: RefusalMetricBlock
    holdout: RefusalMetricBlock

    @model_validator(mode="after")
    def _calibrated_needs_threshold(self) -> "RefusalCell":
        if self.status == "calibrated" and self.threshold is None:
            raise ValueError("calibrated cells require a threshold")
        return self

    @model_validator(mode="after")
    def _key_matches_dims(self) -> "RefusalCell":
        expected = f"{self.provider}|{self.model}|{self.query_language}|{self.pairing}"
        if self.key != expected:
            raise ValueError("cell.key must equal provider|model|query_language|pairing")
        return self


class RefusalThresholds(_Contract):
    schema_version: Literal[1] = 1
    cells: list[RefusalCell] = Field(default_factory=list)
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def _unique_keys(self) -> "RefusalThresholds":
        keys = [cell.key for cell in self.cells]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate refusal cell keys")
        return self


class CountMinimums(_Contract):
    no_answer: int = Field(ge=0)
    answerable: int = Field(ge=0)


class EnvironmentMinimums(_Contract):
    fixture: CountMinimums
    live: CountMinimums


class RefusalCalibrationConfig(_Contract):
    schema_version: Literal[1] = 1
    target_false_refusal: float = Field(default=0.05, ge=0, le=1)
    dev_minimums: EnvironmentMinimums = Field(
        default_factory=lambda: EnvironmentMinimums(
            fixture=CountMinimums(no_answer=3, answerable=5),
            live=CountMinimums(no_answer=10, answerable=20),
        )
    )
    holdout_minimums: EnvironmentMinimums = Field(
        default_factory=lambda: EnvironmentMinimums(
            fixture=CountMinimums(no_answer=1, answerable=2),
            live=CountMinimums(no_answer=3, answerable=6),
        )
    )
    pass_rule: str = "false_refusal_test <= target + max(noise_floor, 1 / n_test_answerable)"
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ChunkingProfileContext(_Contract):
    max_child_tokens: int = Field(ge=1)
    top_k: int = Field(ge=1)
    context_budget: int = Field(ge=1)


class ChunkingProfile(_Contract):
    id: str = Field(min_length=1)
    doc_type: DocType
    child_tokens: int = Field(ge=1)
    parent_mode: ParentMode
    parent_tokens: int | None = Field(default=None, ge=1)
    status: ChunkingProfileStatus
    preset: ChunkingPreset

    @model_validator(mode="wrap")
    @classmethod
    def _validate_with_context(cls, value: Any, handler, info: ValidationInfo):
        model: ChunkingProfile = handler(value)
        ctx = info.context or {}
        errors, warnings = chunking_profile_findings(model.model_dump(), ctx)
        if errors:
            raise ValueError(errors[0])
        return model


def chunking_profile_findings(profile: dict[str, Any], context: dict[str, Any] | None = None) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    ctx = context or {}
    max_child = ctx.get("max_child_tokens")
    top_k = ctx.get("top_k")
    budget = ctx.get("context_budget")

    child = profile.get("child_tokens")
    parent_mode = profile.get("parent_mode")
    parent = profile.get("parent_tokens")

    if parent_mode == "fixed" and parent is None:
        errors.append("parent_tokens_required")

    if max_child is not None and child is not None and child > max_child:
        errors.append("child_exceeds_embedding_input")

    parent_too_small = parent is not None and child is not None and parent < child * 2
    if parent_too_small:
        errors.append("parent_below_twice_child")

    if parent is not None and child is not None and child > 0 and not parent_too_small:
        ratio = parent / child
        if ratio < 4 or ratio > 8:
            warnings.append("ratio_outside_4_8")

    if parent is not None and top_k is not None and budget is not None:
        if top_k * parent > budget:
            warnings.append("top_k_parent_over_budget")

    return errors, warnings


CHUNKING_VALIDATION_CASES: list[dict[str, Any]] = [
    {
        "input": {
            "id": "general@256x1024",
            "doc_type": "general",
            "child_tokens": 256,
            "parent_mode": "structure",
            "parent_tokens": 1024,
            "status": "ready",
            "preset": "256/1024",
        },
        "errors": [],
        "warnings": ["top_k_parent_over_budget"],
    },
    {
        "input": {
            "id": "general@child-too-large",
            "doc_type": "general",
            "child_tokens": 9000,
            "parent_mode": "none",
            "parent_tokens": None,
            "status": "ready",
            "preset": "custom",
        },
        "errors": ["child_exceeds_embedding_input"],
        "warnings": [],
    },
    {
        "input": {
            "id": "general@parent-small",
            "doc_type": "general",
            "child_tokens": 256,
            "parent_mode": "fixed",
            "parent_tokens": 400,
            "status": "ready",
            "preset": "custom",
        },
        "errors": ["parent_below_twice_child"],
        "warnings": [],
    },
    {
        "input": {
            "id": "general@ratio",
            "doc_type": "general",
            "child_tokens": 128,
            "parent_mode": "fixed",
            "parent_tokens": 1536,
            "status": "ready",
            "preset": "custom",
        },
        "errors": [],
        "warnings": ["ratio_outside_4_8", "top_k_parent_over_budget"],
    },
    {
        "input": {
            "id": "general@fixed-missing-parent",
            "doc_type": "general",
            "child_tokens": 256,
            "parent_mode": "fixed",
            "parent_tokens": None,
            "status": "ready",
            "preset": "custom",
        },
        "errors": ["parent_tokens_required"],
        "warnings": [],
    },
]


def write_chunking_cases(path: Path) -> None:
    payload = {
        "schema_version": 1,
        "error_codes": sorted(_CHUNKING_ERROR_CODES),
        "warning_codes": sorted(_CHUNKING_WARNING_CODES),
        "default_context": {"max_child_tokens": 8191, "top_k": 8, "context_budget": 6000},
        "cases": CHUNKING_VALIDATION_CASES,
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class ChunkingMetricValue(_Contract):
    value: float | None
    n: int = Field(ge=0)
    upper_95: float | None = Field(default=None, ge=0, le=1)


class ChunkingSliceMetrics(_Contract):
    recall_at_k: ChunkingMetricValue
    mrr: ChunkingMetricValue
    correct_refusal_rate: ChunkingMetricValue
    false_refusal_rate: ChunkingMetricValue
    judge_correctness: ChunkingMetricValue
    judge_skipped: bool = False
    context_tokens: ChunkingMetricValue
    latency_p50_ms: ChunkingMetricValue
    latency_p95_ms: ChunkingMetricValue


class ChunkingProfileMetrics(_Contract):
    overall: ChunkingSliceMetrics
    by_doc_type: dict[str, ChunkingSliceMetrics] = Field(default_factory=dict)
    by_language: dict[str, ChunkingSliceMetrics] = Field(default_factory=dict)
    by_question_kind: dict[str, ChunkingSliceMetrics] = Field(default_factory=dict)


class ChunkingGateRegression(_Contract):
    slice: str
    metric: str
    diff: float
    band: float


class ChunkingProfileGate(_Contract):
    baseline_profile_id: str
    passed: bool
    regressions: list[ChunkingGateRegression] = Field(default_factory=list)


class ChunkingSweepProfileEntry(_Contract):
    profile_id: str
    metrics: ChunkingProfileMetrics
    gate: ChunkingProfileGate | None = None


class ChunkingSweepReport(_Contract):
    schema_version: Literal[1] = 1
    profiles: list[ChunkingSweepProfileEntry] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    provenance: ConfigProvenance
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ChunkingDecision(_Contract):
    doc_type: DocType
    profile_id: str
    chosen_on: dict[str, float]
    gate_passed: bool
    regressions: list[ChunkingGateRegression] = Field(default_factory=list)
    build_run_id: str | None = None
    report_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    decided_by: str = Field(min_length=1)
    recorded_at: str
    source: ChunkingDecisionSource

    @model_validator(mode="after")
    def _gate_consistency(self) -> "ChunkingDecision":
        if self.gate_passed and self.regressions:
            raise ValueError("gate_passed cannot be true when regressions is non-empty")
        return self