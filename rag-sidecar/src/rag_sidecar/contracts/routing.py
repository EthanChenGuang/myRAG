from __future__ import annotations

from typing import Annotated, Literal, get_args

from pydantic import Field, field_validator, model_validator

from rag_sidecar.contracts.sidecar import _Contract

ParseTier = Literal["native", "fast", "structured", "premium"]
Preset = Literal["native", "fast", "structured_layout", "structured_full", "structured_ocr", "premium"]
Layer = Literal["L1", "L2", "L3"]
RefusalReason = Literal[
    "cloud_not_allowed",
    "budget_exhausted",
    "over_page_cap",
    "batch_budget_exhausted",
]
PageSignal = Literal[
    "tables",
    "multi_col",
    "has_figure",
    "scanned",
    "garbled",
    "uncertain",
    "table_continues",
]
DocClass = Literal["text_pdf", "tables", "layout", "scanned", "mixed", "image", "native"]
RangeStatus = Literal["pending", "ok", "escalated", "needs_review"]
AttemptReason = Literal[
    "initial",
    "escalation",
    "table_boundary",
    "progressive_fast",
    "fixed_chain",
    "native",
]
QualityFailure = Literal[
    "empty_text",
    "low_chars",
    "garbled",
    "language_mismatch",
    "missing_table",
    "partial_conversion",
    "table_boundary",
]
Complexity = Literal["simple", "complex"]

_TIER_ORDER = {tier: index for index, tier in enumerate(get_args(ParseTier))}


class PageSignals(_Contract):
    page: int = Field(ge=1)
    chars: int = Field(ge=0)
    text_layer: bool
    image_area_ratio: float = Field(ge=0, le=1)
    ruled_tables: int = Field(ge=0)
    aligned_number_rows: int = Field(ge=0)
    multi_column: bool
    has_figure: bool
    scanned: bool
    garbled_ratio: float = Field(ge=0, le=1)
    signals: list[PageSignal]
    layer: Layer
    tier: ParseTier
    preset: Preset
    continues_to_next: bool

    @field_validator("signals")
    @classmethod
    def _signals_unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("signals must not repeat a value")
        return value


class PageRange(_Contract):
    start: int = Field(ge=1)
    end: int = Field(ge=1)
    tier: ParseTier
    preset: Preset
    parser: str
    layer: Layer
    signals: list[PageSignal]
    status: RangeStatus
    cache_id: str | None = None

    @model_validator(mode="after")
    def _start_le_end(self) -> PageRange:
        if self.start > self.end:
            raise ValueError("start must not exceed end")
        return self


class DetectCounts(_Contract):
    L1: int = Field(ge=0)
    L2: int = Field(ge=0)
    L3: int = Field(ge=0)
    gated_share: float = Field(ge=0, le=1)


class PreflightResult(_Contract):
    probe_version: str
    page_count: int = Field(ge=1)
    encrypted: bool
    doc_class: DocClass
    pages: list[PageSignals]
    ranges: list[PageRange]
    tier_page_counts: dict[ParseTier, int]
    detect_counts: DetectCounts
    timings_ms: dict[str, int]

    @field_validator("pages")
    @classmethod
    def _pages_are_numbered(cls, value: list[PageSignals]) -> list[PageSignals]:
        pages = [item.page for item in value]
        if len(set(pages)) != len(pages):
            raise ValueError("pages must not repeat a page number")
        return value

    @model_validator(mode="after")
    def _ranges_tile_and_counts_match(self) -> PreflightResult:
        if len(self.pages) != self.page_count:
            raise ValueError("pages length must equal page_count")
        expected_pages = set(range(1, self.page_count + 1))
        if {page.page for page in self.pages} != expected_pages:
            raise ValueError("pages must be numbered 1..page_count exactly once")
        covered: set[int] = set()
        for page_range in self.ranges:
            for page in range(page_range.start, page_range.end + 1):
                if page in covered:
                    raise ValueError("ranges must not overlap")
                covered.add(page)
        if covered != expected_pages:
            raise ValueError("ranges must tile 1..page_count exactly once")
        if sum(self.tier_page_counts.values()) != self.page_count:
            raise ValueError("tier_page_counts must sum to page_count")
        return self


class PageStructureVerdict(_Contract):
    has_table: bool
    has_multi_column: bool
    is_scanned: bool
    has_formula: bool
    has_chart: bool
    complexity: Complexity
    confidence: float = Field(ge=0, le=1)


class PresetOptions(_Contract):
    pdf_backend: str | None = None
    ocr: bool | None = None
    force_full_page_ocr: bool | None = None
    table_mode: Literal["off", "fast", "accurate"] | None = None
    heading_hierarchy: bool | None = None


class CostEntry(_Contract):
    usd_per_page: float = Field(ge=0)
    s_per_page: float = Field(ge=0)
    source: str = Field(min_length=1)
    as_of: str = Field(min_length=1)


class L1Config(_Contract):
    garbled_ratio: float = Field(ge=0, le=1)
    min_ruling_paths: int = Field(ge=0)
    thin_path_pt: float = Field(gt=0)
    scanned_max_chars: int = Field(default=30, ge=0)


class L2Config(_Contract):
    uncertain_batch_pages: int = Field(ge=1, le=64)


class L3Config(_Contract):
    max_pages_per_doc: int = Field(ge=0)


