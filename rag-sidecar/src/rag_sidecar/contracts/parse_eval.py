from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, field_validator, model_validator

from rag_sidecar.contracts.ingest import DocType
from rag_sidecar.contracts.routing import PageSignal, ParseTier, Preset
from rag_sidecar.contracts.sidecar import _Contract


class BackfillManifestEntry(_Contract):
    source_key: str = Field(min_length=1)
    path: str | None = None
    url: str | None = None
    doc_type: DocType | None = None

    @model_validator(mode="after")
    def _exactly_one_location(self) -> BackfillManifestEntry:
        has_path = self.path is not None
        has_url = self.url is not None
        if has_path == has_url:
            raise ValueError("exactly one of path or url is required")
        if self.url is not None:
            parsed = urlparse(self.url)
            if parsed.scheme != "https":
                raise ValueError("url must use https")
        return self


class DuplicateCounts(_Contract):
    in_inventory: int = Field(ge=0)
    already_existing: int = Field(ge=0)


class InventoryTotals(_Contract):
    files: int = Field(ge=0)
    bytes: int = Field(ge=0)
    pages_estimated: int = Field(ge=0)


class ProjectedCostSplit(_Contract):
    premium_parse_usd: float = Field(ge=0)
    vlm_usd: float = Field(ge=0)
    embeddings_usd: float = Field(ge=0)
    total_usd: float = Field(ge=0)


class BackfillDryRunReport(_Contract):
    inventory: InventoryTotals
    duplicates: DuplicateCounts
    sample_size_by_class: dict[str, int]
    class_shares: dict[str, float]
    projected_pages_by_tier: dict[str, int]
    projected_l2_pages: int = Field(ge=0)
    projected_l3_pages: int = Field(ge=0)
    projected_cost: ProjectedCostSplit
    projected_wall_time_s: float = Field(ge=0)
    embedding_cost_by_profile_usd: dict[str, float]
    budget_usd: float | None = Field(default=None, ge=0)
    fits_budget: bool


class TableCell(_Contract):
    row: int = Field(ge=0)
    col: int = Field(ge=0)
    text: str


class ReadingOrderAnchor(_Contract):
    text: str
    page: int = Field(ge=1)
    order: int = Field(ge=0)


class ExpectedHeading(_Contract):
    text: str
    level: int = Field(ge=1, le=6)
    page: int = Field(ge=1)


class ExpectedPage(_Contract):
    page: int = Field(ge=1)
    signals: list[PageSignal]
    tier: ParseTier
    preset: Preset


class ParserExpected(_Contract):
    fixture_id: str
    language: str
    pages: list[ExpectedPage]
    table_cells: list[TableCell] = Field(default_factory=list)
    reading_order: list[ReadingOrderAnchor] = Field(default_factory=list)
    headings: list[ExpectedHeading] = Field(default_factory=list)

    @field_validator("pages")
    @classmethod
    def _page_numbers_unique(cls, value: list[ExpectedPage]) -> list[ExpectedPage]:
        pages = [item.page for item in value]
        if len(set(pages)) != len(pages):
            raise ValueError("pages must not repeat a page number")
        return value


class TierParseMetrics(_Contract):
    text_similarity: float = Field(ge=0, le=1)
    table_cell_f1: float = Field(ge=0, le=1)
    reading_order: float = Field(ge=0, le=1)
    headings_f1: float = Field(ge=0, le=1)
    s_per_page: float = Field(ge=0)
    cost_per_page: float = Field(ge=0)
    recall_at_k: float = Field(ge=0, le=1)


class PageTierAccuracy(_Contract):
    layer_combo: Literal["L1", "L1+L2", "L1+L2+L3"]
    pages_below_expected_tier: int = Field(ge=0)


class ParserEvalReport(_Contract):
    fixture_id: str
    by_tier: dict[str, TierParseMetrics]
    page_tier_accuracy: list[PageTierAccuracy]


class ModeProjection(_Contract):
    premium_page_share: float = Field(ge=0, le=1)
    projected_cost_per_1000_pages_usd: float = Field(ge=0)


class PairedMetricDelta(_Contract):
    metric: str
    delta: float
    within_noise_band: bool


class ParseGateReport(_Contract):
    recall_at_k: list[PairedMetricDelta]
    correct_refusal: list[PairedMetricDelta]
    noise_band_k: float = Field(ge=0)
    noise_band_floor: float = Field(ge=0)
    fixed: ModeProjection
    tiered: ModeProjection
    passed: bool