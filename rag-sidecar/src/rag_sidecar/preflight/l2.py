"""L2 preflight: fast Docling layout on uncertain pages (D-49, A-3)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from docling_core.types.doc import DocItemLabel, DoclingDocument

from rag_sidecar.contracts.routing import Layer, ParseRoutingConfig
from rag_sidecar.ingest.converters import RangeConverter
from rag_sidecar.ingest.pool import UPLOAD_PRIORITY
from rag_sidecar.ingest.quality import page_has_table
from rag_sidecar.preflight.l1 import PageL1

PROBE_L2_PRESET = "fast"


@dataclass
class L2Page:
    l1: PageL1
    l2_has_table: bool | None = None
    l2_inspected: bool = False
    has_structure: bool = False
    uncertain: bool | None = None
    layer: Layer = "L1"

    @property
    def page(self) -> int:
        return self.l1.page

    @property
    def scanned(self) -> bool:
        return self.l1.scanned


def _l1_has_table(page: PageL1) -> bool:
    return page.ruled_tables > 0 or page.aligned_number_rows >= 2 or "tables" in page.signals


def _group_uncertain_ranges(page_nums: list[int], batch_size: int) -> list[tuple[int, int]]:
    if not page_nums:
        return []
    ranges: list[tuple[int, int]] = []
    run_start = page_nums[0]
    run_end = page_nums[0]
    run_len = 1
    for page in page_nums[1:]:
        if page == run_end + 1 and run_len < batch_size:
            run_end = page
            run_len += 1
            continue
        ranges.append((run_start, run_end))
        run_start = run_end = page
        run_len = 1
    ranges.append((run_start, run_end))
    return ranges


def _page_structure_flags(doc: DoclingDocument, page: int) -> tuple[bool, bool, bool]:
    has_table = page_has_table(doc, page)
    has_formula = False
    has_chart = False
    for item, _level in doc.iterate_items():
        if not getattr(item, "prov", None):
            continue
        if not any(prov.page_no == page for prov in item.prov):
            continue
        label = item.label
        if label == DocItemLabel.FORMULA:
            has_formula = True
        if label in (DocItemLabel.PICTURE, getattr(DocItemLabel, "CHART", DocItemLabel.PICTURE)):
            has_chart = True
    has_structure = has_table or has_formula or has_chart
    return has_table, has_formula or has_chart, has_structure


def l2_refine(
    pages: list[PageL1],
    path: Path | str,
    file_sha: str,
    converter: RangeConverter,
    cfg: ParseRoutingConfig,
) -> tuple[list[L2Page], list[int], dict[tuple[int, int], tuple[DoclingDocument, dict[str, Any]]]]:
    """Run fast conversions on uncertain pages; return disagreements and reusable fast conversions."""
    uncertain_by_page = {page.page: page for page in pages if page.uncertain}
    scanned_uncertain = {page_no for page_no, row in uncertain_by_page.items() if row.scanned}
    convertible = [page_no for page_no in uncertain_by_page if page_no not in scanned_uncertain]
    inspected: set[int] = set()
    reusable: dict[tuple[int, int], tuple[DoclingDocument, dict[str, Any]]] = {}
    batch = cfg.l2.uncertain_batch_pages

    for start, end in _group_uncertain_ranges(convertible, batch):
        document, meta = converter.convert(
            Path(path),
            file_sha,
            PROBE_L2_PRESET,
            start,
            end,
            UPLOAD_PRIORITY,
        )
        reusable[(start, end)] = (document, meta)
        for page_no in range(start, end + 1):
            inspected.add(page_no)
            has_table, _has_chart_formula, has_structure = _page_structure_flags(document, page_no)
            # per-page refinement applied when building L2Page list below

    out: list[L2Page] = []
    disagreements: list[int] = []

    for l1 in pages:
        if not l1.uncertain:
            out.append(L2Page(l1=l1, uncertain=False, layer="L1"))
            continue
        if l1.page in scanned_uncertain:
            out.append(
                L2Page(
                    l1=l1,
                    l2_has_table=False,
                    l2_inspected=True,
                    has_structure=False,
                    uncertain=True,
                    layer="L2",
                )
            )
            continue
        if l1.page not in inspected:
            out.append(L2Page(l1=l1, uncertain=True, layer="L1"))
            continue
        _range_key = next((key for key in reusable if key[0] <= l1.page <= key[1]), None)
        assert _range_key is not None
        document, _meta = reusable[_range_key]
        has_table, _chart_formula, has_structure = _page_structure_flags(document, l1.page)
        l1_table = _l1_has_table(l1)
        if l1_table != has_table:
            disagreements.append(l1.page)
        if l1.scanned and not has_structure:
            uncertain = True
            layer: Layer = "L2"
            out.append(
                L2Page(
                    l1=l1,
                    l2_has_table=has_table,
                    l2_inspected=True,
                    has_structure=False,
                    uncertain=uncertain,
                    layer=layer,
                )
            )
            continue
        if has_structure:
            out.append(
                L2Page(
                    l1=l1,
                    l2_has_table=has_table,
                    l2_inspected=True,
                    has_structure=True,
                    uncertain=False,
                    layer="L2",
                )
            )
            continue
        cleared = replace(l1, uncertain=False, signals=[s for s in l1.signals if s != "uncertain"])
        out.append(
            L2Page(
                l1=cleared,
                l2_has_table=False,
                l2_inspected=True,
                has_structure=False,
                uncertain=False,
                layer="L2",
            )
        )

    return out, disagreements, reusable


def sha256_file(path: Path | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()