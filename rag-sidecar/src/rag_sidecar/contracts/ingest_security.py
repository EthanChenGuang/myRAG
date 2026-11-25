"""Ingestion security contracts of Phase 3.2 (D-32 to D-37, D-49).

QuarantineReason is a union discriminated on `kind`, so the generated Zod enforces the same per-kind fields.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, RootModel

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
