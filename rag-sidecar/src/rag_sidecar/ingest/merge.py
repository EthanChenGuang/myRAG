"""Merge Docling range parts with page-order invariants (D-53)."""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping, Sequence

from docling_core.types.doc import (
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)
from docling_core.types.doc.document import DocumentOrigin

_HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
_TABLE_ROW = re.compile(r"^\|(.+)\|$")
_SEPARATOR_ROW = re.compile(r"^\|[\s:|-]+\|$")

DEFAULT_PAGE = Size(width=600, height=800)


class MergeInvariantError(ValueError):
    """Raised when range parts cannot be merged without breaking page numbering."""


def _prov(page_no: int) -> ProvenanceItem:
    box = BoundingBox(l=50.0, t=80.0, r=550.0, b=140.0, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page_no, bbox=box, charspan=(0, 0))


def _contiguous_runs(pages: Sequence[int]) -> list[list[int]]:
    if not pages:
        return []
    ordered = sorted(pages)
    runs: list[list[int]] = [[ordered[0]]]
    for page_no in ordered[1:]:
        if page_no == runs[-1][-1] + 1:
            runs[-1].append(page_no)
        else:
            runs.append([page_no])
    return runs


def _expand_contiguous_parts(parts: Sequence[DoclingDocument]) -> list[DoclingDocument]:
    expanded: list[DoclingDocument] = []
    for part in parts:
        pages = sorted(part.pages)
        if not pages:
            raise MergeInvariantError("merge_invariant:empty_part")
        for run in _contiguous_runs(pages):
            expanded.append(part if run == pages else slice_pages(part, run))
    return expanded


def _validate_parts_tile(parts: Sequence[DoclingDocument], n_pages: int) -> list[DoclingDocument]:
    if not parts:
        raise MergeInvariantError("merge_invariant:no_parts")
    starts = []
    seen: set[int] = set()
    for part in parts:
        pages = sorted(part.pages)
        if not pages:
            raise MergeInvariantError("merge_invariant:empty_part")
        starts.append(pages[0])
        overlap = seen.intersection(pages)
        if overlap:
            raise MergeInvariantError("merge_invariant:gap_or_order")
        seen.update(pages)
    if starts != sorted(starts):
        raise MergeInvariantError("merge_invariant:gap_or_order")
    if sorted(seen) != list(range(1, n_pages + 1)):
        raise MergeInvariantError("merge_invariant:range")
    expanded = _expand_contiguous_parts(parts)
    expanded.sort(key=lambda part: min(part.pages))
    cursor = 1
    for part in expanded:
        pages = sorted(part.pages)
        start, end = pages[0], pages[-1]
        if start != cursor or pages != list(range(start, end + 1)):
            raise MergeInvariantError("merge_invariant:gap_or_order")
        cursor = end + 1
    return expanded


def _assert_post_merge(doc: DoclingDocument, n_pages: int) -> None:
    pages = sorted(doc.pages)
    expected = list(range(1, n_pages + 1))
    if pages != expected:
        raise MergeInvariantError("merge_invariant:pages")
    for collection in (doc.texts, doc.tables, doc.pictures, doc.key_value_items, doc.form_items):
        for item in collection:
            for provenance in item.prov or []:
                page_no = provenance.page_no
                if page_no < 1 or page_no > n_pages:
                    raise MergeInvariantError("merge_invariant:prov_out_of_range")


def merge(parts: Sequence[DoclingDocument], n_pages: int) -> DoclingDocument:
    """Concatenate range documents in page order; single part is returned unchanged."""
    expanded = _validate_parts_tile(parts, n_pages)
    if len(expanded) == 1:
        _assert_post_merge(expanded[0], n_pages)
        return expanded[0]
    merged = DoclingDocument.concatenate(expanded)
    _assert_post_merge(merged, n_pages)
    return merged


def shift_pages(doc: DoclingDocument, offset: int) -> DoclingDocument:
    """A deep copy of ``doc`` with every page number moved by ``offset``; the input is left alone."""
    shifted = doc.model_copy(deep=True)
    shifted.pages = {
        page_no + offset: page.model_copy(update={"page_no": page_no + offset}) for page_no, page in shifted.pages.items()
    }
    for collection in (shifted.texts, shifted.tables, shifted.pictures, shifted.key_value_items, shifted.form_items):
        for item in collection:
            for provenance in item.prov or []:
                provenance.page_no += offset
    return shifted


