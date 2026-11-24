from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Sequence

from rag_sidecar.contracts.routing import Layer, PageRange, ParseRoutingConfig, ParseTier, PageSignal, Preset

_PRESET_RANK: dict[Preset, int] = {
    "native": 0,
    "fast": 1,
    "structured_layout": 2,
    "structured_full": 3,
    "structured_ocr": 4,
    "premium": 5,
}


def preset_strength(preset: Preset) -> int:
    return _PRESET_RANK[preset]


@dataclass
class TieredPage:
    page: int
    tier: ParseTier
    preset: Preset
    continues_to_next: bool = False
    signals: list[PageSignal] | None = None
    layer: Layer = "L1"


def _stronger(a: Preset, b: Preset) -> Preset:
    return a if _PRESET_RANK[a] >= _PRESET_RANK[b] else b


def _lift_preset(pages: list[TieredPage], index: int, target: Preset) -> None:
    if pages[index].preset == "premium":
        return
    if _PRESET_RANK[target] > _PRESET_RANK[pages[index].preset]:
        pages[index].preset = target
        if target == "premium":
            pages[index].tier = "premium"
        elif target != "fast":
            pages[index].tier = "structured"
        else:
            pages[index].tier = "fast"


def _run_length_encode(pages: list[TieredPage]) -> list[tuple[int, int, Preset]]:
    if not pages:
        return []
    runs: list[tuple[int, int, Preset]] = []
    start = pages[0].page
    current = pages[0].preset
    for idx in range(1, len(pages)):
        if pages[idx].preset != current:
            runs.append((start, pages[idx - 1].page, current))
            start = pages[idx].page
            current = pages[idx].preset
    runs.append((start, pages[-1].page, current))
    return runs


def _lift_short_runs(pages: list[TieredPage], min_run: int) -> None:
    if len(pages) < 3:
        return
    runs = _run_length_encode(pages)
    for i, (s, e, preset) in enumerate(runs):
        length = e - s + 1
        if length >= min_run:
            continue
        higher: Preset | None = None
        if i > 0:
            higher = _stronger(higher or runs[i - 1][2], runs[i - 1][2])
        if i + 1 < len(runs):
            higher = _stronger(higher or runs[i + 1][2], runs[i + 1][2])
        if higher is None or _PRESET_RANK[preset] >= _PRESET_RANK[higher]:
            continue
        if preset == "premium":
            continue
        for page_num in range(s, e + 1):
            idx = page_num - pages[0].page
            _lift_preset(pages, idx, higher)
    # re-encode may need another pass if sandwiched — single pass per D-51 step 2
    # repeat once for nested sandwiches
    runs_after = _run_length_encode(pages)
    for i, (s, e, preset) in enumerate(runs_after):
        length = e - s + 1
        if length >= min_run or preset == "premium":
            continue
        higher = None
        if i > 0:
            higher = _stronger(higher or runs_after[i - 1][2], runs_after[i - 1][2])
        if i + 1 < len(runs_after):
            higher = _stronger(higher or runs_after[i + 1][2], runs_after[i + 1][2])
        if higher is None or _PRESET_RANK[preset] >= _PRESET_RANK[higher]:
            continue
        for page_num in range(s, e + 1):
            idx = page_num - pages[0].page
            _lift_preset(pages, idx, higher)


def _table_boundary_pull(pages: list[TieredPage]) -> None:
    changed = True
    while changed:
        changed = False
        for i in range(len(pages) - 1):
            if not pages[i].continues_to_next:
                continue
            if pages[i].preset == "premium":
                continue
            neighbor = pages[i + 1]
            if neighbor.preset == "premium":
                continue
            if _PRESET_RANK[neighbor.preset] < _PRESET_RANK[pages[i].preset]:
                _lift_preset(pages, i + 1, pages[i].preset)
                changed = True


def _collapse_document(pages: list[TieredPage], cfg: ParseRoutingConfig) -> None:
    rules = cfg.ranges
    runs = _run_length_encode(pages)
    if len(runs) <= rules.max_ranges:
        above_fast = sum(1 for p in pages if p.preset != "fast" and p.preset != "premium")
        if above_fast < rules.higher_preset_share * len(pages):
            return
    else:
        above_fast = sum(1 for p in pages if p.preset != "fast" and p.preset != "premium")
        if len(runs) <= rules.max_ranges and above_fast < rules.higher_preset_share * len(pages):
            return

    highest: Preset = "fast"
    for p in pages:
        if p.preset == "premium":
            continue
        if _PRESET_RANK[p.preset] > _PRESET_RANK[highest]:
            highest = p.preset
    if _PRESET_RANK[highest] <= _PRESET_RANK["fast"]:
        return
    for p in pages:
        if p.preset == "premium":
            continue
        _lift_preset(pages, p.page - pages[0].page, highest)


def _to_ranges(pages: list[TieredPage]) -> list[PageRange]:
    runs = _run_length_encode(pages)
    out: list[PageRange] = []
    page_by_num = {p.page: p for p in pages}
    for start, end, preset in runs:
        sample = page_by_num[start]
        tier = sample.tier
        if preset == "premium":
            tier = "premium"
        elif preset != "fast":
            tier = "structured"
        else:
            tier = "fast"
        out.append(
            PageRange(
                start=start,
                end=end,
                tier=tier,
                preset=preset,
                parser="docling" if preset != "premium" else "llamaparse",
                layer=sample.layer,
                signals=sample.signals or [],
                status="pending",
            )
        )
    return out


def expand(ranges: Sequence[PageRange]) -> list[TieredPage]:
    pages: list[TieredPage] = []
    for r in ranges:
        for page_num in range(r.start, r.end + 1):
            pages.append(
                TieredPage(
                    page=page_num,
                    tier=r.tier,
                    preset=r.preset,
                    continues_to_next=False,
                    signals=list(r.signals),
                    layer=r.layer,
                )
            )
    return pages


def build_ranges(pages: Sequence[TieredPage], cfg: ParseRoutingConfig) -> list[PageRange]:
    working = [replace(p) for p in pages]
    rules = cfg.ranges
    _lift_short_runs(working, rules.lift_min_run)
    _table_boundary_pull(working)
    _collapse_document(working, cfg)
    return _to_ranges(working)