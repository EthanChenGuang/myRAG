"""Tests for range merge, premium markdown parts and page slicing."""

from __future__ import annotations

import json

import pytest

pytest.importorskip("docling_core.transforms.chunker.hierarchical_chunker")

from docling_core.transforms.chunker.hierarchical_chunker import HierarchicalChunker  # noqa: E402
from docling_core.types.doc import (  # noqa: E402
    BoundingBox,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    ProvenanceItem,
    Size,
)
from docling_core.types.doc.document import DocumentOrigin  # noqa: E402

from rag_sidecar.ingest.merge import (  # noqa: E402
    MergeInvariantError,
    merge,
    merge_dict_fingerprint,
    premium_part,
    slice_pages,
)

PAGE = Size(width=600, height=800)


def _prov(page_no: int) -> ProvenanceItem:
    box = BoundingBox(l=50, t=80, r=550, b=140, coord_origin=CoordOrigin.TOPLEFT)
    return ProvenanceItem(page_no=page_no, bbox=box, charspan=(0, 0))


def _structured_part(page_nos: list[int], headings: list[tuple[int, str, int]], body: list[tuple[int, str]]) -> DoclingDocument:
    doc = DoclingDocument(name="range", origin=DocumentOrigin(mimetype="application/pdf", binary_hash=1, filename="r.pdf"))
    for page_no in page_nos:
        doc.add_page(page_no=page_no, size=PAGE)
    for page_no, text, level in headings:
        doc.add_heading(text, level=level, prov=_prov(page_no))
    for page_no, text in body:
        doc.add_text(DocItemLabel.TEXT, text, prov=_prov(page_no))
    return doc


def _scenario_parts():
    part1 = _structured_part(
        [1, 2, 3],
        [(1, "Chapter 1", 1), (2, "1.1 Sub", 2)],
        [(3, "end of chapter one")],
    )
    part2 = _structured_part([4], [], [(4, "plain page four")])
    part3 = _structured_part([5], [(5, "Chapter 2", 1)], [(5, "start chapter two")])
    return part1, part2, part3


def test_three_parts_merge_to_pages_one_through_five_with_heading_continuity():
    merged = merge(list(_scenario_parts()), n_pages=5)
    assert sorted(merged.pages) == [1, 2, 3, 4, 5]
    chunker = HierarchicalChunker()
    page_four_headings = None
    for chunk in chunker.chunk(dl_doc=merged):
        pages = {provenance.page_no for item in chunk.meta.doc_items for provenance in item.prov}
        if 4 in pages:
            page_four_headings = list(chunk.meta.headings or [])
            break
    assert page_four_headings == ["Chapter 1", "1.1 Sub"]


def test_premium_part_keeps_original_page_numbers():
    sizes = {4: PAGE, 5: PAGE}
    markdown = [
        (4, "# Chapter 2\nPremium page four"),
        (5, "Page five body"),
    ]
    part = premium_part(markdown, sizes)
    merged = merge([_structured_part([1, 2, 3], [(1, "Chapter 1", 1), (2, "1.1 Sub", 2)], []), part], n_pages=5)
    assert sorted(merged.pages) == [1, 2, 3, 4, 5]
    assert any(item.prov[0].page_no == 5 for item in merged.texts)


def test_premium_part_without_add_page_fails_merge_invariant():
    sizes = {4: PAGE, 5: PAGE}
    bad = premium_part([(4, "a"), (5, "b")], sizes)
    # Drop registered pages to reproduce F-2 renumbering hazard
    bad.pages.clear()
    good_parts = [_structured_part([1, 2, 3], [], [(1, "one")]), bad]
    with pytest.raises(MergeInvariantError, match="merge_invariant"):
        merge(good_parts, n_pages=5)


@pytest.mark.parametrize(
    "parts_builder",
    [
        lambda: (_structured_part([4, 5], [], []), _structured_part([1, 2, 3], [], [])),
        lambda: (_structured_part([1, 2, 3], [], []), _structured_part([3, 4], [], [])),
        lambda: (_structured_part([1, 2, 3], [], []), _structured_part([5], [], [])),
    ],
)
def test_out_of_order_overlapping_or_gapped_parts_raise_before_concatenation(parts_builder):
    with pytest.raises(MergeInvariantError, match="merge_invariant"):
        merge(list(parts_builder()), n_pages=5)


def test_merging_twice_is_byte_identical():
    parts = list(_scenario_parts())
    first = merge(parts, n_pages=5)
    second = merge(parts, n_pages=5)
    assert merge_dict_fingerprint(first) == merge_dict_fingerprint(second)
    assert json.loads(merge_dict_fingerprint(first)) == json.loads(merge_dict_fingerprint(second))


def test_slice_pages_drops_only_excluded_pages_and_merge_recovers_full_range():
    base = _structured_part(list(range(1, 11)), [], [(page, f"page {page}") for page in range(1, 11)])
    kept = slice_pages(base, {1, 2, 3, 6, 7, 8, 9, 10})
    assert sorted(kept.pages) == [1, 2, 3, 6, 7, 8, 9, 10]
    assert 4 not in kept.pages and 5 not in kept.pages
    assert all(item.prov[0].page_no != 4 for item in kept.texts)
    middle = _structured_part([4, 5], [], [(4, "four"), (5, "five")])
    merged = merge([kept, middle], n_pages=10)
    assert sorted(merged.pages) == list(range(1, 11))