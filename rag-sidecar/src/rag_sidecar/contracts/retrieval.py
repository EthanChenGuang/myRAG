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
from .omit import omit_none_schema
from .scopes import ScopeFilter
from .templated import AttributeFilter

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
RefusalMode = Literal["strict", "balanced", "flexible"]
DupClusterSource = Literal["fixture", "live"]
IdentifierFlags = Literal["u", "iu"]

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


def _omit_none(value: object) -> bool:
    return value is None


def _optional_any_schema(schema: dict[str, Any]) -> None:
    schema.pop("default", None)
    branches = [branch for branch in schema.pop("anyOf", None) or [] if branch.get("type") != "null"]
    if len(branches) == 1:
        schema.update(branches[0])
    elif branches:
        schema["anyOf"] = branches


def compute_config_hash(model: BaseModel, *, exclude: frozenset[str] = frozenset({"provenance", "config_hash"})) -> str:
    data = model.model_dump(mode="json")
    for key in exclude:
        data.pop(key, None)
    digest = hashlib.sha256(_stable_json(data).encode("utf-8")).hexdigest()
    return digest


class TableLookupParams(_Contract):
    """D-15, D-16: the structured table leg; a row matches when at least min_cells distinct cells match."""

    min_cells: int = Field(default=2, ge=1, le=20)
    limit: int = Field(default=10, ge=1, le=100)
    weight: float = Field(default=1.0, gt=0)


class DiversityParams(_Contract):
    """D-21, D-48: MMR over the reranked list; lambda 0.7 until a live sweep sets the shipped value."""

    mmr_lambda: float = Field(default=0.7, ge=0, le=1)
    mmr_window_factor: int = Field(default=3, ge=1, le=10)


class DupClusterProfileEntry(_Contract):
    """D-49: a duplicate threshold for one embedding profile; a fixture-fitted value applies in eval only."""

    threshold: float = Field(gt=0, le=1)
    source: DupClusterSource


class DupClusterParams(_Contract):
    threshold: float = Field(default=0.95, gt=0, le=1)
    by_profile: dict[Annotated[str, Field(min_length=1, max_length=128)], DupClusterProfileEntry] = Field(
        default_factory=dict
    )


class DupClusterParamsFile(DupClusterParams):
    """D-49: eval/config/dup-cluster-params.json, written only by `rag_eval.calibrate dup-clusters`."""

    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class TableRow(_Contract):
    """D-45: one parsed Markdown table row; cell_tokens holds one token array per cell."""

    table_key: str = Field(min_length=1, max_length=256)
    row_index: int = Field(ge=0)
    header: list[str] = Field(default_factory=list)
    cells: list[str]
    cell_tokens: list[list[str]]
    chunk_ids: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)

    @model_validator(mode="after")
    def _one_token_list_per_cell(self) -> "TableRow":
        if len(self.cell_tokens) != len(self.cells):
            raise ValueError("cell_tokens must hold one token list per cell")
        return self


class IdentifierPattern(_Contract):
    """D-29: an admin-defined identifier pattern; the regex safety checks run in the app (D-52)."""

    name: str = Field(min_length=1, max_length=80)
    pattern: str = Field(min_length=1, max_length=200)
    flags: IdentifierFlags = "u"
    enabled: bool = True


class IdentifierIndexEntry(_Contract):
    """D-28: one identifier as written (raw) and after NFKC, case fold and separator removal (normalized)."""

    raw: str = Field(min_length=1, max_length=200)
    normalized: str = Field(min_length=1, max_length=200)


class RetrievalParams(_Contract):
    schema_version: Literal[1] = 1
    candidate_pool_size: int = Field(default=75, ge=1, le=200)
    rerank_input_cap: int = Field(default=75, ge=25, le=100)
    final_top_k: int = Field(default=8, ge=1, le=100)
    rrf_k: int = Field(default=60, ge=1)
    leg_weights: RetrievalLegWeights = Field(default_factory=RetrievalLegWeights)
    sub_question_coverage: bool = True
    mmr_lambda: float | None = Field(
        default=None,
        ge=0,
        le=1,
        exclude_if=_omit_none,
        json_schema_extra=omit_none_schema,
    )
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def _cap_not_above_pool(self) -> "RetrievalParams":
        if self.rerank_input_cap > self.candidate_pool_size:
            raise ValueError("rerank_input_cap must not exceed candidate_pool_size")
        return self


