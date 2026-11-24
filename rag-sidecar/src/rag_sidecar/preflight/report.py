"""Routing report per detection-layer combination (D-39). Stub for the RED step."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.queue import DetectVlmResponse
from rag_sidecar.contracts.routing import DocClass, Layer, PageSignal, ParseTier, Preset

LayerCombo = Literal["L1", "L1+L2", "L1+L2+L3"]
COMBO_L1: LayerCombo = "L1"
COMBO_L1_L2: LayerCombo = "L1+L2"
COMBO_L1_L2_L3: LayerCombo = "L1+L2+L3"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RoutedPage(_Model):
    page: int = Field(ge=1)
    tier: ParseTier
    preset: Preset
    layer: Layer
    signals: list[PageSignal]


class ComboRouting(_Model):
    combo: LayerCombo
    doc_class: DocClass
    l2_pages: int = Field(ge=0)
    l3_pages: int = Field(ge=0)
    pages: list[RoutedPage]


class FixtureRouting(_Model):
    fixture_id: str
    sha256: str
    doc_type: str
    min_tier: ParseTier
    max_tier: ParseTier
    combos: list[ComboRouting]


class RoutingReport(_Model):
    probe_version: str
    routing_config_version: str
    fixtures: list[FixtureRouting]


class RecordedVlmApp:
    def __init__(self, recorded_root: Path, sha256: str) -> None:
        self.calls: list[list[int]] = []

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse:
        return DetectVlmResponse(worker_id="recorded-l3", pages=[])


def build_routing_report(fixtures_dir: Path, *, fixture_ids: Sequence[str] | None = None) -> RoutingReport:
    return RoutingReport(probe_version="", routing_config_version="", fixtures=[])


def main(argv: list[str] | None = None) -> int:
    return 1
