"""L2 refinement and run_preflight fixture routing (plan 03.1-37)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import PreflightResult
from rag_sidecar.ingest import converters
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.l1 import EncryptedPdf, l1_signals
from rag_sidecar.preflight.l2 import l2_refine
from rag_sidecar.preflight.run import run_preflight

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSE_ROOT = REPO_ROOT / "eval" / "fixtures" / "parse"
MANIFEST = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))
FIXTURE_PDFS = {
    entry["id"]: REPO_ROOT / "eval" / entry["pdf_path"]
    for entry in MANIFEST["fixtures"]
    if entry["id"] != "bench-100"
}
EXPECTED = {
    entry["id"]: json.loads((REPO_ROOT / "eval" / entry["expected_path"]).read_text(encoding="utf-8"))
    for entry in MANIFEST["fixtures"]
    if entry["id"] != "bench-100"
}
SHA_BY_ID = {entry["id"]: entry["sha256"] for entry in MANIFEST["fixtures"]}
RECORDED = PARSE_ROOT / "recorded"
ENC = Path(__file__).parent / "fixtures" / "preflight"

MULTI_COL_SHA = SHA_BY_ID["multi-column-en"]


@pytest.fixture
def cfg():
    return load_routing_config()


@pytest.fixture
def recorded_converter():
    converters.reset_conversion_counter()
    yield converters.RecordedRangeConverter(RECORDED)
    converters.reset_conversion_counter()


def _settings(**overrides) -> JobSettingsSnapshot:
    base = {
        "routing": "tiered",
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 50,
        "premium_page_budget": 0,
        "vlm_detect": False,
        "profile_id": "general@1",
        "profile_version": 1,
        "doc_type": "general",
        "min_tier": "fast",
        "max_tier": "premium",
        "embed_mode": "sync",
        "ocr_languages": ["en"],
        "routing_config_version": "1",
    }
    base.update(overrides)
    return JobSettingsSnapshot.model_validate(base)


def test_uncertain_table_page_becomes_structured_full_layer_l2(recorded_converter, cfg):
    path = FIXTURE_PDFS["cross-boundary"]
    digest = SHA_BY_ID["cross-boundary"]
    l1 = l1_signals(path, cfg)
    pages, disagreements, reusable = l2_refine(l1.pages, path, digest, recorded_converter, cfg)
    page4 = next(item for item in pages if item.page == 4)
    assert page4.l2_inspected is True
    assert page4.layer == "L2"
    assert reusable
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    row = next(p for p in output.result.pages if p.page == 4)
    assert row.preset == "structured_full"
    assert disagreements


def test_uncertain_plain_page_clears_uncertain_and_reuses_fast(recorded_converter, cfg):
    path = FIXTURE_PDFS["multi-column-en"]
    digest = MULTI_COL_SHA
    l1 = l1_signals(path, cfg)
    pages, _disagreements, reusable = l2_refine(l1.pages, path, digest, recorded_converter, cfg)
    page2 = next(item for item in pages if item.page == 2)
    assert page2.l2_inspected is True
    assert page2.has_structure is False
    assert page2.uncertain is False
    assert reusable


def test_uncertain_pages_batched_as_ranges_3_4_and_9(recorded_converter, cfg):
    path = FIXTURE_PDFS["cross-boundary"]
    digest = SHA_BY_ID["cross-boundary"]
    uncertain = [p.page for p in l1_signals(path, cfg).pages if p.uncertain]
    assert set(uncertain) == {4, 5}
    converters.reset_conversion_counter()
    l2_refine(l1_signals(path, cfg).pages, path, digest, recorded_converter, cfg)
    assert converters.conversion_counter == 2


def test_uncertain_pages_three_four_nine_batch_to_two_ranges():
    from rag_sidecar.preflight.l2 import _group_uncertain_ranges

    assert _group_uncertain_ranges([3, 4, 9], 8) == [(3, 4), (9, 9)]


def test_scanned_uncertain_stays_structured_ocr(recorded_converter, cfg):
    path = FIXTURE_PDFS["mixed-routing"]
    digest = SHA_BY_ID["mixed-routing"]
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    row = next(p for p in output.result.pages if p.page == 9)
    assert row.preset == "structured_ocr"
    assert row.scanned is True


def test_l1_table_l2_table_false_reports_disagreement(recorded_converter, cfg):
    path = FIXTURE_PDFS["cross-boundary"]
    digest = SHA_BY_ID["cross-boundary"]
    l1 = l1_signals(path, cfg)
    _pages, disagreements, _reusable = l2_refine(l1.pages, path, digest, recorded_converter, cfg)
    assert disagreements


def test_mixed_fixture_default_bounds(recorded_converter, cfg):
    path = FIXTURE_PDFS["mixed-routing"]
    digest = SHA_BY_ID["mixed-routing"]
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    result = output.result
    by = {p.page: p for p in result.pages}
    assert by[7].preset == "structured_full"
    assert by[8].preset == "structured_full"
    assert by[9].preset == "structured_ocr"
    assert result.doc_class in {"mixed", "tables"}
    assert result.tier_page_counts["fast"] == 7
    assert result.tier_page_counts["structured"] == 3
    ranges = [(r.start, r.end, r.preset) for r in result.ranges]
    assert (1, 6, "fast") in ranges
    assert (7, 8, "structured_full") in ranges
    assert by[9].preset == "structured_ocr"
    assert by[10].preset == "fast"


def test_cross_boundary_ranges(recorded_converter, cfg):
    path = FIXTURE_PDFS["cross-boundary"]
    digest = SHA_BY_ID["cross-boundary"]
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    by = {p.page: p for p in output.result.pages}
    assert by[4].preset == "structured_full"
    assert by[5].preset == "structured_full"
    assert by[6].preset == "fast"


def test_invoice_min_tier_structured(recorded_converter, cfg):
    path = FIXTURE_PDFS["invoice-en"]
    digest = SHA_BY_ID["invoice-en"]
    output = run_preflight(path, _settings(min_tier="structured"), cfg, recorded_converter, file_sha=digest)
    assert all(p.preset != "fast" for p in output.result.pages)


def test_digital_text_one_fast_range_zero_l2(recorded_converter, cfg):
    path = FIXTURE_PDFS["digital-text"]
    digest = SHA_BY_ID["digital-text"]
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    assert output.result.detect_counts.L2 == 0
    assert len(output.result.ranges) == 1
    assert output.result.ranges[0].preset == "fast"


def test_encrypted_fixture_raises(recorded_converter, cfg):
    with pytest.raises(EncryptedPdf):
        run_preflight(ENC / "user-password.pdf", _settings(), cfg, recorded_converter)


def test_preflight_result_validates(recorded_converter, cfg):
    path = FIXTURE_PDFS["mixed-routing"]
    digest = SHA_BY_ID["mixed-routing"]
    output = run_preflight(path, _settings(), cfg, recorded_converter, file_sha=digest)
    PreflightResult.model_validate(output.result.model_dump(mode="json"))