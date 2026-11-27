"""Ingestion security contracts of Phase 3.2 (D-32 to D-37, D-49).

QuarantineReason is a union discriminated on `kind`, so the generated Zod enforces the same per-kind fields.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, RootModel, model_validator

QuarantineKind = Literal["injection_rule", "hidden_text", "untrusted_link", "invoice_extraction"]
HiddenTextSpanReason = Literal[
    "color_near_background",
    "font_too_small",
    "outside_page",
    "invisible_render_mode",
    "covered_by_object",
    "vanished_run",
    "comment",
    "tracked_deletion",
    "zero_width",
]

# Bounds of one report (plan 03.2-35): at most 200 spans or targets, 2,000 characters per span.
MAX_SPANS = 200
MAX_SPAN_CHARS = 2_000
MAX_TARGETS = 200
MAX_TARGET_CHARS = 2_048

CheckerVersion = Annotated[str, Field(min_length=1, max_length=64)]
Detail = Annotated[str, Field(min_length=1, max_length=500)]
Unlocated = Annotated[int, Field(ge=0)]
LinkTarget = Annotated[str, Field(min_length=1, max_length=MAX_TARGET_CHARS)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class QuarantineSpan(_Contract):
    page: int | None = Field(default=None, ge=1)
    text: str = Field(min_length=1, max_length=MAX_SPAN_CHARS)
    reason: HiddenTextSpanReason


class InjectionRuleQuarantineReason(_Contract):
    kind: Literal["injection_rule"]
    detail: Detail
    checker_version: CheckerVersion
    unlocated: Unlocated = 0


class HiddenTextQuarantineReason(_Contract):
    kind: Literal["hidden_text"]
    detail: Detail
    spans: list[QuarantineSpan] = Field(min_length=1, max_length=MAX_SPANS)
    checker_version: CheckerVersion
    # Spans the remover could not find in the parse text (research F-17); shown to the admin before release.
    unlocated: Unlocated = 0


class UntrustedLinkQuarantineReason(_Contract):
    kind: Literal["untrusted_link"]
    detail: Detail
    targets: list[LinkTarget] = Field(min_length=1, max_length=MAX_TARGETS)
    checker_version: CheckerVersion
    unlocated: Unlocated = 0


class InvoiceExtractionQuarantineReason(_Contract):
    kind: Literal["invoice_extraction"]
    detail: Detail
    checker_version: CheckerVersion
    unlocated: Unlocated = 0


QuarantineReasonVariant = Annotated[
    Union[
        InjectionRuleQuarantineReason,
        HiddenTextQuarantineReason,
        UntrustedLinkQuarantineReason,
        InvoiceExtractionQuarantineReason,
    ],
    Field(discriminator="kind"),
]


class QuarantineReason(RootModel[QuarantineReasonVariant]):
    """One entry of `documents.metadata.quarantine.reasons[]` (D-32); `rule_ids` and `snippets` stay beside it."""

    model_config = ConfigDict(frozen=True)


HiddenTextStatus = Literal["clean", "hidden_found", "not_checked"]
LinkCheckStatus = Literal["clean", "untrusted_found"]
LinkTargetKind = Literal["url", "domain", "email", "annotation"]
ApprovalMode = Literal["off", "members", "all"]
ApprovalReason = Literal[
    "member_upload",
    "all_uploads",
    "admin_upload",
    "personal_workspace",
    "exempt_connector",
    "exempt_uploader",
    "unknown_uploader",
    "uploader_hold",
]
REQUIRED_APPROVAL_REASONS = frozenset({"member_upload", "all_uploads", "unknown_uploader", "uploader_hold"})
EXEMPT_APPROVAL_REASONS = frozenset({"admin_upload", "personal_workspace", "exempt_connector", "exempt_uploader"})

Uuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
Ratio = Annotated[float, Field(ge=0, le=1)]
PositiveRatio = Annotated[float, Field(gt=0, le=1)]


class HiddenTextRequest(_Contract):
    """JSON part of `POST /v1/hidden-text` (D-33); the original's bytes travel as the multipart file part."""

    filename: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=255)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    size_bytes: int = Field(ge=0)


