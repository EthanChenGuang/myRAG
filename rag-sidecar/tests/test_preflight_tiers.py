from __future__ import annotations

import pytest

from rag_sidecar.contracts.routing import PageSignals, PageStructureVerdict
from rag_sidecar.preflight.classify import classify
from rag_sidecar.preflight.tiers import LayerResults, apply_bounds, page_tier


def _page(page: int, **changes) -> PageSignals:
    base = {
        "page": page,
        "chars": 120,
        "text_layer": True,
        "image_area_ratio": 0.0,
        "ruled_tables": 0,
        "aligned_number_rows": 0,
        "multi_column": False,
        "has_figure": False,
        "scanned": False,
        "garbled_ratio": 0.01,
        "signals": [],
        "layer": "L1",
        "tier": "fast",
        "preset": "fast",
        "continues_to_next": False,
    }
    base.update(changes)
    return PageSignals.model_validate(base)


def _layer(**changes) -> LayerResults:
    base = {"l1_has_table": False, "l2_has_table": None, "verdict": None}
    base.update(changes)
    return LayerResults(**base)


class TestPageTierMapping:
    def test_no_signals_fast(self):
        tier, preset = page_tier(_page(1), _layer(), None, None)
        assert (tier, preset) == ("fast", "fast")

    def test_multi_col_only_layout(self):
        tier, preset = page_tier(_page(1, signals=["multi_col"], multi_column=True), _layer(), None, None)
        assert (tier, preset) == ("structured", "structured_layout")

    def test_tables_full(self):
        tier, preset = page_tier(_page(1, signals=["tables"], ruled_tables=2), _layer(), None, None)
        assert (tier, preset) == ("structured", "structured_full")

    def test_figure_full(self):
        tier, preset = page_tier(_page(1, signals=["has_figure"], has_figure=True), _layer(), None, None)
        assert (tier, preset) == ("structured", "structured_full")

    def test_scanned_ocr(self):
        tier, preset = page_tier(_page(1, signals=["scanned"], scanned=True, text_layer=False), _layer(), None, None)
        assert (tier, preset) == ("structured", "structured_ocr")

    def test_garbled_ocr(self):
        tier, preset = page_tier(_page(1, signals=["garbled"], garbled_ratio=0.2), _layer(), None, None)
        assert (tier, preset) == ("structured", "structured_ocr")

    def test_tables_and_scanned_ocr(self):
        tier, preset = page_tier(
            _page(1, signals=["tables", "scanned"], scanned=True, ruled_tables=1),
            _layer(),
            None,
            None,
        )
        assert (tier, preset) == ("structured", "structured_ocr")

    def test_l3_complex_premium(self):
        verdict = PageStructureVerdict(
            has_table=False,
            has_multi_column=False,
            is_scanned=False,
            has_formula=False,
            has_chart=False,
            complexity="complex",
            confidence=0.9,
        )
        tier, preset = page_tier(_page(1), _layer(verdict=verdict), None, None)
        assert (tier, preset) == ("premium", "premium")


class TestDisagreement:
    def test_l1_table_l2_no_table_without_verdict(self):
        tier, preset = page_tier(
            _page(1, signals=[]),
            _layer(l1_has_table=True, l2_has_table=False),
            None,
            None,
        )
        assert (tier, preset) == ("structured", "structured_full")

    def test_l2_table_l1_no_table_without_verdict(self):
        tier, preset = page_tier(
            _page(1, signals=[]),
            _layer(l1_has_table=False, l2_has_table=True),
            None,
            None,
        )
        assert (tier, preset) == ("structured", "structured_full")

    def test_verdict_simple_no_table_fast(self):
        verdict = PageStructureVerdict(
            has_table=False,
            has_multi_column=False,
            is_scanned=False,
            has_formula=False,
            has_chart=False,
            complexity="simple",
            confidence=0.9,
        )
        tier, preset = page_tier(_page(1, signals=[]), _layer(l1_has_table=True, l2_has_table=False, verdict=verdict), None, None)
        assert (tier, preset) == ("fast", "fast")


class TestApplyBounds:
    def test_min_tier_structured_lifts_fast_to_layout(self):
        tier, preset = apply_bounds("fast", "fast", _page(1), "structured", None)
        assert (tier, preset) == ("structured", "structured_layout")

    def test_min_tier_premium_lifts_scanned(self):
        tier, preset = apply_bounds(
            "structured",
            "structured_ocr",
            _page(1, signals=["scanned"], scanned=True),
            "premium",
            None,
        )
        assert (tier, preset) == ("premium", "premium")

    def test_max_tier_structured_caps_complex_to_strongest_structured(self):
        tier, preset = page_tier(
            _page(1, signals=["tables"], ruled_tables=1),
            _layer(
                verdict=PageStructureVerdict(
                    has_table=True,
                    has_multi_column=False,
                    is_scanned=False,
                    has_formula=False,
                    has_chart=False,
                    complexity="complex",
                    confidence=0.9,
                )
            ),
            None,
            "structured",
        )
        assert (tier, preset) == ("structured", "structured_full")

    def test_min_tier_raises_layout_page(self):
        tier, preset = page_tier(
            _page(1, signals=["multi_col"], multi_column=True),
            _layer(),
            "structured",
            None,
        )
        assert (tier, preset) == ("structured", "structured_layout")


class TestClassify:
    def test_ninety_percent_scanned(self):
        pages = [_page(i, signals=["scanned"], scanned=True, text_layer=False) for i in range(1, 10)]
        pages.append(_page(10, signals=[]))
        assert classify(pages) == "scanned"

    def test_mixed_scanned_and_digital(self):
        pages = [
            _page(1, signals=["scanned"], scanned=True, text_layer=False),
            _page(2, signals=["scanned"], scanned=True, text_layer=False),
        ]
        pages.extend(_page(i) for i in range(3, 11))
        assert classify(pages) == "mixed"

    def test_tables_class(self):
        pages = [_page(i) for i in range(1, 10)]
        pages.append(_page(10, signals=["tables"], ruled_tables=1))
        assert classify(pages) == "tables"

    def test_layout_only_multi_col(self):
        pages = [_page(i, signals=["multi_col"], multi_column=True) for i in range(1, 6)]
        assert classify(pages) == "layout"

    def test_text_pdf_default(self):
        pages = [_page(i) for i in range(1, 6)]
        assert classify(pages) == "text_pdf"