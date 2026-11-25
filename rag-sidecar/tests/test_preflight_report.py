"""Routing report per detection-layer combination (plan 03.1-44, D-39)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from rag_sidecar.contracts.routing import PageStructureVerdict
from rag_sidecar.preflight.report import (
    COMBO_L1,
    COMBO_L1_L2,
    COMBO_L1_L2_L3,
    RecordedVlmApp,
    RoutingReport,
    build_routing_report,
    main,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSE_ROOT = REPO_ROOT / "eval" / "fixtures" / "parse"
MANIFEST = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BY_ID = {entry["id"]: entry for entry in MANIFEST["fixtures"]}
SCORED = sorted(fixture for fixture in BY_ID if fixture != "bench-100")
ALL_COMBOS = [COMBO_L1, COMBO_L1_L2, COMBO_L1_L2_L3]


@pytest.fixture(scope="module")
def report() -> RoutingReport:
    return build_routing_report(PARSE_ROOT, fixture_ids=SCORED)


def combo_pages(report: RoutingReport, fixture: str, combo: str) -> dict:
    entry = next(item for item in report.fixtures if item.fixture_id == fixture)
    routed = next(item for item in entry.combos if item.combo == combo)
    return {page.page: page for page in routed.pages}


def expected_pages(fixture: str) -> dict:
    data = json.loads((PARSE_ROOT / "expected" / f"{fixture}.json").read_text(encoding="utf-8"))
    return {page["page"]: page for page in data["pages"]}


def test_every_fixture_page_has_tier_preset_and_layer_for_each_combination(report):
    assert [entry.fixture_id for entry in report.fixtures] == SCORED
    for entry in report.fixtures:
        assert [combo.combo for combo in entry.combos] == ALL_COMBOS
        for combo in entry.combos:
            assert [page.page for page in combo.pages] == list(range(1, BY_ID[entry.fixture_id]["page_count"] + 1))
            for page in combo.pages:
                assert page.tier in {"native", "fast", "structured", "premium"}
                assert page.layer in {"L1", "L2", "L3"}


def test_l1_alone_decides_every_page_with_layer_l1(report):
    for fixture in SCORED:
        for page in combo_pages(report, fixture, COMBO_L1).values():
            assert page.layer == "L1"


def test_l1_alone_routes_mixed_pages_seven_to_nine(report):
    pages = combo_pages(report, "mixed-routing", COMBO_L1)
    assert pages[7].preset == "structured_full"
    assert pages[8].preset == "structured_full"
    assert pages[9].preset == "structured_ocr"
    assert all(pages[number].tier == "structured" for number in (7, 8, 9))


def test_l2_layer_appears_only_with_l2_enabled(report):
    l2_layers = {page.layer for page in combo_pages(report, "cross-boundary", COMBO_L1_L2).values()}
    assert "L2" in l2_layers
    assert "L3" not in l2_layers


def test_recorded_verdict_is_applied_on_disagreement_pages_only_with_l3(report):
    with_l3 = combo_pages(report, "cross-boundary", COMBO_L1_L2_L3)
    without_l3 = combo_pages(report, "cross-boundary", COMBO_L1_L2)
    for number in (4, 5):
        assert with_l3[number].layer == "L3"
        assert without_l3[number].layer != "L3"
        assert with_l3[number].preset == expected_pages("cross-boundary")[number]["preset"]
    assert {number for number, page in with_l3.items() if page.layer == "L3"} == {4, 5}
    entry = next(item for item in report.fixtures if item.fixture_id == "cross-boundary")
    counts = {combo.combo: combo.l3_pages for combo in entry.combos}
    assert counts == {COMBO_L1: 0, COMBO_L1_L2: 0, COMBO_L1_L2_L3: 2}


def test_invoice_uses_its_profile_floor(report):
    entry = next(item for item in report.fixtures if item.fixture_id == "invoice-en")
    assert entry.doc_type == "invoice_receipt"
    assert entry.min_tier == "structured"
    for combo in ALL_COMBOS:
        assert all(page.tier != "fast" for page in combo_pages(report, "invoice-en", combo).values())


def test_report_is_deterministic(report):
    again = build_routing_report(PARSE_ROOT, fixture_ids=SCORED)
    assert again.model_dump(mode="json") == report.model_dump(mode="json")


def test_recorded_vlm_app_answers_recorded_pages_and_leaves_others_out():
    sha = BY_ID["cross-boundary"]["sha256"]
    app = RecordedVlmApp(PARSE_ROOT / "recorded", sha)
    response = app.detect([(4, b"png"), (5, b"png"), (6, b"png")])
    assert [item.page for item in response.pages] == [4, 5]
    recorded = PageStructureVerdict.model_validate_json(
        (PARSE_ROOT / "recorded" / sha / "vlm" / "page-4.json").read_text(encoding="utf-8")
    )
    assert response.pages[0].verdict == recorded
    assert app.calls == [[4, 5, 6]]


def test_cli_writes_identical_bytes_twice(tmp_path):
    first = tmp_path / "first.json"
    second = tmp_path / "second.json"
    args = ["--fixtures", str(PARSE_ROOT), "--fixture", "cross-boundary", "--fixture", "mixed-routing"]
    assert main([*args, "--out", str(first)]) == 0
    assert main([*args, "--out", str(second)]) == 0
    assert first.read_bytes() == second.read_bytes()
    loaded = RoutingReport.model_validate_json(first.read_text(encoding="utf-8"))
    assert [entry.fixture_id for entry in loaded.fixtures] == ["cross-boundary", "mixed-routing"]
    assert "timings" not in first.read_text(encoding="utf-8")


def test_cli_flags_disable_l2_or_l3(tmp_path):
    no_l3 = tmp_path / "no-l3.json"
    no_l2 = tmp_path / "no-l2.json"
    base = ["--fixtures", str(PARSE_ROOT), "--fixture", "cross-boundary"]
    assert main([*base, "--no-l3", "--out", str(no_l3)]) == 0
    assert main([*base, "--no-l2", "--out", str(no_l2)]) == 0
    combos_no_l3 = [combo.combo for combo in RoutingReport.model_validate_json(no_l3.read_text()).fixtures[0].combos]
    combos_no_l2 = [combo.combo for combo in RoutingReport.model_validate_json(no_l2.read_text()).fixtures[0].combos]
    assert combos_no_l3 == [COMBO_L1, COMBO_L1_L2]
    assert combos_no_l2 == [COMBO_L1]


def test_module_runs_as_a_script(tmp_path):
    out = tmp_path / "routing.json"
    completed = subprocess.run(
        [sys.executable, "-m", "rag_sidecar.preflight.report", "--fixtures", str(PARSE_ROOT), "--fixture", "digital-text", "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert RoutingReport.model_validate_json(out.read_text(encoding="utf-8")).fixtures[0].fixture_id == "digital-text"


def test_unknown_fixture_is_an_error(tmp_path):
    with pytest.raises(SystemExit):
        main(["--fixtures", str(PARSE_ROOT), "--fixture", "no-such-fixture", "--out", str(tmp_path / "x.json")])
