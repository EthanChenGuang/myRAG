from __future__ import annotations

import random
from typing import cast

import pytest

from rag_sidecar.contracts.routing import ParseRoutingConfig, Preset
from rag_sidecar.preflight.ranges import TieredPage, build_ranges, expand, preset_strength
from rag_sidecar.preflight.config import load_routing_config


def _tp(
    page: int,
    preset: Preset = "fast",
    *,
    tier: str | None = None,
    continues: bool = False,
) -> TieredPage:
    tier_map = {
        "fast": "fast",
        "structured_layout": "structured",
        "structured_full": "structured",
        "structured_ocr": "structured",
        "premium": "premium",
    }
    return TieredPage(
        page=page,
        tier=cast("ParseTier", tier or tier_map[preset]),
        preset=preset,
        continues_to_next=continues,
    )


ParseTier = __import__("rag_sidecar.contracts.routing", fromlist=["ParseTier"]).ParseTier


@pytest.fixture
def cfg() -> ParseRoutingConfig:
    return load_routing_config()


class TestSpecExamples:
  def test_100_pages_three_table_pages(self, cfg: ParseRoutingConfig):
      pages = [_tp(i) for i in range(1, 101)]
      pages[9] = _tp(10, "structured_full")   # page 10
      pages[49] = _tp(50, "structured_full")
      pages[89] = _tp(90, "structured_full")
      ranges = build_ranges(pages, cfg)
      structured_pages = sum(r.end - r.start + 1 for r in ranges if r.preset != "fast")
      fast_pages = sum(r.end - r.start + 1 for r in ranges if r.preset == "fast")
      assert structured_pages == 3
      assert fast_pages == 97
      assert len(ranges) == 7

  def test_100_pages_tables_at_10_50_90_seven_ranges(self, cfg: ParseRoutingConfig):
      pages = [_tp(i) for i in range(1, 101)]
      for idx in (9, 49, 89):
          pages[idx] = _tp(idx + 1, "structured_full")
      ranges = build_ranges(pages, cfg)
      assert [(r.start, r.end, r.preset) for r in ranges] == [
          (1, 9, "fast"),
          (10, 10, "structured_full"),
          (11, 49, "fast"),
          (50, 50, "structured_full"),
          (51, 89, "fast"),
          (90, 90, "structured_full"),
          (91, 100, "fast"),
      ]


class TestLiftBetweenRuns:
    def test_single_fast_sandwich_lifted(self, cfg: ParseRoutingConfig):
        pages = [
            _tp(1, "structured_full"),
            _tp(2, "fast"),
            _tp(3, "structured_full"),
        ]
        ranges = build_ranges(pages, cfg)
        assert len(ranges) == 1
        assert ranges[0].preset == "structured_full"
        assert ranges[0].start == 1 and ranges[0].end == 3

    def test_two_fast_pages_not_lifted(self, cfg: ParseRoutingConfig):
        pages = [
            _tp(1, "structured_full"),
            _tp(2, "fast"),
            _tp(3, "fast"),
            _tp(4, "structured_full"),
        ]
        ranges = build_ranges(pages, cfg)
        assert len(ranges) == 3


class TestTableContinuation:
    def test_pull_neighbor(self, cfg: ParseRoutingConfig):
        pages = [
            _tp(1, "fast"),
            _tp(2, "fast"),
            _tp(3, "fast"),
            _tp(4, "structured_full", continues=True),
            _tp(5, "fast"),
        ]
        ranges = build_ranges(pages, cfg)
        full = [r for r in ranges if r.preset == "structured_full"]
        assert any(r.start <= 4 <= r.end and r.end >= 5 for r in full)

    def test_pull_chain(self, cfg: ParseRoutingConfig):
        pages = [
            _tp(1, "fast"),
            _tp(2, "fast"),
            _tp(3, "fast"),
            _tp(4, "structured_full", continues=True),
            _tp(5, "fast", continues=True),
            _tp(6, "fast"),
        ]
        ranges = build_ranges(pages, cfg)
        full = [r for r in ranges if r.preset == "structured_full"]
        assert any(r.start <= 4 <= r.end and 6 <= r.end for r in full)


class TestCollapse:
    def test_twenty_five_alternating_runs(self, cfg: ParseRoutingConfig):
        presets: list[Preset] = []
        for i in range(50):
            presets.append("structured_full" if i % 2 == 0 else "fast")
        pages = [_tp(i + 1, presets[i]) for i in range(50)]
        ranges = build_ranges(pages, cfg)
        non_premium = [r for r in ranges if r.preset != "premium"]
        assert len(non_premium) == 1
        assert non_premium[0].preset == "structured_full"

    def test_six_of_ten_above_fast_collapses(self, cfg: ParseRoutingConfig):
        pages = [_tp(i, "structured_layout") for i in range(1, 7)] + [
            _tp(i, "fast") for i in range(7, 11)
        ]
        ranges = build_ranges(pages, cfg)
        non_premium = [r for r in ranges if r.preset != "premium"]
        assert len(non_premium) == 1
        assert non_premium[0].preset == "structured_layout"

    def test_premium_stays_alone(self, cfg: ParseRoutingConfig):
        pages = [_tp(i, "fast") for i in range(1, 10)] + [_tp(10, "premium")]
        ranges = build_ranges(pages, cfg)
        premium = [r for r in ranges if r.preset == "premium"]
        assert len(premium) == 1
        assert premium[0].start == premium[0].end == 10


class TestProperty:
    PRESETS = ("fast", "structured_layout", "structured_full", "structured_ocr", "premium")

    @staticmethod
    def _random_pages(rng: random.Random, n: int) -> list[TieredPage]:
        pages: list[TieredPage] = []
        for i in range(1, n + 1):
            preset = cast(Preset, rng.choice(TestProperty.PRESETS))
            cont = rng.random() < 0.1 and preset == "structured_full"
            pages.append(_tp(i, preset, continues=cont))
        return pages

    def test_property_lift_only_tiling_idempotent(self, cfg: ParseRoutingConfig):
        rng = random.Random(42)
        for n in (1, 5, 17, 50, 300):
            original = self._random_pages(rng, n)
            baseline = {p.page: preset_strength(p.preset) for p in original}
            ranges = build_ranges(original, cfg)
            expanded = expand(ranges)
            assert len(expanded) == n
            assert [p.page for p in expanded] == list(range(1, n + 1))
            for p in expanded:
                assert preset_strength(p.preset) >= baseline[p.page]
            again = build_ranges(expanded, cfg)
            assert [(r.start, r.end, r.preset) for r in ranges] == [
                (r.start, r.end, r.preset) for r in again
            ]

    def test_premium_never_added(self, cfg: ParseRoutingConfig):
        rng = random.Random(7)
        original = [_tp(i, "fast") for i in range(1, 21)]
        ranges = build_ranges(original, cfg)
        assert all(r.preset != "premium" for r in ranges)
        expanded = expand(ranges)
        assert all(p.preset != "premium" for p in expanded)