def join_page_parts(parts: Sequence[DoclingDocument]) -> DoclingDocument:
    """Join non-overlapping parts, keeping the page numbers of the file.

    Contiguous parts are concatenated with the body tree rebuilt; DoclingDocument.concatenate numbers pages from 1, so parts that
    start later are moved down first and the result is moved back. Parts with a gap between them are only listed side by side
    (recorded assembly).
    """
    if not parts:
        raise MergeInvariantError("merge_invariant:no_parts")
    if len(parts) == 1:
        return parts[0]
    page_sets = [sorted(part.pages) for part in parts]
    flat = sorted({page for pages in page_sets for page in pages})
    if flat == list(range(flat[0], flat[-1] + 1)):
        ordered = sorted(parts, key=lambda part: min(part.pages))
        if flat[0] == 1:
            return merge(ordered, flat[-1])
        offset = flat[0] - 1
        lowered = [shift_pages(part, -offset) for part in ordered]
        return shift_pages(merge(lowered, flat[-1] - offset), offset)
    merged = parts[0].model_copy(deep=True)
    merged.pages = {key: value for part in parts for key, value in part.pages.items()}
    merged.texts = []
    merged.tables = []
    merged.pictures = []
    merged.key_value_items = []
    merged.form_items = []
    for part in parts:
        merged.texts.extend(part.texts)
        merged.tables.extend(part.tables)
        merged.pictures.extend(part.pictures)
        merged.key_value_items.extend(part.key_value_items)
        merged.form_items.extend(part.form_items)
    return merged


def _parse_table_rows(lines: list[str]) -> TableData:
    rows: list[list[str]] = []
    for line in lines:
        if _SEPARATOR_ROW.match(line):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        rows.append(cells)
    if not rows:
        raise ValueError("empty table")
    width = len(rows[0])
    table_cells = [
        TableCell(
            text=value,
            start_row_offset_idx=row_index,
            end_row_offset_idx=row_index + 1,
            start_col_offset_idx=col_index,
            end_col_offset_idx=col_index + 1,
            column_header=row_index == 0,
        )
        for row_index, row in enumerate(rows)
        for col_index, value in enumerate(row)
    ]
    return TableData(num_rows=len(rows), num_cols=width, table_cells=table_cells)


def _add_markdown_page(doc: DoclingDocument, page_no: int, markdown: str) -> None:
    lines = markdown.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if _TABLE_ROW.match(line):
            table_lines: list[str] = []
            while index < len(lines) and _TABLE_ROW.match(lines[index]):
                table_lines.append(lines[index])
                index += 1
            doc.add_table(data=_parse_table_rows(table_lines), prov=_prov(page_no))
            continue
        match = _HEADING.match(line)
        if match:
            level = len(match.group(1))
            doc.add_heading(match.group(2).strip(), level=level, prov=_prov(page_no))
            index += 1
            continue
        paragraph_lines = [line]
        index += 1
        while index < len(lines) and lines[index].strip() and not _HEADING.match(lines[index]) and not _TABLE_ROW.match(
            lines[index]
        ):
            paragraph_lines.append(lines[index])
            index += 1
        doc.add_text(DocItemLabel.TEXT, "\n".join(paragraph_lines), prov=_prov(page_no))


def premium_part(
    pages_markdown: Sequence[tuple[int, str]],
    sizes: Mapping[int, Size],
) -> DoclingDocument:
    """Build a Docling part from per-page LlamaParse markdown with original page numbers."""
    doc = DoclingDocument(
        name="premium",
        origin=DocumentOrigin(mimetype="application/pdf", binary_hash=0, filename="premium.pdf"),
    )
    for page_no, _ in pages_markdown:
        doc.add_page(page_no=page_no, size=sizes[page_no])
    for page_no, markdown in pages_markdown:
        if markdown.strip():
            _add_markdown_page(doc, page_no, markdown)
    return doc


def slice_pages(doc: DoclingDocument, pages: Iterable[int]) -> DoclingDocument:
    """Return a document containing only items on the given pages, keeping page numbers.

    Uses DoclingDocument.filter (docling-core 2.107.1), which numbers pages from the first page of the source document; the
    numbers are moved back.
    """
    sliced = doc.filter(page_nrs=set(pages))
    # DoclingDocument.filter numbers pages from the first page of the source document, not from page one of the file.
    offset = min(doc.pages) - 1 if doc.pages else 0
    return shift_pages(sliced, offset) if offset else sliced


def merge_dict_fingerprint(doc: DoclingDocument) -> bytes:
    """Canonical JSON bytes for determinism checks."""
    return json.dumps(doc.export_to_dict(), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()