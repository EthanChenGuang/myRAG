"""Tests for rag_sidecar.ingest.quality (D-14, D-52)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("docling_core.types.doc")

from docling_core.types.doc import (  # noqa: E402
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
    TableCell,
)
from docling_core.types.doc.document import DocumentOrigin, TableData  # noqa: E402

from rag_sidecar.contracts.routing import PageSignals, ParseRoutingConfig  # noqa: E402
from rag_sidecar.ingest.quality import TextPage, check, check_text_pages, page_has_table, page_text  # noqa: E402

_ROOT = Path(__file__).resolve().parents[2]
_CFG = ParseRoutingConfig.model_validate(
    json.loads((_ROOT / "config" / "rag" / "parse-routing.json").read_text(encoding="utf-8"))
)
_PROFILE = ["en", "it", "zh"]
_PAGE = Size(width=600, height=800)


def _prov(page_no: int) -> ProvenanceItem:
    box = BoundingBox(l=50, t=80, r=550, b=140, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page_no, bbox=box, charspan=(0, 0))


def _signals(page: int, **overrides) -> PageSignals:
    fields = {
        "page": page,
        "chars": 100,
        "text_layer": True,
        "image_area_ratio": 0.0,
        "ruled_tables": 0,
        "aligned_number_rows": 0,
        "multi_column": False,
        "has_figure": False,
        "scanned": False,
        "garbled_ratio": 0.0,
        "signals": [],
        "layer": "L1",
        "tier": "fast",
        "preset": "fast",
        "continues_to_next": False,
    }
    fields.update(overrides)
    return PageSignals(**fields)


def test_empty_page_gets_empty_text_and_score_at_most_seven_tenths():
    result = check_text_pages(
        [TextPage(page=1, text="   ")],
        [_signals(1)],
        _PROFILE,
        _CFG,
    )
    assert "empty_text" in result.pages[0].failed
    assert result.score <= 0.7


def test_low_chars_when_parsed_text_is_forty_percent_of_text_layer():
    result = check_text_pages(
        [TextPage(page=1, text="x" * 40)],
        [_signals(1, chars=100, text_layer=True)],
        _PROFILE,
        _CFG,
    )
    assert "low_chars" in result.pages[0].failed


def test_scanned_page_with_twenty_five_chars_fails_and_thirty_one_passes():
    fail = check_text_pages(
        [TextPage(page=1, text="x" * 25)],
        [_signals(1, scanned=True, text_layer=False)],
        _PROFILE,
        _CFG,
    )
    ok = check_text_pages(
        [TextPage(page=1, text="x" * 31)],
        [_signals(1, scanned=True, text_layer=False)],
        _PROFILE,
        _CFG,
    )
    assert "low_chars" in fail.pages[0].failed
    assert "low_chars" not in ok.pages[0].failed


def test_garbled_above_five_percent_fails_and_four_percent_passes():
    bad = check_text_pages(
        [TextPage(page=1, text=("a" * 94) + ("\ufffd" * 6))],
        [_signals(1)],
        _PROFILE,
        _CFG,
    )
    ok = check_text_pages(
        [TextPage(page=1, text=("a" * 96) + ("\ufffd" * 4))],
        [_signals(1)],
        _PROFILE,
        _CFG,
    )
    assert "garbled" in bad.pages[0].failed
    assert "garbled" not in ok.pages[0].failed


def test_mojibake_sequences_count_toward_garbled():
    result = check_text_pages(
        [TextPage(page=1, text=("good " * 8) + "â€" * 20 + ("text " * 8))],
        [_signals(1)],
        _PROFILE,
        _CFG,
    )
    assert "garbled" in result.pages[0].failed


def _english_layer_sample() -> str:
    return (
        "The annual contract between the parties shall remain valid for the stated period "
        "and the purchaser must submit every request within the published timeframe to "
        "receive refunds under the standard policy for the region."
    )


def _italian_body(length: int) -> str:
    snippet = (
        "Il pagamento della fattura deve essere effettuato entro trenta giorni dalla data di emissione "
        "e la società provvederà alla registrazione secondo il regolamento vigente. "
    )
    return (snippet * ((length // len(snippet)) + 1))[:length]


def test_language_mismatch_for_long_italian_against_confident_english_layer():
    result = check_text_pages(
        [TextPage(page=1, text=_italian_body(500))],
        [_signals(1, text_layer=True)],
        _PROFILE,
        _CFG,
        text_layer_samples={1: _english_layer_sample()},
    )
    assert "language_mismatch" in result.pages[0].failed


def test_language_check_skipped_for_ranges_under_two_hundred_characters():
    result = check_text_pages(
        [TextPage(page=1, text=_italian_body(150))],
        [_signals(1, text_layer=True)],
        _PROFILE,
        _CFG,
        text_layer_samples={1: _english_layer_sample()},
    )
    assert "language_mismatch" not in result.pages[0].failed


def test_missing_table_when_preflight_hinted_but_output_has_no_table():
    result = check_text_pages(
        [TextPage(page=1, text="Body without table", has_table=False)],
        [_signals(1, ruled_tables=2, signals=["tables"])],
        _PROFILE,
        _CFG,
    )
    assert "missing_table" in result.pages[0].failed


def test_table_signal_with_filled_table_passes():
    result = check_text_pages(
        [TextPage(page=1, text="| A |", has_table=True)],
        [_signals(1, ruled_tables=2, signals=["tables"])],
        _PROFILE,
        _CFG,
    )
    assert "missing_table" not in result.pages[0].failed


def test_partial_conversion_when_document_flagged():
    result = check_text_pages(
        [TextPage(page=1, text="Some text")],
        [_signals(1)],
        _PROFILE,
        _CFG,
        partial=True,
    )
    assert result.partial is True
    assert "partial_conversion" in result.pages[0].failed


def test_per_page_parse_success_false_marks_partial_conversion():
    result = check_text_pages(
        [TextPage(page=1, text="Page body", parse_success=False)],
        [_signals(1)],
        _PROFILE,
        _CFG,
    )
    assert "partial_conversion" in result.pages[0].failed


def test_table_boundary_on_second_range_first_page():
    result = check_text_pages(
        [TextPage(page=5, text="1,234.50\n2,345.00", has_table=False)],
        [_signals(5, aligned_number_rows=3)],
        _PROFILE,
        _CFG,
        boundary_prev_ends_in_table=True,
        first_page=5,
    )
    assert "table_boundary" in result.pages[0].failed


def test_attempts_are_ranked_by_score():
    poor = check_text_pages(
        [TextPage(page=1, text="x" * 10)],
        [_signals(1, chars=100)],
        _PROFILE,
        _CFG,
    )
    better = check_text_pages(
        [TextPage(page=1, text="x" * 60)],
        [_signals(1, chars=100)],
        _PROFILE,
        _CFG,
    )
    assert better.score > poor.score


def test_check_is_deterministic():
    pages = [TextPage(page=1, text="Stable body text with enough english stopwords for the contract")]
    preflight = [_signals(1)]
    first = check_text_pages(pages, preflight, _PROFILE, _CFG)
    second = check_text_pages(pages, preflight, _PROFILE, _CFG)
    assert first == second


def _doc_with_table(page_no: int, filled: bool) -> DoclingDocument:
    doc = DoclingDocument(
        name="t",
        origin=DocumentOrigin(mimetype="application/pdf", binary_hash=9, filename="t.pdf"),
    )
    doc.add_page(page_no=page_no, size=_PAGE)
    doc.add_text(DocItemLabel.TEXT, "Intro", prov=_prov(page_no))
    cells: list[TableCell] = []
    if filled:
        cells = [
            TableCell(
                text="Amount",
                start_row_offset_idx=0,
                end_row_offset_idx=1,
                start_col_offset_idx=0,
                end_col_offset_idx=1,
                column_header=True,
            ),
            TableCell(
                text="1200",
                start_row_offset_idx=1,
                end_row_offset_idx=2,
                start_col_offset_idx=0,
                end_col_offset_idx=1,
            ),
        ]
    data = TableData(num_rows=2 if filled else 0, num_cols=1 if filled else 0, table_cells=cells)
    doc.add_table(data=data, prov=_prov(page_no))
    return doc


def test_docling_page_text_and_table_helpers():
    doc = _doc_with_table(1, filled=True)
    assert "Intro" in page_text(doc, 1)
    assert "Amount" in page_text(doc, 1)
    assert page_has_table(doc, 1) is True
    empty_table = _doc_with_table(1, filled=False)
    assert page_has_table(empty_table, 1) is False


def test_check_runs_over_docling_document():
    doc = _doc_with_table(1, filled=True)
    result = check(
        doc,
        [_signals(1, chars=20)],
        _PROFILE,
        _CFG,
    )
    assert result.pages[0].page == 1
    assert result.passed is True