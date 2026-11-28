"""Routing the parse fixtures once per candidate set of L1 thresholds (plan 03.1-51, D-41)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rag_sidecar.preflight.report import COMBO_L1_L2, build_routing_report
from rag_sidecar.preflight.sweep import main, route_candidates

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSE_ROOT = REPO_ROOT / "eval" / "fixtures" / "parse"
CURRENT = {"garbled_ratio": 0.05, "min_ruling_paths": 4, "scanned_max_chars": 30}


def _tiers(routed: dict, fixture: str) -> dict[int, str]:
    return {row["page"]: row["tier"] for row in routed[fixture]}


def test_the_current_values_route_like_the_routing_report():
    [routed] = route_candidates(PARSE_ROOT, ["mixed-routing", "scan-en"], [CURRENT], COMBO_L1_L2)
    report = build_routing_report(PARSE_ROOT, fixture_ids=["mixed-routing", "scan-en"], combos=(COMBO_L1_L2,))
    for fixture in report.fixtures:
        assert _tiers(routed, fixture.fixture_id) == {page.page: page.tier for page in fixture.combos[0].pages}


def test_each_candidate_routes_with_its_own_thresholds_and_only_the_named_fixtures():
    loose = {**CURRENT, "scanned_max_chars": 0}
    current, no_scans = route_candidates(PARSE_ROOT, ["mixed-routing"], [CURRENT, loose], COMBO_L1_L2)
    assert set(current) == set(no_scans) == {"mixed-routing"}
    page9 = {row["page"]: row for row in current["mixed-routing"]}[9]
    assert "scanned" in page9["signals"]
    assert "scanned" not in {row["page"]: row for row in no_scans["mixed-routing"]}[9]["signals"]


def test_cli_writes_one_entry_per_candidate(tmp_path: Path):
    candidates = tmp_path / "candidates.json"
    candidates.write_text(json.dumps([CURRENT, {**CURRENT, "min_ruling_paths": 6}]), encoding="utf-8")
    out = tmp_path / "routed.json"
    assert main(["--fixtures", str(PARSE_ROOT), "--fixture", "table-en", "--candidates", str(candidates), "--out", str(out)]) == 0
    routed = json.loads(out.read_text(encoding="utf-8"))
    assert len(routed) == 2
    assert all(set(entry) == {"table-en"} for entry in routed)


def test_an_unknown_threshold_is_refused():
    with pytest.raises(ValueError):
        route_candidates(PARSE_ROOT, ["scan-en"], [{**CURRENT, "thin_path": 3}], COMBO_L1_L2)
