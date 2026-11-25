from __future__ import annotations

import base64
import binascii
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator, model_validator

from rag_sidecar.contracts.ingest import DocType, OcrLanguage, ParseResult
from rag_sidecar.contracts.routing import (
    DetectCounts,
    PageRange,
    PageStructureVerdict,
    ParseAttempt,
    ParseTier,
    RefusalReason,
)
from rag_sidecar.contracts.sidecar import _Contract

JobStatus = Literal[
    "queued",
    "preflight",
    "parsing",
    "checking",
    "chunking",
    "embedding",
    "ready",
    "failed",
    "quarantined",
    "needs_review",
    "skipped_duplicate",
]
JobKind = Literal["ingest", "dry_run", "delete"]
RunnerKind = Literal["worker", "ray"]
RoutingMode = Literal["fixed", "tiered"]
EmbedMode = Literal["sync", "batch_api"]
AdvancePhase = Literal["begin", "post_parse"]
ParseExternalMode = Literal["chain", "native", "premium"]
ParseExternalStatus = Literal["done", "pending", "refused", "failed"]

_TIER_ORDER = {tier: index for index, tier in enumerate(["native", "fast", "structured", "premium"])}
_MAX_VLM_IMAGE_BYTES = 400_000
_MAX_VLM_PAGES = 20

WorkerId = Annotated[str, Field(min_length=1, max_length=128)]
JobUuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
TenantKey = Annotated[str, Field(min_length=1, max_length=256)]


class OriginalRef(_Contract):
    bucket: str
    path: str


class JobSettingsSnapshot(_Contract):
    routing: RoutingMode
    cloud_allowed: bool
    escalation: bool
    progressive: bool
    premium_max_pages_per_doc: int = Field(ge=0)
    premium_page_budget: int = Field(ge=0)
    vlm_detect: bool
    vlm_model: str | None = None
    profile_id: str
    profile_version: int = Field(ge=1)
    doc_type: DocType
    min_tier: ParseTier | None = None
    max_tier: ParseTier | None = None
    embed_mode: EmbedMode
    ocr_languages: list[OcrLanguage] = Field(min_length=1)
    routing_config_version: str

    @model_validator(mode="after")
    def _tiers_are_ordered(self) -> JobSettingsSnapshot:
        if self.min_tier and self.max_tier and _TIER_ORDER[self.min_tier] > _TIER_ORDER[self.max_tier]:
            raise ValueError("min_tier must not rank above max_tier")
        return self


class IngestionJob(_Contract):
    id: JobUuid
    kind: JobKind
    status: JobStatus
    stage: str | None = None
    tenant_key: TenantKey
    document_id: JobUuid | None = None
    lineage_id: str | None = None
    version: int | None = Field(default=None, ge=1)
    batch_id: JobUuid | None = None
    source: str
    source_key: str
    file_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    filename: str | None = None
    mime_type: str | None = None
    original_ref: OriginalRef | None = None
    priority: int = Field(default=100, ge=0)
    retries: int = Field(default=0, ge=0)
    max_retries: int = Field(default=3, ge=0)
    run_after: datetime | None = None
    lease_until: datetime | None = None
    locked_by: WorkerId | None = None
    runner: RunnerKind | None = None
    settings: JobSettingsSnapshot
    stage_state: dict[str, Any] = Field(default_factory=dict)
    doc_class: str | None = None
    tier: ParseTier | None = None
    parser_used: str | None = None
    parser_version: str | None = None
    attempts: list[ParseAttempt] = Field(default_factory=list)
    escalations: int = Field(default=0, ge=0)
    pages: int | None = Field(default=None, ge=0)
    page_ranges: list[PageRange] = Field(default_factory=list)
    tier_page_counts: dict[str, int] = Field(default_factory=dict)
    detect_counts: DetectCounts | None = None
    preflight_ref: str | None = None
    est_cost_usd: float | None = Field(default=None, ge=0)
    embedding_profile: str | None = None
    error_class: str | None = None
    dead_letter_at: datetime | None = None
    needs_review_reason: str | None = None
    routing_note: str | None = None
    provisional_published_at: datetime | None = None
    trace_id: str | None = None
    timings: dict[str, int] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class DetectVlmPageImage(_Contract):
    page: int = Field(ge=1)
    png_base64: str = Field(min_length=1)

    @field_validator("png_base64")
    @classmethod
    def _png_within_size_cap(cls, value: str) -> str:
        try:
            raw = base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("png_base64 must be valid base64") from exc
        if len(raw) > _MAX_VLM_IMAGE_BYTES:
            raise ValueError("png image exceeds size cap")
        return value


