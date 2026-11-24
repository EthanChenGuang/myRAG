"""Per-tier parser metrics and page-tier accuracy (D-39). Stub for the RED step."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict
from rag_sidecar.contracts.parse_eval import PageTierAccuracy, ParserEvalReport, ParserExpected, TableCell
from rag_sidecar.contracts.routing import ParseRoutingConfig
from rag_sidecar.preflight.report import RoutingReport

COMBO_ORDER = ("L1", "L1+L2", "L1+L2+L3")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BelowExpectedPage(_Model):
    fixture_id: str
    page: int


class ComboAccuracy(_Model):
    layer_combo: str
    pages: int
    tier_accuracy: float
    above_expected_tier: int
    below_expected: list[BelowExpectedPage]


class ParserEvalDetails(_Model):
    fixtures: list[ParserEvalReport]
    page_tier: list[ComboAccuracy]
    excluded_fixtures: list[str]
    recall_at_k_measured: bool


@dataclass(frozen=True)
class MatchCounts:
    tp: int
    fp: int
    fn: int

    @property
    def precision(self) -> float:
        return 0.0

    @property
    def recall(self) -> float:
        return 0.0


@dataclass
class PageOutput:
    blocks: list[str] = field(default_factory=list)
    headings: list[tuple[int, str]] = field(default_factory=list)
    cells: list[tuple[int, int, str]] = field(default_factory=list)


def levenshtein(a: str, b: str) -> int:
    return 0


def text_similarity(reference: str, hypothesis: str) -> float:
    return 0.0


def cell_counts(expected: Any, predicted: Any) -> MatchCounts:
    return MatchCounts(0, 0, 0)


def table_cell_f1(expected: Any, predicted: Any) -> float:
    return 0.0


def reading_order_score(anchors: list[str], blocks: list[str]) -> float:
    return 0.0


def headings_f1(expected: Any, predicted: Any) -> float:
    return 0.0


def read_docling_page(payload: dict[str, Any]) -> PageOutput:
    return PageOutput()


def read_premium_markdown(text: str) -> PageOutput:
    return PageOutput()


def load_fixture_outputs(fixtures_dir: Path, sha256: str, page_count: int) -> dict[str, list[PageOutput]]:
    return {}


def score_fixture(expected: ParserExpected, outputs: dict[str, list[PageOutput]], cfg: ParseRoutingConfig) -> ParserEvalReport:
    return ParserEvalReport(fixture_id=expected.fixture_id, by_tier={}, page_tier_accuracy=[])


def page_tier_accuracy(expected: list[ParserExpected], routing: RoutingReport) -> tuple[list[PageTierAccuracy], list[ComboAccuracy]]:
    return [], []


def build_parser_eval(fixtures_dir: Path, routing: RoutingReport, cfg: ParseRoutingConfig) -> tuple[ParserEvalReport, ParserEvalDetails]:
    report = ParserEvalReport(fixture_id="", by_tier={}, page_tier_accuracy=[])
    return report, ParserEvalDetails(fixtures=[], page_tier=[], excluded_fixtures=[], recall_at_k_measured=True)


def main(argv: list[str] | None = None) -> int:
    return 1


_ = TableCell
