from __future__ import annotations

from typing import Sequence

from rag_sidecar.contracts.routing import DocClass, PageSignals


def _scanned_page(page: PageSignals) -> bool:
    return page.scanned or "scanned" in page.signals


def _digital_page(page: PageSignals) -> bool:
    return page.text_layer and not _scanned_page(page)


def classify(pages: Sequence[PageSignals]) -> DocClass:
    if not pages:
        return "text_pdf"

    n = len(pages)
    scanned_count = sum(1 for p in pages if _scanned_page(p))
    digital_count = sum(1 for p in pages if _digital_page(p))

    if scanned_count >= 0.9 * n:
        return "scanned"
    if scanned_count > 0.1 * n and digital_count > 0.1 * n:
        return "mixed"
    if any("tables" in p.signals or p.ruled_tables > 0 for p in pages):
        return "tables"
    if all(("multi_col" in p.signals or p.multi_column) for p in pages) and any(
        "multi_col" in p.signals or p.multi_column for p in pages
    ):
        return "layout"
    return "text_pdf"