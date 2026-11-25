"""Hidden-text check over an original file (D-33): dispatch by MIME type, report bounds, rules data.

Base install only: the PDF checker's optional imports (preflight extra) happen inside the call, so a missing
extra surfaces as CheckerUnavailable at request time, never at import time.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from rag_sidecar.config_files import resolve_config_file
from rag_sidecar.contracts.ingest_security import (
    MAX_SPAN_CHARS,
    MAX_SPANS,
    MAX_TARGET_CHARS,
    MAX_TARGETS,
    HiddenTextReport,
    HiddenTextRules,
    HiddenTextSpan,
    HiddenTextSpanReason,
)

RULES_FILE = "hidden-text-rules.json"
CHECKER_VERSION = "1"
PDF_MIME_TYPES = frozenset({"application/pdf", "application/x-pdf"})


class CheckerUnavailable(Exception):
    """The optional extra that holds the checker for this format is not installed."""


class UnreadableDocument(Exception):
    """The file could not be opened as the declared format."""


class EncryptedDocument(Exception):
    """The file needs a password; nothing was checked."""


@dataclass(frozen=True)
class FoundSpan:
    page: int | None
    text: str
    reason: HiddenTextSpanReason
    bbox: tuple[float, float, float, float] | None
    order: int = 0


@dataclass(frozen=True)
class CheckOutcome:
    checked: bool
    spans: list[FoundSpan]
    link_targets: list[str]


def default_rules_path() -> Path:
    return resolve_config_file(RULES_FILE)


def load_hidden_text_rules(path: Path | None = None) -> HiddenTextRules:
    target = path or default_rules_path()
    return HiddenTextRules.model_validate(json.loads(target.read_text(encoding="utf-8")))


@lru_cache(maxsize=1)
def cached_rules() -> HiddenTextRules:
    return load_hidden_text_rules()


def checker_version(rules: HiddenTextRules) -> str:
    return f"hidden-text/{CHECKER_VERSION}/{rules.rules_version}"[:64]


def _sort_key(span: FoundSpan) -> tuple:
    page = span.page if span.page is not None else 0
    if span.bbox is None:
        return (page, 0.0, 0.0, span.order)
    left, _bottom, _right, top = span.bbox
    return (page, -round(top, 1), round(left, 1), span.order)


def build_report(outcome: CheckOutcome, rules: HiddenTextRules) -> HiddenTextReport:
    version = checker_version(rules)
    targets: list[str] = []
    for target in outcome.link_targets:
        clipped = target[:MAX_TARGET_CHARS]
        if clipped and clipped not in targets:
            targets.append(clipped)
    targets = targets[:MAX_TARGETS]
    if not outcome.checked:
        return HiddenTextReport(status="not_checked", checker_version=version)
    ordered = sorted(outcome.spans, key=_sort_key)
    kept = ordered[:MAX_SPANS]
    spans = [
        HiddenTextSpan(
            page=span.page,
            text=span.text[:MAX_SPAN_CHARS],
            reason=span.reason,
            bbox=[round(value, 2) for value in span.bbox] if span.bbox is not None else None,
        )
        for span in kept
    ]
    return HiddenTextReport(
        status="hidden_found" if spans else "clean",
        spans=spans,
        link_targets=targets,
        checker_version=version,
        dropped=len(ordered) - len(kept),
    )


def check_hidden_text(data: bytes, mime_type: str, rules: HiddenTextRules | None = None) -> HiddenTextReport:
    """Check the original's bytes; formats without a checker are `not_checked`."""
    active = rules if rules is not None else cached_rules()
    kind = mime_type.split(";", 1)[0].strip().lower()
    if kind in PDF_MIME_TYPES:
        from rag_sidecar.security.pdf_checks import check_pdf_hidden_text

        return build_report(check_pdf_hidden_text(data, active), active)
    return build_report(CheckOutcome(checked=False, spans=[], link_targets=[]), active)
