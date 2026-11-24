from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from rag_sidecar.parse import probe
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.l1 import EncryptedPdf, l1_signals

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

SPEC_PATH = PARSE_ROOT / "parse_specs.py"
spec = pytest.importorskip("importlib").util.spec_from_file_location("parse_specs_test", SPEC_PATH)
assert spec is not None and spec.loader is not None
parse_specs = pytest.importorskip("importlib").util.module_from_spec(spec)
sys.modules[spec.name] = parse_specs
spec.loader.exec_module(parse_specs)

UNCERTAIN_PAGES: dict[str, set[int]] = {}
for item in parse_specs.all_specs():
    if not hasattr(item, "facts"):
        continue
    pages = item.facts.get("vlm_disagreement_pages") or []
    if pages:
        UNCERTAIN_PAGES[item.id] = set(pages)

ENC_FIXTURES = Path(__file__).parent / "fixtures" / "preflight"


@pytest.fixture
def cfg():
    return load_routing_config()


def _page_map(result) -> dict[int, object]:
    return {p.page: p for p in result.pages}


@pytest.mark.parametrize("fixture_id", sorted(FIXTURE_PDFS))
def test_l1_signals_match_parser_expected(fixture_id: str, cfg):
    path = FIXTURE_PDFS[fixture_id]
    result = l1_signals(path, cfg)
    by_page = _page_map(result)
    for expected in EXPECTED[fixture_id]["pages"]:
        page_no = expected["page"]
        actual = by_page[page_no]
        assert set(actual.signals) == set(expected["signals"]), (fixture_id, page_no, actual.signals)
        if page_no in UNCERTAIN_PAGES.get(fixture_id, set()) or "uncertain" in expected["signals"]:
            assert actual.uncertain is True


def test_mixed_fixture_table_and_scan_pages(cfg):
    path = FIXTURE_PDFS["mixed-routing"]
    by_page = _page_map(l1_signals(path, cfg))
    assert by_page[7].ruled_tables >= 1
    assert by_page[8].ruled_tables >= 1
    assert by_page[9].scanned is True
    for page in (1, 2, 3, 4, 5, 6, 10):
        assert "tables" not in by_page[page].signals
        assert by_page[page].scanned is False


def test_multi_column_fixture(cfg):
    by_page = _page_map(l1_signals(FIXTURE_PDFS["multi-column-en"], cfg))
    assert by_page[2].multi_column is True
    assert "multi_col" in by_page[2].signals


def test_cross_boundary_continuation(cfg):
    by_page = _page_map(l1_signals(FIXTURE_PDFS["cross-boundary"], cfg))
    assert by_page[4].continues_to_next is True
    assert "table_continues" in by_page[4].signals
    assert by_page[3].continues_to_next is False


def test_user_password_raises_encrypted_pdf(cfg):
    with pytest.raises(EncryptedPdf):
        l1_signals(ENC_FIXTURES / "user-password.pdf", cfg)


def test_owner_password_only_opens(cfg):
    result = l1_signals(ENC_FIXTURES / "owner-only.pdf", cfg)
    assert len(result.pages) == 2


def test_pdfplumber_not_opened_for_digital_text(cfg):
    opens = {"count": 0}
    import pdfplumber

    original = pdfplumber.open

    def spy(*args, **kwargs):
        opens["count"] += 1
        return original(*args, **kwargs)

    with patch.object(pdfplumber, "open", spy):
        l1_signals(FIXTURE_PDFS["digital-text"], cfg)
    assert opens["count"] == 0


def test_probe_text_layer_share_unchanged(cfg):
    path = FIXTURE_PDFS["digital-text"]
    assert probe.text_layer_page_share(path) == 1.0
    mixed = FIXTURE_PDFS["mixed-routing"]
    assert probe.text_layer_page_share(mixed) == 0.9