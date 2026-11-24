from __future__ import annotations

from dataclasses import dataclass

from rag_sidecar.contracts.routing import PageSignals, PageStructureVerdict, ParseTier, Preset

_TIER_RANK: dict[ParseTier, int] = {
    "native": 0,
    "fast": 1,
    "structured": 2,
    "premium": 3,
}

_PRESET_RANK: dict[Preset, int] = {
    "native": 0,
    "fast": 1,
    "structured_layout": 2,
    "structured_full": 3,
    "structured_ocr": 4,
    "premium": 5,
}


@dataclass(frozen=True)
class LayerResults:
    l1_has_table: bool
    l2_has_table: bool | None = None
    verdict: PageStructureVerdict | None = None


def _signal_set(signals: PageSignals) -> set[str]:
    return set(signals.signals)


def _has_tables(signals: PageSignals) -> bool:
    return "tables" in _signal_set(signals) or signals.ruled_tables > 0


def _from_verdict(verdict: PageStructureVerdict) -> tuple[ParseTier, Preset]:
    if verdict.complexity == "complex":
        return "premium", "premium"
    if verdict.has_table or verdict.has_chart or verdict.has_formula:
        return "structured", "structured_full"
    if verdict.is_scanned:
        return "structured", "structured_ocr"
    if verdict.has_multi_column:
        return "structured", "structured_layout"
    return "fast", "fast"


def _disagreement_tier(layer: LayerResults) -> tuple[ParseTier, Preset] | None:
    if layer.l2_has_table is None:
        return None
    if layer.l1_has_table == layer.l2_has_table:
        return None
    return "structured", "structured_full"


def _base_tier(signals: PageSignals, layer: LayerResults) -> tuple[ParseTier, Preset]:
    if layer.verdict is not None:
        return _from_verdict(layer.verdict)
    disagree = _disagreement_tier(layer)
    if disagree is not None:
        return disagree

    sigs = _signal_set(signals)
    if signals.scanned or "scanned" in sigs or signals.garbled_ratio > 0.05 or "garbled" in sigs:
        return "structured", "structured_ocr"
    if _has_tables(signals) or signals.has_figure or "has_figure" in sigs:
        return "structured", "structured_full"
    if signals.multi_column or "multi_col" in sigs:
        if sigs <= {"multi_col"}:
            return "structured", "structured_layout"
    return "fast", "fast"


def _strongest_structured_preset(signals: PageSignals) -> Preset:
    sigs = _signal_set(signals)
    if signals.scanned or "scanned" in sigs or signals.garbled_ratio > 0.05 or "garbled" in sigs:
        return "structured_ocr"
    if _has_tables(signals) or signals.has_figure or "has_figure" in sigs:
        return "structured_full"
    if signals.multi_column or "multi_col" in sigs:
        return "structured_layout"
    return "structured_layout"


def apply_bounds(
    tier: ParseTier,
    preset: Preset,
    signals: PageSignals,
    min_tier: ParseTier | None,
    max_tier: ParseTier | None,
) -> tuple[ParseTier, Preset]:
    out_tier, out_preset = tier, preset

    if min_tier is not None and _TIER_RANK[out_tier] < _TIER_RANK[min_tier]:
        out_tier = min_tier
        if min_tier == "fast":
            out_preset = "fast"
        elif min_tier == "structured":
            if _PRESET_RANK[out_preset] < _PRESET_RANK["structured_layout"]:
                out_preset = "structured_layout"
        elif min_tier == "premium":
            out_preset = "premium"

    if max_tier is not None and _TIER_RANK[out_tier] > _TIER_RANK[max_tier]:
        out_tier = max_tier
        if max_tier == "structured":
            out_preset = _strongest_structured_preset(signals)
        elif max_tier == "fast":
            out_preset = "fast"

    return out_tier, out_preset


def page_tier(
    signals: PageSignals,
    layer_results: LayerResults,
    min_tier: ParseTier | None,
    max_tier: ParseTier | None,
) -> tuple[ParseTier, Preset]:
    base_tier, base_preset = _base_tier(signals, layer_results)
    return apply_bounds(base_tier, base_preset, signals, min_tier, max_tier)