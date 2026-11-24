"""Post-parse quality check (D-14) shared by every parse tier."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

from docling_core.types.doc import DocItemLabel, DoclingDocument

from rag_sidecar.contracts.routing import (
    PageCheck,
    PageSignals,
    ParseRoutingConfig,
    QualityCheckResult,
    QualityFailure,
)
from rag_sidecar.ingest.lang import detect_language

QualityCondition = QualityFailure

_MOJIBAKE = re.compile("Ã.|Â|â€|ï»¿")


@dataclass(frozen=True)
class TextPage:
    page: int
    text: str
    has_table: bool = False
    parse_success: bool = True


def page_text(doc: DoclingDocument, page: int) -> str:
    """Concatenate visible text for one page from a Docling document."""
    parts: list[str] = []
    for item, _level in doc.iterate_items():
        if not getattr(item, "prov", None):
            continue
        for provenance in item.prov:
            if provenance.page_no != page:
                continue
            if item.label == DocItemLabel.TABLE:
                text = _table_plain_text(item)
            else:
                text = getattr(item, "text", "") or ""
            if text.strip():
                parts.append(text)
    return "\n".join(parts)


def _table_plain_text(table) -> str:
    data = getattr(table, "data", None)
    if data is None or not data.table_cells:
        return ""
    rows: dict[int, list[str]] = {}
    for cell in data.table_cells:
        text = (cell.text or "").strip()
        rows.setdefault(cell.start_row_offset_idx, []).append(text)
    lines = ["\t".join(rows.get(index, [])) for index in sorted(rows)]
    return "\n".join(line for line in lines if line)


def page_has_table(doc: DoclingDocument, page: int) -> bool:
    """True when the page has a table item with at least one non-empty cell."""
    for table in doc.tables:
        for provenance in table.prov:
            if provenance.page_no != page:
                continue
            data = table.data
            if data and data.table_cells and any((cell.text or "").strip() for cell in data.table_cells):
                return True
    return False


def _preflight_map(pages: Sequence[PageSignals]) -> dict[int, PageSignals]:
    return {page.page: page for page in pages}


def _is_private_use(code: int) -> bool:
    return 0xE000 <= code <= 0xF8FF or 0xF0000 <= code < 0x110000


def _garbled_share(text: str) -> float:
    if not text:
        return 0.0
    bad = 0
    for char in text:
        code = ord(char)
        if char == "\ufffd" or _is_private_use(code):
            bad += 1
    bad += len(_MOJIBAKE.findall(text))
    return bad / len(text)


def _is_garbled(text: str, threshold: float) -> bool:
    return _garbled_share(text) >= threshold


def _page_score(failed: list[QualityCondition], garbled_share: float, weights) -> float:
    score = 1.0
    score -= weights.garbled * garbled_share
    if "low_chars" in failed:
        score -= weights.low_chars
    if "missing_table" in failed:
        score -= weights.missing_table
    if "language_mismatch" in failed:
        score -= weights.language
    return max(0.0, min(1.0, score))


def _check_page(
    *,
    text: str,
    has_table: bool,
    preflight: PageSignals | None,
    profile_langs: Sequence[str],
    cfg: ParseRoutingConfig,
    parse_success: bool,
    partial_doc: bool,
    boundary_prev_ends_in_table: bool,
    first_page_in_range: bool,
    text_layer_sample: str | None,
) -> tuple[list[QualityCondition], float]:
    thresholds = cfg.quality.thresholds
    weights = cfg.quality.score_weights
    garbled_threshold = cfg.l1.garbled_ratio
    failed: list[QualityCondition] = []

    stripped = text.strip()
    if not stripped:
        failed.append("empty_text")

    if preflight is not None:
        if preflight.scanned:
            if len(stripped) < thresholds.scanned_min_chars:
                failed.append("low_chars")
        elif preflight.text_layer and preflight.chars > 0:
            ratio = len(stripped) / preflight.chars
            if ratio < thresholds.low_char_ratio:
                failed.append("low_chars")

    garbled_share = _garbled_share(text)
    if _is_garbled(text, garbled_threshold):
        failed.append("garbled")

    if len(text) >= thresholds.language_min_chars:
        detected, _ = detect_language(text)
        layer_lang: str | None = None
        layer_confident = False
        if text_layer_sample and len(text_layer_sample) >= thresholds.language_min_chars:
            layer_lang, layer_confident = detect_language(text_layer_sample)
        if layer_lang is not None and layer_confident:
            if detected is not None and detected != layer_lang:
                failed.append("language_mismatch")
        elif detected is not None and detected not in profile_langs:
            failed.append("language_mismatch")

    if preflight is not None:
        table_signal = preflight.ruled_tables > 0 or "tables" in preflight.signals
        if table_signal and not has_table:
            failed.append("missing_table")

    if partial_doc or not parse_success:
        failed.append("partial_conversion")

    if (
        boundary_prev_ends_in_table
        and first_page_in_range
        and preflight is not None
        and preflight.aligned_number_rows > 0
        and not has_table
    ):
        failed.append("table_boundary")

    page_score = _page_score(failed, garbled_share, weights)
    if "empty_text" in failed:
        page_score = min(page_score, 0.7)
    return failed, page_score


def _collect_pages(
    pages_result: DoclingDocument | Sequence[TextPage],
) -> list[tuple[int, str, bool, bool]]:
    if isinstance(pages_result, DoclingDocument):
        return [
            (page_no, page_text(pages_result, page_no), page_has_table(pages_result, page_no), True)
            for page_no in sorted(pages_result.pages)
        ]
    return [(page.page, page.text, page.has_table, page.parse_success) for page in pages_result]


def check(
    pages_result: DoclingDocument | Sequence[TextPage],
    preflight_pages: Sequence[PageSignals],
    profile_langs: Sequence[str],
    cfg: ParseRoutingConfig,
    *,
    partial: bool = False,
    boundary_prev_ends_in_table: bool = False,
    first_page: int | None = None,
    text_layer_samples: Mapping[int, str] | None = None,
) -> QualityCheckResult:
    """Score one range's parse output against preflight signals and profile languages."""
    preflight = _preflight_map(preflight_pages)
    samples = text_layer_samples or {}
    rows = _collect_pages(pages_result)
    if not rows and not partial:
        return QualityCheckResult(passed=True, pages=[], score=1.0, partial=False)

    page_checks: list[PageCheck] = []
    scores: list[float] = []
    range_first = first_page if first_page is not None else (rows[0][0] if rows else 1)

    for page_no, text, has_table, parse_success in rows:
        failed, page_score = _check_page(
            text=text,
            has_table=has_table,
            preflight=preflight.get(page_no),
            profile_langs=profile_langs,
            cfg=cfg,
            parse_success=parse_success,
            partial_doc=partial,
            boundary_prev_ends_in_table=boundary_prev_ends_in_table,
            first_page_in_range=page_no == range_first,
            text_layer_sample=samples.get(page_no),
        )
        page_checks.append(PageCheck(page=page_no, failed=failed))
        scores.append(page_score)

    overall = min(scores) if scores else 1.0
    passed = all(not page.failed for page in page_checks)
    return QualityCheckResult(
        passed=passed,
        pages=page_checks,
        score=overall,
        partial=partial or any("partial_conversion" in page.failed for page in page_checks),
    )


def check_text_pages(
    pages: Sequence[TextPage],
    preflight_pages: Sequence[PageSignals],
    profile_langs: Sequence[str],
    cfg: ParseRoutingConfig,
    **kwargs,
) -> QualityCheckResult:
    """Quality check for native or premium outputs supplied as per-page text."""
    return check(pages, preflight_pages, profile_langs, cfg, **kwargs)