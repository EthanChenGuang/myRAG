"""Derive ParserExpected JSON from parse fixture specs (single code path with the PDF generator)."""

from __future__ import annotations

from typing import Any

from rag_sidecar.contracts.parse_eval import ExpectedHeading, ExpectedPage, ParserExpected, ReadingOrderAnchor, TableCell


def signals_for_page(page: int, spec: Any) -> tuple[list[str], str, str]:
    facts = spec.facts
    page_kinds = facts.get("page_kinds") or {page: spec.layer}
    kind = page_kinds.get(page, "digital")
    signals: list[str] = []
    if kind == "scanned":
        signals.append("scanned")
    if page in facts.get("tables", {}):
        signals.append("tables")
    if page in facts.get("multi_column_pages", set()):
        signals.append("multi_col")
    if page in facts.get("table_continues_pages", set()):
        signals.append("table_continues")
    if spec.doc_type == "invoice_receipt":
        tier = "structured"
        if "scanned" in signals:
            preset = "structured_ocr"
        elif "tables" in signals:
            preset = "structured_full"
        elif "multi_col" in signals:
            preset = "structured_layout"
        else:
            preset = "structured_layout"
        return signals, tier, preset
    if "scanned" in signals:
        return signals, "structured", "structured_ocr"
    if "tables" in signals:
        return signals, "structured", "structured_full"
    if "multi_col" in signals:
        return signals, "structured", "structured_layout"
    return signals, "fast", "fast"


def table_cells(spec: Any) -> list[TableCell]:
    cells: list[TableCell] = []
    for _page, rows in spec.facts.get("tables", {}).items():
        for row_index, row in enumerate(rows):
            for col_index, text in enumerate(row):
                cells.append(TableCell(row=row_index, col=col_index, text=text))
    return cells


def parser_expected(spec: Any, ingest_specs: Any) -> dict[str, Any]:
    page_count = spec.facts["page_count"]
    pages: list[ExpectedPage] = []
    for page in range(1, page_count + 1):
        signals, tier, preset = signals_for_page(page, spec)
        pages.append(ExpectedPage(page=page, signals=signals, tier=tier, preset=preset))
    headings = [ExpectedHeading(text=item["text"], level=item["level"], page=item["page"]) for item in spec.facts.get("headings", [])]
    reading_order: list[ReadingOrderAnchor] = []
    order = 0
    for block in spec.blocks:
        if isinstance(block, (ingest_specs.Heading, ingest_specs.Paragraph, ingest_specs.ColumnParagraph)):
            text = block.text
            reading_order.append(ReadingOrderAnchor(text=text[:80], page=block.page, order=order))
            order += 1
    model = ParserExpected(
        fixture_id=spec.id,
        language=spec.language,
        pages=pages,
        headings=headings,
        table_cells=table_cells(spec),
        reading_order=reading_order,
    )
    return model.model_dump(mode="json")

def exact_text(spec: Any, ingest_specs: Any) -> str:
    """The character-exact text of a fixture whose facts set exact_text: its text blocks in reading order, one per line, NFC."""
    import unicodedata

    lines = [block.text for block in spec.blocks if isinstance(block, (ingest_specs.Heading, ingest_specs.Paragraph))]
    text = "\n".join(lines) + "\n"
    if not unicodedata.is_normalized("NFC", text):
        raise ValueError(f"{spec.id}: the exact text must be NFC")
    return text