class HiddenTextSpan(_Contract):
    page: int | None = Field(default=None, ge=1)
    text: str = Field(min_length=1, max_length=MAX_SPAN_CHARS)
    reason: HiddenTextSpanReason
    bbox: list[float] | None = Field(default=None, min_length=4, max_length=4)


class HiddenTextReport(_Contract):
    status: HiddenTextStatus
    spans: list[HiddenTextSpan] = Field(default_factory=list, max_length=MAX_SPANS)
    # PDF link annotation targets for the link check (D-35); never fetched or resolved.
    link_targets: list[LinkTarget] = Field(default_factory=list, max_length=MAX_TARGETS)
    checker_version: CheckerVersion
    # Spans left out by the report bounds (plan 03.2-35).
    dropped: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _status_matches_spans(self) -> HiddenTextReport:
        if self.status == "hidden_found" and not self.spans:
            raise ValueError("hidden_found requires at least one span")
        if self.status != "hidden_found" and (self.spans or self.dropped):
            raise ValueError(f"{self.status} carries no spans")
        return self


class PdfHiddenTextRules(_Contract):
    color_distance_max: Ratio  # RGB distance to the local background, scaled to 0..1
    min_font_size_pt: float = Field(gt=0, le=72)
    min_font_size_ratio: PositiveRatio  # relative to the page's median font size
    outside_page_margin_pt: float = Field(ge=0, le=144)
    covered_overlap_min: PositiveRatio
    min_span_chars: int = Field(ge=1, le=MAX_SPAN_CHARS)


class DocxHiddenTextRules(_Contract):
    color_distance_max: Ratio
    min_font_size_half_points: int = Field(ge=1, le=144)
    min_span_chars: int = Field(ge=1, le=MAX_SPAN_CHARS)


class HiddenTextRules(_Contract):
    """`config/rag/hidden-text-rules.json` (D-33): names and ranges only; values are fitted on fixtures (plans 35, 36)."""

    schema_version: Literal[1] = 1
    rules_version: str = Field(min_length=1, max_length=64)
    pdf: PdfHiddenTextRules
    docx: DocxHiddenTextRules
    zero_width_threshold: int = Field(ge=1)


class LinkTargetFinding(_Contract):
    kind: LinkTargetKind
    target: LinkTarget
    host: str = Field(min_length=1, max_length=253)


class LinkCheckResult(_Contract):
    """Outcome of the ingestion link check (D-35); targets are the ones outside the allowlist."""

    status: LinkCheckStatus
    targets: list[LinkTargetFinding] = Field(default_factory=list, max_length=MAX_TARGETS)
    checker_version: CheckerVersion

    @model_validator(mode="after")
    def _status_matches_targets(self) -> LinkCheckResult:
        if (self.status == "untrusted_found") != bool(self.targets):
            raise ValueError("untrusted_found requires targets and clean carries none")
        return self


class UploadApproval(_Contract):
    """Decision of the upload approval gate in `submitIngest()` (D-36, D-37)."""

    mode: ApprovalMode
    required: bool
    reason: ApprovalReason | None = None
    uploader_id: Uuid | None = None
    decided_at: datetime

    @model_validator(mode="after")
    def _reason_matches(self) -> UploadApproval:
        # D-46 (Phase 5.2): an active uploader hold holds the upload in every mode, off included.
        if self.reason == "uploader_hold":
            if not self.required:
                raise ValueError("an uploader hold always requires approval")
            return self
        if self.mode == "off":
            if self.required or self.reason is not None:
                raise ValueError("mode off requires nothing and gives no reason")
            return self
        if self.reason is None:
            raise ValueError("a reason is required when approval is on")
        allowed = REQUIRED_APPROVAL_REASONS if self.required else EXEMPT_APPROVAL_REASONS
        if self.reason not in allowed:
            raise ValueError(f"reason {self.reason} does not fit required={self.required}")
        return self
