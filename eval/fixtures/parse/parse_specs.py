"""Specs for the DATA-17 parse routing fixtures (synthetic content only)."""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


def _ingest_specs():
    loaded = sys.modules.get("ingest_fixture_specs")
    if loaded is not None:
        return loaded
    path = Path(__file__).resolve().parents[1] / "ingest" / "specs.py"
    spec = importlib.util.spec_from_file_location("ingest_fixture_specs", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_ingest = _ingest_specs()
FixtureSpec = _ingest.FixtureSpec
Heading = _ingest.Heading
Paragraph = _ingest.Paragraph
Table = _ingest.Table
ColumnParagraph = _ingest.ColumnParagraph


@dataclass(frozen=True)
class BenchSpec:
    id: str
    language: str
    table_pages: tuple[int, ...]
    page_count: int = 100


def _digital_text() -> FixtureSpec:
    blocks = (
        Heading("Example routing memo", 1, 1),
        Paragraph("This one-page digital fixture checks the fast tier on plain English text with no tables or columns.", 1),
        Heading("Scope", 2, 2),
        Paragraph("The routing harness scores recorded outputs against ParserExpected structure on every page.", 2),
    )
    facts: dict[str, Any] = {
        "parse_class": "digital_text",
        "headings": [
            {"level": 1, "text": "Example routing memo", "page": 1},
            {"level": 2, "text": "Scope", "page": 2},
        ],
        "page_count": 2,
        "page_kinds": {1: "digital", 2: "digital"},
    }
    return FixtureSpec("digital-text", "en", "general", "digital", blocks, facts)


def _table_en() -> FixtureSpec:
    header = ("Item", "Qty", "Unit")
    body = tuple((f"Row-{index:02d}", str(index), f"{index * 2}.50") for index in range(1, 13))
    rows = (header, *body)
    blocks = (
        Heading("Quarterly parts list", 1, 1),
        Paragraph("The table on page two exercises structured_full tier scoring.", 1),
        Heading("Inventory", 2, 2),
        Table(rows, 2),
    )
    facts: dict[str, Any] = {
        "parse_class": "table",
        "headings": [
            {"level": 1, "text": "Quarterly parts list", "page": 1},
            {"level": 2, "text": "Inventory", "page": 2},
        ],
        "page_count": 2,
        "page_kinds": {1: "digital", 2: "digital"},
        "tables": {2: rows},
        "vlm_disagreement_pages": [],
    }
    return FixtureSpec("table-en", "en", "financial_report", "digital", blocks, facts)


def _multi_column_en() -> FixtureSpec:
    blocks = (
        Heading("Two-column service bulletin", 1, 1),
        Paragraph("Page one is single-column context for the layout fixture.", 1),
        Heading("Bulletin body", 2, 2),
        ColumnParagraph("Left column copy explains maintenance intervals and torque limits for example valves.", 0, 2),
        ColumnParagraph("Right column copy lists example SKUs and replacement kits used only in routing tests.", 1, 2),
    )
    facts: dict[str, Any] = {
        "parse_class": "multi_column",
        "headings": [
            {"level": 1, "text": "Two-column service bulletin", "page": 1},
            {"level": 2, "text": "Bulletin body", "page": 2},
        ],
        "page_count": 2,
        "page_kinds": {1: "digital", 2: "digital"},
        "multi_column_pages": {2},
        "vlm_disagreement_pages": [2],
    }
    return FixtureSpec("multi-column-en", "en", "general", "digital", blocks, facts)


def _scan_fixture(base: FixtureSpec, parse_class: str) -> FixtureSpec:
    facts = dict(base.facts)
    facts["parse_class"] = parse_class
    facts["page_kinds"] = {1: "scanned"}
    facts["vlm_disagreement_pages"] = [1]
    return FixtureSpec(base.id, base.language, base.doc_type, base.layer, base.blocks, facts, base.write_text)


def _invoice_parse() -> FixtureSpec:
    base = _ingest._invoice_en()
    table_rows = None
    for block in base.blocks:
        if isinstance(block, Table):
            table_rows = block.rows
            break
    facts = dict(base.facts)
    facts["parse_class"] = "invoice"
    facts["page_kinds"] = {1: "digital"}
    if table_rows is not None:
        facts["tables"] = {1: table_rows}
    facts["vlm_disagreement_pages"] = []
    return FixtureSpec(base.id, base.language, base.doc_type, base.layer, base.blocks, facts, base.write_text)


def _mixed_routing() -> FixtureSpec:
    header = ("Lane", "Value", "Status")
    small_table = (header, ("A", "10", "ok"), ("B", "20", "ok"), ("C", "30", "hold"))
    scan_blocks = (
        Heading("Embedded scan slip", 1, 9),
        Paragraph("This image-only page should route to structured_ocr in the mixed document.", 9),
    )
    blocks: list[Any] = []
    for page in range(1, 7):
        blocks.append(Heading(f"Section {page}", 2 if page > 1 else 1, page))
        blocks.append(Paragraph(f"Digital narrative on page {page} for mixed routing coverage.", page))
    for page in (7, 8):
        blocks.append(Heading(f"Table block {page}", 2, page))
        blocks.append(Table(small_table, page))
    blocks.extend(scan_blocks)
    blocks.append(Heading("Closing note", 2, 10))
    blocks.append(Paragraph("Final digital page after the scanned page.", 10))
    facts: dict[str, Any] = {
        "parse_class": "mixed",
        "page_count": 10,
        "page_kinds": {page: "scanned" if page == 9 else "digital" for page in range(1, 11)},
        "headings": [{"level": 1, "text": "Section 1", "page": 1}, {"level": 2, "text": "Closing note", "page": 10}],
        "tables": {7: small_table, 8: small_table},
        "scanned_blocks": {9: scan_blocks},
        "vlm_disagreement_pages": [9],
    }
    return FixtureSpec("mixed-routing", "en", "mixed", "digital", tuple(blocks), facts)


def _cross_boundary() -> FixtureSpec:
    header = ("Metric", "Q1", "Q2", "Q3")
    page4_rows = (header, ("Revenue", "120", "130", "140"), ("Margin", "12", "13", "14"))
    page5_rows = (("Margin", "13", "14", "15"), ("Notes", "steady", "up", "up"))
    blocks = (
        Heading("Continuity workbook", 1, 1),
        Paragraph("Text on pages one through three.", 1),
        Paragraph("More explanatory text on page two.", 2),
        Paragraph("Final lead-in before the split table.", 3),
        Paragraph("The table below continues on the next page.", 4),
        Table(page4_rows, 4),
        Table(page5_rows, 5),
        Paragraph("After-table summary on page six.", 6),
    )
    facts: dict[str, Any] = {
        "parse_class": "cross_boundary",
        "page_count": 6,
        "page_kinds": {page: "digital" for page in range(1, 7)},
        "headings": [{"level": 1, "text": "Continuity workbook", "page": 1}],
        "tables": {4: page4_rows, 5: page5_rows},
        "table_continues_pages": {4},
        "vlm_disagreement_pages": [4, 5],
    }
    return FixtureSpec("cross-boundary", "en", "financial_report", "digital", blocks, facts)


def _scan_zh_it() -> FixtureSpec:
    """A character-exact zh/it scan (03.2-25, D-18): full-width Chinese punctuation and precomposed Italian grave accents."""
    blocks = (
        Heading("中文与意大利文混合扫描页", 1, 1),
        Paragraph("本页用于检验扫描件的逐字识别：每个句子都使用全角标点，包括逗号，分号；以及句号。", 1),
        Paragraph("第二段说明识别结果必须与预期文本完全一致。", 1),
        Heading("Sezione in italiano", 2, 1),
        Paragraph("La qualità del testo è verificata più volte; ciò vale per ogni unità di prova già registrata.", 1),
    )
    facts: dict[str, Any] = {
        "parse_class": "scan_zh_it",
        "headings": [
            {"level": 1, "text": "中文与意大利文混合扫描页", "page": 1},
            {"level": 2, "text": "Sezione in italiano", "page": 1},
        ],
        "page_count": 1,
        "page_kinds": {1: "scanned"},
        "vlm_disagreement_pages": [1],
        "ocr_languages": ("zh", "it"),
        "exact_text": True,
    }
    return FixtureSpec("scan-zh-it", "zh", "scanned_image", "scanned", blocks, facts)


def _bench() -> BenchSpec:
    return BenchSpec("bench-100", "en", (10, 50, 90))


def all_specs() -> tuple[FixtureSpec | BenchSpec, ...]:
    return (
        _digital_text(),
        _table_en(),
        _multi_column_en(),
        _scan_fixture(_ingest._scan_zh(), "scanned_zh"),
        _scan_fixture(_ingest._scan_en(), "scanned_en"),
        _scan_fixture(_ingest._scan_it(), "scanned_it"),
        _invoice_parse(),
        _mixed_routing(),
        _cross_boundary(),
        _scan_zh_it(),
        _bench(),
    )


def fixture_specs_only() -> tuple[FixtureSpec, ...]:
    return tuple(item for item in all_specs() if isinstance(item, FixtureSpec))