class RangeRules(_Contract):
    lift_min_run: int = Field(ge=1)
    max_ranges: int = Field(ge=1)
    higher_preset_share: float = Field(ge=0, le=1)
    max_pages_per_conversion: int = Field(ge=1)


class QualityThresholds(_Contract):
    low_char_ratio: float = Field(ge=0, le=1)
    scanned_min_chars: int = Field(ge=0)
    language_min_chars: int = Field(ge=0)


class QualityScoreWeights(_Contract):
    garbled: float = Field(ge=0, le=1)
    low_chars: float = Field(ge=0, le=1)
    missing_table: float = Field(ge=0, le=1)
    language: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _weights_sum_to_one(self) -> QualityScoreWeights:
        total = self.garbled + self.low_chars + self.missing_table + self.language
        if abs(total - 1.0) > 1e-6:
            raise ValueError("score weights must sum to 1")
        return self


class QualityConfig(_Contract):
    thresholds: QualityThresholds
    score_weights: QualityScoreWeights


class TierCostMap(_Contract):
    native: CostEntry
    fast: CostEntry
    structured: CostEntry
    premium: CostEntry


class LayerCostMap(_Contract):
    L1: CostEntry
    L2: CostEntry
    L3: CostEntry


class RoutingCosts(_Contract):
    tier: TierCostMap
    layer: LayerCostMap


class EscalationConfig(_Contract):
    max_per_page: int = Field(ge=0)


class RoutingPresets(_Contract):
    native: PresetOptions | None = None
    fast: PresetOptions
    structured_layout: PresetOptions
    structured_full: PresetOptions
    structured_ocr: PresetOptions
    premium: PresetOptions | None = None


class RoutingTimeouts(_Contract):
    preflight_ms: int = Field(ge=1)
    parse_slice_ms: int = Field(ge=1)
    advance_ms: int = Field(ge=1, le=40_000)


class ParseRoutingConfig(_Contract):
    version: str
    presets: RoutingPresets
    l1: L1Config
    l2: L2Config
    l3: L3Config
    ranges: RangeRules
    quality: QualityConfig
    ladder: dict[str, list[ParseTier]]
    costs: RoutingCosts
    escalation: EscalationConfig
    thresholds_ref: str | None = None
    timeouts: RoutingTimeouts
    office_formats: dict[str, str] = Field(default_factory=dict)


class ParseAttemptPages(_Contract):
    start: int = Field(ge=1)
    end: int = Field(ge=1)

    @model_validator(mode="after")
    def _start_le_end(self) -> ParseAttemptPages:
        if self.start > self.end:
            raise ValueError("start must not exceed end")
        return self


class PageCheck(_Contract):
    page: int = Field(ge=1)
    failed: list[QualityFailure]


class QualityCheckResult(_Contract):
    passed: bool
    pages: list[PageCheck]
    score: float = Field(ge=0, le=1)
    partial: bool


class ParseAttempt(_Contract):
    attempt_no: int = Field(ge=1)
    tier: ParseTier
    preset: Preset
    parser: str
    parser_version: str
    pages: ParseAttemptPages
    reason: AttemptReason
    ms: int = Field(ge=0)
    est_cost_usd: float = Field(ge=0)
    cache_hit: bool
    refused: bool
    check: QualityCheckResult | None = None


def default_parse_routing_config() -> ParseRoutingConfig:
    """Research starting values (D-11, plan 03.1-02)."""
    assumed = CostEntry(
        usd_per_page=0.001,
        s_per_page=0.8,
        source="assumed until measured",
        as_of="2026-01-01",
    )
    premium = CostEntry(
        usd_per_page=0.004,
        s_per_page=5.0,
        source="https://developers.llamaindex.ai",
        as_of="2026-01-01",
    )
    return ParseRoutingConfig(
        version="1",
        presets=RoutingPresets(
            native=PresetOptions(),
            fast=PresetOptions(pdf_backend="pypdfium2", ocr=False, table_mode="off"),
            structured_layout=PresetOptions(ocr=False, table_mode="off", heading_hierarchy=True),
            structured_full=PresetOptions(table_mode="accurate", heading_hierarchy=True),
            structured_ocr=PresetOptions(ocr=True, force_full_page_ocr=True, table_mode="accurate"),
            premium=None,
        ),
        l1=L1Config(garbled_ratio=0.05, min_ruling_paths=4, thin_path_pt=2.0),
        l2=L2Config(uncertain_batch_pages=8),
        l3=L3Config(max_pages_per_doc=20),
        ranges=RangeRules(
            lift_min_run=2,
            max_ranges=20,
            higher_preset_share=0.6,
            max_pages_per_conversion=24,
        ),
        quality=QualityConfig(
            thresholds=QualityThresholds(
                low_char_ratio=0.5,
                scanned_min_chars=30,
                language_min_chars=200,
            ),
            score_weights=QualityScoreWeights(
                garbled=0.3,
                low_chars=0.3,
                missing_table=0.2,
                language=0.2,
            ),
        ),
        ladder={"pdf": ["fast", "structured", "premium"]},
        costs=RoutingCosts(
            tier=TierCostMap(native=assumed, fast=assumed, structured=assumed, premium=premium),
            layer=LayerCostMap(L1=assumed, L2=assumed, L3=premium),
        ),
        escalation=EscalationConfig(max_per_page=2),
        timeouts=RoutingTimeouts(preflight_ms=30_000, parse_slice_ms=40_000, advance_ms=40_000),
    )