class DetectVlmRequest(_Contract):
    worker_id: WorkerId
    attempt_no: int = Field(ge=1)
    pages: list[DetectVlmPageImage] = Field(min_length=1, max_length=_MAX_VLM_PAGES)


class DetectVlmPageResult(_Contract):
    page: int = Field(ge=1)
    verdict: PageStructureVerdict | None = None
    refused: RefusalReason | None = None

    @model_validator(mode="after")
    def _verdict_xor_refusal(self) -> DetectVlmPageResult:
        if (self.verdict is None) == (self.refused is None):
            raise ValueError("exactly one of verdict or refused must be set")
        return self


class DetectVlmResponse(_Contract):
    worker_id: WorkerId
    pages: list[DetectVlmPageResult]


class ParseAttemptPages(_Contract):
    start: int = Field(ge=1)
    end: int = Field(ge=1)

    @model_validator(mode="after")
    def _start_le_end(self) -> ParseAttemptPages:
        if self.start > self.end:
            raise ValueError("start must not exceed end")
        return self


class ParseExternalRequest(_Contract):
    worker_id: WorkerId
    attempt_no: int = Field(ge=1)
    mode: ParseExternalMode
    pages: ParseAttemptPages | None = None
    subpdf_ref: str | None = None
    options_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    continuation: str | None = None
    cursor: str | None = None

    @model_validator(mode="after")
    def _mode_fields(self) -> ParseExternalRequest:
        if self.mode == "premium":
            if self.pages is None or self.subpdf_ref is None or self.options_hash is None:
                raise ValueError("premium requires pages, subpdf_ref and options_hash")
        elif self.subpdf_ref is not None:
            raise ValueError("subpdf_ref is only allowed for premium mode")
        return self


class ParseExternalPageText(_Contract):
    page: int = Field(ge=1)
    text: str
    has_table: bool


class ParseExternalResponse(_Contract):
    worker_id: WorkerId
    status: ParseExternalStatus
    cache_id: str | None = None
    result: ParseResult | None = None
    pages: list[ParseExternalPageText] | None = None
    continuation: str | None = None
    retry_after_ms: int | None = Field(default=None, ge=0)
    reason: RefusalReason | None = None
    error_class: str | None = None

    @model_validator(mode="after")
    def _status_payload(self) -> ParseExternalResponse:
        if self.status == "done":
            if self.cache_id is None:
                raise ValueError("done requires cache_id")
        elif self.status == "pending":
            if self.continuation is None or self.retry_after_ms is None:
                raise ValueError("pending requires continuation and retry_after_ms")
        elif self.status == "refused":
            if self.reason is None:
                raise ValueError("refused requires reason")
        elif self.status == "failed":
            if self.error_class is None:
                raise ValueError("failed requires error_class")
        return self


class AdvanceRequest(_Contract):
    worker_id: WorkerId
    attempt_no: int = Field(ge=1)
    phase: AdvancePhase
    parse_cache_id: str | None = None
    deadline_ms: int = Field(ge=1, le=40_000)
    cursor: str | None = None
    # Progressive mode (D-30): the run publishes the provisional fast version and the job stays open for the routed run.
    provisional: bool = False

    @model_validator(mode="after")
    def _post_parse_requires_cache(self) -> AdvanceRequest:
        if self.phase == "post_parse" and self.parse_cache_id is None:
            raise ValueError("post_parse requires parse_cache_id")
        return self


class AdvanceResponse(_Contract):
    worker_id: WorkerId
    stage: str
    done: bool
    wait_ms: int | None = Field(default=None, ge=0)
    status: JobStatus | None = None
    reason: str | None = None


REQUEST_BODY_MODELS = (DetectVlmRequest, ParseExternalRequest, AdvanceRequest)


def request_bodies_must_not_carry_tenant() -> None:
    forbidden = {"tenant", "tenant_key"}
    for model in REQUEST_BODY_MODELS:
        overlap = forbidden.intersection(model.model_fields)
        if overlap:
            raise AssertionError(f"{model.__name__} must not expose tenant fields: {sorted(overlap)}")