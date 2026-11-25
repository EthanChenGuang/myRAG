"""D-20 header carry-forward on the Docling path (03.2-28)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
pytest.importorskip("tiktoken")

from docling_core.types.doc import (  # noqa: E402
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)
from docling_core.types.doc.document import DocumentOrigin  # noqa: E402

from rag_sidecar.config_files import config_dir_candidates  # noqa: E402
from rag_sidecar.contracts.ingest import DoclingOptions, ParseJobRequest  # noqa: E402
from rag_sidecar.parse import docling_adapter  # noqa: E402
from rag_sidecar.parse.table_carry import (  # noqa: E402
    carry_table_headers,
    is_header_like,
    load_table_header_rules,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
RECORDED = REPO_ROOT / "eval" / "fixtures" / "ingest" / "recorded"
CONTINUED = ("long-table-zh-continued", "long-table-en-continued", "long-table-it-continued")
PAGE = Size(width=600, height=800)
HEADER = ("Item", "Batch", "First reading", "Second reading", "State")


def _row(index: int) -> tuple[str, ...]:
    return (f"Item {index:02d}", f"Batch {index % 4}", f"{10 + index * 3}.5", f"{200 - index * 7}.25", "steady" if index % 2 else "rising")


def _request(**overrides) -> ParseJobRequest:
    values = {
        "profile_id": "general@1",
        "profile_version": 1,
        "docling": DoclingOptions(ocr=True, force_full_page_ocr=False, table_mode="accurate", heading_hierarchy=True, generate_picture_images=False),
        "ocr_languages": ["en"],
        "max_tokens": 120,
        "repeat_table_header": True,
    }
    values.update(overrides)
    return ParseJobRequest(**values)


def _recorded(fixture_id: str) -> DoclingDocument:
    payload = json.loads((RECORDED / f"{fixture_id}.docling.json").read_text(encoding="utf-8"))
    payload.pop(docling_adapter.SIDECAR_METADATA_KEY, None)
    return DoclingDocument.model_validate(payload)


def _prov(page: int, top: float = 80.0) -> ProvenanceItem:
    return ProvenanceItem(page_no=page, bbox=BoundingBox(l=50, t=top, r=550, b=top + 40, coord_origin=CoordOrigin.TOPLEFT), charspan=(0, 0))


def _table_data(rows: list[tuple[str, ...]], header: bool) -> TableData:
    cells = [
        TableCell(
            text=value,
            start_row_offset_idx=r,
            end_row_offset_idx=r + 1,
            start_col_offset_idx=c,
            end_col_offset_idx=c + 1,
            column_header=header and r == 0,
        )
        for r, row in enumerate(rows)
        for c, value in enumerate(row)
    ]
    return TableData(num_rows=len(rows), num_cols=len(rows[0]), table_cells=cells)


def _document(*blocks: tuple, pages: int = 3) -> DoclingDocument:
    """Blocks: ("table", page, rows, header) or ("text", page, text), in reading order."""
    doc = DoclingDocument(name="synthetic", origin=DocumentOrigin(mimetype="application/pdf", binary_hash=7, filename="synthetic.pdf"))
    for page in range(1, pages + 1):
        doc.add_page(page_no=page, size=PAGE)
    for block in blocks:
        if block[0] == "table":
            _, page, rows, header = block
            doc.add_table(data=_table_data(list(rows), header), prov=_prov(page, 300))
        else:
            _, page, text = block
            doc.add_text(DocItemLabel.TEXT, text, prov=_prov(page))
    return doc


FIRST = [HEADER, *(_row(i) for i in range(1, 9))]
SECOND = [_row(i) for i in range(9, 17)]
THIRD = [_row(i) for i in range(17, 23)]


def _texts(table) -> list[list[str]]:
    return [[cell.text for cell in row] for row in table.data.grid]


# ---------------------------------------------------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------------------------------------------------


def test_the_rules_are_read_from_the_shared_table_header_rules_file():
    rules = load_table_header_rules()
    for directory in config_dir_candidates():
        payload = json.loads((directory / "table-header-rules.json").read_text(encoding="utf-8"))
        assert rules.rules_version == payload["rules_version"]
        assert rules.numeric_cell_pattern == payload["numeric_cell_pattern"]
        assert rules.min_non_numeric_share == payload["min_non_numeric_share"]
        assert rules.max_repeated_value_share == payload["max_repeated_value_share"]


def test_header_likeness_follows_the_shared_thresholds():
    rules = load_table_header_rules()
    data = [list(_row(i)) for i in range(1, 6)]
    assert is_header_like(list(HEADER), data, rules)
    assert not is_header_like(data[0], [list(HEADER), *data[1:]], rules)
    assert is_header_like(["", "", ""], data, rules)
    # Text cells that repeat as values in the same column of the neighbouring rows are data, not a header.
    assert not is_header_like(["Item 02", "Batch 2", "Lot", "Group", "rising"], data, rules)


@pytest.mark.parametrize("fixture_id", CONTINUED)
def test_a_page_continued_recording_carries_the_first_header_onto_its_second_table(fixture_id):
    doc = _recorded(fixture_id)
    before = doc.export_to_dict()

    carry = carry_table_headers(doc)

    assert carry.carried == ("#/tables/1",)
    first, second = carry.document.tables
    original_second = doc.tables[1]
    assert _texts(second)[0] == _texts(first)[0]
    assert _texts(second)[1:] == _texts(original_second)
    assert all(cell.column_header for cell in second.data.table_cells if cell.start_row_offset_idx == 0)
    assert doc.export_to_dict() == before


@pytest.mark.parametrize(
    "blocks",
    [
        pytest.param((("table", 1, FIRST, True), ("table", 2, [HEADER, *SECOND], False)), id="own-header-row"),
        pytest.param((("table", 1, FIRST, True), ("table", 2, [SECOND[0][:4], *(row[:4] for row in SECOND[1:])], False)), id="other-column-count"),
        pytest.param((("table", 1, FIRST, True), ("text", 2, "A short synthetic note."), ("table", 2, SECOND, False)), id="not-at-page-start"),
        pytest.param((("table", 1, FIRST, True), ("table", 1, SECOND, False)), id="same-page"),
        pytest.param((("table", 1, FIRST, True), ("table", 3, SECOND, False)), id="page-gap"),
        pytest.param((("table", 1, [_row(0), *FIRST[1:]], False), ("table", 2, SECOND, False)), id="first-table-without-header"),
    ],
)
def test_a_table_that_is_not_a_continuation_is_left_untouched(blocks):
    doc = _document(*blocks)
    carry = carry_table_headers(doc)
    assert carry.carried == ()
    assert carry.document.export_to_dict() == doc.export_to_dict()


def test_a_flagged_column_header_counts_as_the_tables_own_header():
    doc = _document(("table", 1, FIRST, True), ("table", 2, SECOND, True))
    assert carry_table_headers(doc).carried == ()


def test_a_chain_of_continuations_keeps_the_first_header():
    doc = _document(("table", 1, FIRST, True), ("table", 2, SECOND, False), ("table", 3, THIRD, False))
    carry = carry_table_headers(doc)
    assert carry.carried == ("#/tables/1", "#/tables/2")
    assert [_texts(table)[0] for table in carry.document.tables] == [list(HEADER)] * 3
    assert [len(_texts(table)) for table in carry.document.tables] == [len(FIRST), len(SECOND) + 1, len(THIRD) + 1]


# ---------------------------------------------------------------------------------------------------------------------
# to_parse_result: chunk the copy, store the original
# ---------------------------------------------------------------------------------------------------------------------


def _parse(doc: DoclingDocument, tmp_path: Path, name: str, **overrides):
    out_dir = tmp_path / name
    out_dir.mkdir()
    return docling_adapter.to_parse_result(doc, _request(**overrides), out_dir), out_dir


@pytest.mark.parametrize("fixture_id", CONTINUED)
def test_with_the_flag_every_chunk_of_the_second_table_starts_with_the_carried_header(fixture_id, tmp_path):
    doc = _recorded(fixture_id)
    header = "\n".join(next(chunk for chunk in _parse(doc, tmp_path, "plain")[0].chunks if chunk.is_table).text.splitlines()[:2])

    result, out_dir = _parse(doc, tmp_path, "carried", carry_table_header=True)

    tables = [chunk for chunk in result.chunks if chunk.is_table]
    second = [chunk for chunk in tables if chunk.pages == [2]]
    assert second and all(chunk.text.startswith(header + "\n") for chunk in tables)
    assert all(chunk.table_header_carried is True for chunk in second)
    assert all(chunk.table_header_carried is None for chunk in tables if chunk.pages == [1])
    assert all(chunk.table_header_carried is None for chunk in result.chunks if not chunk.is_table)
    assert "table_header_carried" not in json.dumps([chunk.model_dump(mode="json") for chunk in tables if chunk.pages == [1]])


@pytest.mark.parametrize("fixture_id", CONTINUED)
def test_the_stored_docling_json_and_markdown_are_those_of_the_unmodified_document(fixture_id, tmp_path):
    doc = _recorded(fixture_id)
    plain, plain_dir = _parse(doc, tmp_path, "plain")
    carried, carried_dir = _parse(doc, tmp_path, "carried", carry_table_header=True)

    assert (carried_dir / "docling.json").read_bytes() == (plain_dir / "docling.json").read_bytes()
    assert carried.markdown == plain.markdown
    assert carried.chunks != plain.chunks


@pytest.mark.parametrize("fixture_id", CONTINUED)
def test_without_the_flag_nothing_is_carried(fixture_id, tmp_path):
    result, _ = _parse(_recorded(fixture_id), tmp_path, "plain")
    header_line = next(chunk for chunk in result.chunks if chunk.is_table).text.splitlines()[0]
    second = [chunk for chunk in result.chunks if chunk.is_table and chunk.pages == [2]]
    assert all(chunk.table_header_carried is None for chunk in result.chunks)
    assert second[0].text.splitlines()[0] != header_line


def test_a_table_with_its_own_header_is_chunked_exactly_as_without_the_flag(tmp_path):
    doc = _document(("table", 1, FIRST, True), ("table", 2, [HEADER, *SECOND], True))
    plain, _ = _parse(doc, tmp_path, "plain")
    carried, _ = _parse(doc, tmp_path, "carried", carry_table_header=True)
    assert carried.chunks == plain.chunks


# ---------------------------------------------------------------------------------------------------------------------
# Every route reaches it: fixed routing (convert), stored-JSON re-chunk
# ---------------------------------------------------------------------------------------------------------------------


class _FakeDocumentConverter:
    def __init__(self, document: DoclingDocument) -> None:
        self.document = document

    def convert(self, source, **kwargs):  # noqa: ANN001, ANN003, ANN201
        from types import SimpleNamespace

        return SimpleNamespace(status="success", document=self.document, input=SimpleNamespace(page_count=2))


def _carried_second_table(result) -> list:
    return [chunk for chunk in result.chunks if chunk.table_header_carried]


def test_the_fixed_routing_convert_path_applies_the_carry(tmp_path):
    doc = _recorded("long-table-en-continued")
    converter = docling_adapter.DoclingConverter(converter_factory=lambda _request: _FakeDocumentConverter(doc))
    source = tmp_path / "input.pdf"
    source.write_bytes(b"%PDF-1.4 synthetic")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    result = converter.convert(source, _request(input_format="pdf", carry_table_header=True), out_dir)

    assert _carried_second_table(result)


def test_a_stored_docling_json_is_rechunked_with_the_carry_and_stays_unmodified(tmp_path):
    stored = tmp_path / "stored"
    stored.mkdir()
    docling_adapter.write_docling_json(_recorded("long-table-en-continued"), stored, "docling", "docling-9.9.9")

    def must_not_build(_request):  # noqa: ANN001, ANN202
        raise AssertionError("no pipeline for a stored docling.json")

    converter = docling_adapter.DoclingConverter(converter_factory=must_not_build)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    result = converter.convert(stored / "docling.json", _request(input_format="json_docling", carry_table_header=True), out_dir)

    assert _carried_second_table(result)
    assert json.loads((out_dir / "docling.json").read_text("utf-8")) == json.loads((stored / "docling.json").read_text("utf-8"))