class RetrievalOverrides(_Contract):
    candidate_pool_size: int | None = Field(default=None, ge=1, le=200)
    rerank_input_cap: int | None = Field(default=None, ge=25, le=100)
    final_top_k: int | None = Field(default=None, ge=1, le=100)
    rrf_k: int | None = Field(default=None, ge=1)
    leg_weights: RetrievalLegWeights | None = None
    rerank_model: str | None = Field(default=None, min_length=1)
    chunking_profile_by_doc_type: dict[DocType, Annotated[str, Field(min_length=1, max_length=128)]] = Field(default_factory=dict)
    backend: VectorBackend | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=omit_none_schema,
    )
    table_lookup: TableLookupParams | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    diversity: DiversityParams | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    dup_cluster: DupClusterParams | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )


class VersionRange(_Contract):
    """D-12: a version period; either bound may be left open, not both."""

    model_config = ConfigDict(extra="forbid", frozen=True, serialize_by_alias=True)

    from_: Annotated[
        date | None, Field(default=None, alias="from", exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    ]
    to: date | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)

    @model_validator(mode="after")
    def _bounded_and_ordered(self) -> "VersionRange":
        if self.from_ is None and self.to is None:
            raise ValueError("versions range needs from or to")
        if self.from_ is not None and self.to is not None and self.from_ > self.to:
            raise ValueError("versions.from must be on or before versions.to")
        return self


VersionScope = Literal["current", "all"] | VersionRange


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
    versions: VersionScope | None = Field(
        default=None,
        exclude_if=_omit_none,
        json_schema_extra=_optional_any_schema,
    )
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
    attributes: AttributeFilter | None = Field(
        default=None,
        exclude_if=lambda value: value is None,
        json_schema_extra=_optional_object_schema,
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
    mode: RefusalMode | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
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
    embedding_model: str | None = Field(
        default=None, min_length=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )

    @model_validator(mode="after")
    def _calibrated_needs_threshold(self) -> "RefusalCell":
        if self.status == "calibrated" and self.threshold is None:
            raise ValueError("calibrated cells require a threshold")
        return self

    @model_validator(mode="after")
    def _key_matches_dims(self) -> "RefusalCell":
        expected = f"{self.provider}|{self.model}|{self.query_language}|{self.pairing}"
        if self.mode is not None:
            expected = f"{expected}|{self.mode}"
        if self.key != expected:
            raise ValueError("cell.key must equal provider|model|query_language|pairing, plus |mode when mode is set")
        return self


class RefusalThresholds(_Contract):
    schema_version: Literal[1, 2] = 1
    cells: list[RefusalCell] = Field(default_factory=list)
    provenance: ConfigProvenance = Field(default_factory=lambda: ConfigProvenance(source="defaults"))
    config_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def _unique_keys(self) -> "RefusalThresholds":
        keys = [cell.key for cell in self.cells]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate refusal cell keys")
        return self

    @model_validator(mode="after")
    def _version_follows_mode_cells(self) -> "RefusalThresholds":
        has_mode = any(cell.mode is not None for cell in self.cells)
        if has_mode != (self.schema_version == 2):
            raise ValueError("schema_version is 2 exactly when a cell carries a mode")
        return self


class CountMinimums(_Contract):
    no_answer: int = Field(ge=0)
    answerable: int = Field(ge=0)


class EnvironmentMinimums(_Contract):
    fixture: CountMinimums
    live: CountMinimums


class RefusalModeTargets(_Contract):
    """D-23: per-mode operating point; null means the shared target_false_refusal."""

    max_false_answer: float | None = Field(default=None, ge=0, le=1)
    target_false_refusal: float | None = Field(default=None, ge=0, le=1)


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
    targets_by_mode: dict[RefusalMode, RefusalModeTargets] | None = Field(
        default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
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