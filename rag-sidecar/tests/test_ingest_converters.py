"""Range conversion with recorded fixtures and sub-range slicing (03.1-23)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")

from docling_core.types.doc import DocItemLabel, DoclingDocument, Size  # noqa: E402

from rag_sidecar.ingest import converters  # noqa: E402
from rag_sidecar.ingest.merge import slice_pages  # noqa: E402
from rag_sidecar.preflight.config import load_routing_config  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
RECORDED = REPO / "eval" / "fixtures" / "parse" / "recorded"
MIXED_SHA = "1ae7eaff14736765335fab82e5e214501c088cf403ad52b1500183128e819605"
BENCH_SHA = "5eb4e6a776e11143174d088f3bc9f1048cae8bd6792778e08b0b9ec8a4c0ee0c"


@pytest.fixture(autouse=True)
def _reset_counter():
    converters.reset_conversion_counter()
    yield
    converters.reset_conversion_counter()


def test_recorded_fast_tables_have_no_cells_on_mixed_pages_seven_and_eight():
    converter = converters.RecordedRangeConverter(RECORDED)
    doc, _meta = converter.convert(Path("ignored.pdf"), MIXED_SHA, "fast", 7, 8, priority=100)
    assert sorted(doc.pages) == [7, 8]
    for table in doc.tables:
        assert table.data.table_cells == []


def test_recorded_structured_full_tables_have_cells_on_mixed_pages_seven_and_eight():
    converter = converters.RecordedRangeConverter(RECORDED)
    doc, _meta = converter.convert(Path("ignored.pdf"), MIXED_SHA, "structured_full", 7, 8, priority=100)
    assert any(table.data.table_cells for table in doc.tables)


def test_recorded_miss_is_permanent():
    converter = converters.RecordedRangeConverter(RECORDED)
    with pytest.raises(converters.RecordedMiss):
        converter.convert(Path("ignored.pdf"), "0" * 64, "fast", 1, 1, priority=100)


def test_low_priority_splits_sixty_pages_into_three_conversions(monkeypatch, tmp_path):
    calls: list[tuple[int, int]] = []

    def fake_convert(_path: Path, _preset: str, start: int, end: int, **_: Any) -> DoclingDocument:
        calls.append((start, end))
        from docling_core.types.doc import BoundingBox, CoordOrigin, ProvenanceItem

        box = BoundingBox(l=1, t=1, r=2, b=2, coord_origin=CoordOrigin.TOPLEFT)
        doc = DoclingDocument(name=f"{start}-{end}")
        page = Size(width=595.28, height=841.89)
        for number in range(start, end + 1):
            doc.add_page(page_no=number, size=page)
            doc.add_text(DocItemLabel.TEXT, f"page {number}", prov=ProvenanceItem(page_no=number, bbox=box, charspan=(0, 1)))
        return doc

    monkeypatch.setattr(converters, "_docling_convert_range", fake_convert)
    cfg = load_routing_config()
    pdf = tmp_path / "bench.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    converter = converters.DoclingRangeConverter(max_pages_per_conversion=cfg.ranges.max_pages_per_conversion)
    _doc, meta = converter.convert(pdf, BENCH_SHA, "fast", 1, 60, priority=10)
    assert calls == [(1, 24), (25, 48), (49, 60)]
    assert meta["sub_ranges"] == 3
    assert converters.conversion_counter == 3
    assert sorted(_doc.pages) == list(range(1, 61))


def test_high_priority_converts_a_long_range_in_one_call(monkeypatch, tmp_path):
    calls: list[tuple[int, int]] = []

    def fake_convert(_path: Path, _preset: str, start: int, end: int, **_: Any) -> DoclingDocument:
        calls.append((start, end))
        return DoclingDocument(name="slice")

    monkeypatch.setattr(converters, "_docling_convert_range", fake_convert)
    pdf = tmp_path / "bench.pdf"
    pdf.write_bytes(b"%PDF-1.4\n")
    converter = converters.DoclingRangeConverter(max_pages_per_conversion=24)
    converter.convert(pdf, BENCH_SHA, "fast", 1, 60, priority=100)
    assert calls == [(1, 60)]
    assert converters.conversion_counter == 1


def test_json_docling_rechunk_does_not_increment_conversion_counter(monkeypatch, tmp_path):
    monkeypatch.setattr(
        converters,
        "_docling_convert_range",
        MagicMock(side_effect=AssertionError("unexpected conversion")),
    )
    payload = DoclingDocument(name="cached").export_to_dict()
    path = tmp_path / "stored.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    converter = converters.DoclingRangeConverter()
    converter.convert(path, "deadbeef", "fast", 1, 3, priority=10)
    assert converters.conversion_counter == 0


def test_select_range_converter_by_name():
    recorded = converters.select_range_converter("recorded", recorded_root=RECORDED)
    assert isinstance(recorded, converters.RecordedRangeConverter)
    docling = converters.select_range_converter("docling")
    assert isinstance(docling, converters.DoclingRangeConverter)

def test_recorded_bench_pages_come_out_with_the_page_numbers_that_were_asked_for():
    converter = converters.RecordedRangeConverter(RECORDED)

    doc, _meta = converter.convert(Path("ignored.pdf"), BENCH_SHA, "structured_full", 10, 11, priority=100)

    assert sorted(doc.pages) == [10, 11]
    pages_by_text = {item.text: [prov.page_no for prov in item.prov] for item, _level in doc.iterate_items() if getattr(item, "text", "")}
    assert pages_by_text["Benchmark page 10"] == [10]
    assert pages_by_text["Benchmark page 11"] == [11]


@pytest.mark.parametrize(
    "sha",
    [
        "01a39e099b820ce5131bd172506de7593714a733ac3a3c9285869a1231b3c178",
        "34db8c840cb74f72864ea8b2ccdb0aa5a37024d65252c66f2845927358c61724",
        "c855808f1364b6016406e2359c5dc114a5c33eab0c0b2575cc9d7fd0a1994ad8",
    ],
)
def test_recorded_fast_scan_page_converts_to_an_empty_page(sha):
    """A forced fast tier (03.1-47) reaches the fast recording of a scanned page: it must load and hold no text."""
    converter = converters.RecordedRangeConverter(RECORDED)
    doc, _meta = converter.convert(Path("ignored.pdf"), sha, "fast", 1, 1, priority=100)
    assert sorted(doc.pages) == [1]
    assert doc.texts == []


def test_recorded_fast_scanned_page_of_the_mixed_fixture_converts():
    converter = converters.RecordedRangeConverter(RECORDED)
    doc, _meta = converter.convert(Path("ignored.pdf"), MIXED_SHA, "fast", 9, 9, priority=100)
    assert sorted(doc.pages) == [9]
    assert doc.texts == []


MULTI_COLUMN_SHA = "70ab25776a5d090c9367458ea947e64c846686f3580c138ea0c6808fff211983"


@pytest.mark.parametrize("preset", ["fast", "structured_layout", "structured_full", "structured_ocr"])
def test_recorded_multi_column_page_holds_both_columns_left_first(preset):
    converter = converters.RecordedRangeConverter(RECORDED)
    doc, _meta = converter.convert(Path("ignored.pdf"), MULTI_COLUMN_SHA, preset, 2, 2, priority=100)
    texts = [item.text for item in doc.texts]
    left = next(index for index, text in enumerate(texts) if text.startswith("Left column copy"))
    right = next(index for index, text in enumerate(texts) if text.startswith("Right column copy"))
    assert left < right
