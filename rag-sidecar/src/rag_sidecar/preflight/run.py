"""Compose the tiered preflight probe (D-12)."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from docling_core.types.doc import DoclingDocument

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import (
    DetectCounts,
    Layer,
    PageRange,
    PageSignal,
    PageSignals,
    ParseRoutingConfig,
    ParseTier,
    PreflightResult,
)
from rag_sidecar.ingest.converters import RangeConverter
from rag_sidecar.preflight.classify import classify
from rag_sidecar.preflight.l1 import EncryptedPdf, l1_signals
from rag_sidecar.preflight.l2 import L2Page, l2_refine, sha256_file
from rag_sidecar.preflight.ranges import TieredPage, build_ranges
from rag_sidecar.preflight.tiers import LayerResults, page_tier

PROBE_VERSION = "2026.1"

L3Hook = Callable[[list[L2Page], list[int], Path, JobSettingsSnapshot | None, ParseRoutingConfig], list[L2Page]]


@dataclass(frozen=True)
class PreflightOutput:
    result: PreflightResult
    reusable_fast: dict[tuple[int, int], tuple[DoclingDocument, dict[str, Any]]]


def _default_bounds(
    settings: JobSettingsSnapshot | None,
) -> tuple[ParseTier | None, ParseTier | None]:
    if settings is None:
        return "fast", "premium"
    return settings.min_tier, settings.max_tier


def _signals_for_page(page: L2Page) -> list[PageSignal]:
    signals = list(page.l1.signals)
    if not page.uncertain and "uncertain" in signals:
        signals = [signal for signal in signals if signal != "uncertain"]
    if page.has_structure and "tables" not in signals and (page.l2_has_table or page.l1.ruled_tables > 0):
        signals.append("tables")
    return signals


def _l1_has_table(page: L2Page) -> bool:
    return page.l1.ruled_tables > 0 or page.l1.aligned_number_rows >= 2 or "tables" in page.l1.signals


def _to_tiered_pages(
    pages: list[L2Page],
    min_tier: ParseTier | None,
    max_tier: ParseTier | None,
) -> list[TieredPage]:
    tiered: list[TieredPage] = []
    for page in pages:
        signal_list = _signals_for_page(page)
        probe = PageSignals(
            page=page.l1.page,
            chars=page.l1.chars,
            text_layer=page.l1.text_layer,
            image_area_ratio=page.l1.image_area_ratio,
            ruled_tables=page.l1.ruled_tables,
            aligned_number_rows=page.l1.aligned_number_rows,
            multi_column=page.l1.multi_column,
            has_figure=page.l1.has_figure,
            scanned=page.l1.scanned,
            garbled_ratio=page.l1.garbled_ratio,
            signals=signal_list,
            layer=page.layer,
            tier="fast",
            preset="fast",
            continues_to_next=page.l1.continues_to_next,
        )
        layers = LayerResults(
            l1_has_table=_l1_has_table(page),
            l2_has_table=page.l2_has_table,
        )
        tier, preset = page_tier(probe, layers, min_tier, max_tier)
        tiered.append(
            TieredPage(
                page=page.l1.page,
                tier=tier,
                preset=preset,
                continues_to_next=page.l1.continues_to_next,
                signals=signal_list,
                layer=page.layer,
            )
        )
    return tiered


def _finalize_page_signals(
    pages: list[L2Page],
    tiered: list[TieredPage],
    ranges: list[PageRange],
) -> list[PageSignals]:
    by_page = {item.page: item for item in tiered}
    range_layer: dict[int, Layer] = {}
    for page_range in ranges:
        for page_no in range(page_range.start, page_range.end + 1):
            range_layer[page_no] = page_range.layer
    out: list[PageSignals] = []
    for page in pages:
        tier_row = by_page[page.l1.page]
        layer = range_layer.get(page.l1.page, page.layer)
        out.append(
            PageSignals(
                page=page.l1.page,
                chars=page.l1.chars,
                text_layer=page.l1.text_layer,
                image_area_ratio=page.l1.image_area_ratio,
                ruled_tables=page.l1.ruled_tables,
                aligned_number_rows=page.l1.aligned_number_rows,
                multi_column=page.l1.multi_column,
                has_figure=page.l1.has_figure,
                scanned=page.l1.scanned,
                garbled_ratio=page.l1.garbled_ratio,
                signals=_signals_for_page(page),
                layer=layer,
                tier=tier_row.tier,
                preset=tier_row.preset,
                continues_to_next=page.l1.continues_to_next,
            )
        )
    return out


def _tier_page_counts(page_rows: list[PageSignals]) -> dict[ParseTier, int]:
    counts: dict[ParseTier, int] = {"native": 0, "fast": 0, "structured": 0, "premium": 0}
    for row in page_rows:
        counts[row.tier] += 1
    return counts


def _noop_l3(
    pages: list[L2Page],
    disagreements: list[int],
    path: Path,
    settings: JobSettingsSnapshot | None,
    cfg: ParseRoutingConfig,
) -> list[L2Page]:
    del disagreements, path, settings, cfg
    return pages


def run_preflight(
    path: Path | str,
    settings: JobSettingsSnapshot | None,
    routing_cfg: ParseRoutingConfig,
    converter: RangeConverter,
    l3: L3Hook | None = None,
    *,
    file_sha: str | None = None,
) -> PreflightOutput:
    """Run L1, optional L2, optional L3 hook, tiers, ranges and classification."""
    target = Path(path)
    started = time.perf_counter()
    min_tier, max_tier = _default_bounds(settings)
    digest = file_sha or sha256_file(target)
    l3_fn = l3 or _noop_l3

    l1_started = time.perf_counter()
    l1 = l1_signals(target, routing_cfg)
    l1_ms = int((time.perf_counter() - l1_started) * 1000)

    l2_started = time.perf_counter()
    l2_pages, disagreements, reusable = l2_refine(l1.pages, target, digest, converter, routing_cfg)
    l2_ms = int((time.perf_counter() - l2_started) * 1000)

    l3_started = time.perf_counter()
    l2_pages = l3_fn(l2_pages, disagreements, target, settings, routing_cfg)
    l3_ms = int((time.perf_counter() - l3_started) * 1000)

    tiered = _to_tiered_pages(l2_pages, min_tier, max_tier)
    ranges = build_ranges(tiered, routing_cfg)
    page_rows = _finalize_page_signals(l2_pages, tiered, ranges)
    doc_class = classify(page_rows)
    l2_count = sum(1 for page in l2_pages if page.l2_inspected)
    total_ms = int((time.perf_counter() - started) * 1000)

    result = PreflightResult(
        probe_version=PROBE_VERSION,
        page_count=len(page_rows),
        encrypted=False,
        doc_class=doc_class,
        pages=page_rows,
        ranges=ranges,
        tier_page_counts=_tier_page_counts(page_rows),
        detect_counts=DetectCounts(
            L1=len(l1.pages),
            L2=l2_count,
            L3=0,
            gated_share=l1.gated_share,
        ),
        timings_ms={
            "preflight": total_ms,
            "l1": l1_ms,
            "l2": l2_ms,
            "l3": l3_ms,
        },
    )
    return PreflightOutput(result=result, reusable_fast=reusable)