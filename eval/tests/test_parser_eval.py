import json
import random
from pathlib import Path

import pytest
from rag_sidecar.contracts.parse_eval import ParserEvalReport, ParserExpected, TableCell
from rag_sidecar.preflight.config import load_routing_config
from rag_sidecar.preflight.report import FixtureRouting, RoutingReport

from rag_eval.parser_eval import (
    COMBO_ORDER,
    ParserEvalDetails,
    build_parser_eval,
    cell_counts,
    headings_f1,
    levenshtein,
    load_fixture_outputs,
    main,
    page_tier_accuracy,
    read_docling_page,
    read_premium_markdown,
    reading_order_score,
    score_fixture,
    table_cell_f1,
    text_similarity,
)

EVAL_ROOT = Path(__file__).resolve().parents[1]
PARSE_ROOT = EVAL_ROOT / "fixtures" / "parse"
MANIFEST = json.loads((PARSE_ROOT / "manifest.json").read_text(encoding="utf-8"))
BY_ID = {row["id"]: row for row in MANIFEST["fixtures"]}
SCANNED = ("scan-en", "scan-it", "scan-zh")


def expected(fixture: str) -> ParserExpected:
    return ParserExpected.model_validate_json((PARSE_ROOT / "expected" / f"{fixture}.json").read_text(encoding="utf-8"))


def fixture_report(fixture: str) -> ParserEvalReport:
    outputs = load_fixture_outputs(PARSE_ROOT, BY_ID[fixture]["sha256"], BY_ID[fixture]["page_count"])
    return score_fixture(expected(fixture), outputs, load_routing_config())


def routing_from_expected(below: dict[str, dict[str, set[int]]] | None = None) -> RoutingReport:
    """A routing report that routes every page as expected, except pages listed per combo, which are routed fast."""
    below = below or {}
    fixtures = []
    for fixture_id in sorted(BY_ID):
        exp = expected(fixture_id)
        combos = []
        for combo in COMBO_ORDER:
            demoted = below.get(combo, {}).get(fixture_id, set())
            pages = [
                {
                    "page": page.page,
                    "tier": "fast" if page.page in demoted else page.tier,
                    "preset": "fast" if page.page in demoted else page.preset,
                    "layer": "L1",
                    "signals": [],
                }
                for page in exp.pages
            ]
            combos.append({"combo": combo, "doc_class": "text_pdf", "l2_pages": 0, "l3_pages": 0, "pages": pages})
        fixtures.append(
            FixtureRouting.model_validate(
                {
                    "fixture_id": fixture_id,
                    "sha256": BY_ID[fixture_id]["sha256"],
                    "doc_type": "general",
                    "min_tier": "fast",
                    "max_tier": "premium",
                    "combos": combos,
                }
            )
        )
    return RoutingReport(probe_version="test", routing_config_version="1", fixtures=fixtures)


def _naive_levenshtein(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char_a != char_b)))
        previous = current
    return previous[-1]


# --- text similarity -------------------------------------------------------


def test_identical_text_scores_one():
    assert text_similarity("Quarterly parts list", "Quarterly parts list") == 1.0


def test_nfkc_equivalent_full_width_digits_score_one():
    assert text_similarity("Invoice 2025-03-15", "Invoice ２０２５－０３－１５") == 1.0


def test_whitespace_differences_are_normalised():
    assert text_similarity("a  b\n\tc", " a b c ") == 1.0


def test_one_substitution_in_one_hundred_characters():
    reference = "".join(chr(ord("a") + index % 26) for index in range(100))
    hypothesis = "X" + reference[1:]
    assert text_similarity(reference, hypothesis) == pytest.approx(0.99)


def test_text_similarity_is_clamped_and_handles_empty_text():
    assert text_similarity("", "") == 1.0
    assert text_similarity("", "extra") == 0.0
    assert text_similarity("abc", "") == 0.0
    assert text_similarity("ab", "a much longer hypothesis") == 0.0


def test_banded_levenshtein_matches_the_full_table():
    rng = random.Random(4403)
    for _ in range(300):
        a = "".join(rng.choice("abcd ") for _ in range(rng.randint(0, 40)))
        b = "".join(rng.choice("abcd ") for _ in range(rng.randint(0, 40)))
        assert levenshtein(a, b) == _naive_levenshtein(a, b)
    long_a = "x" * 500 + "y" * 500
    long_b = "y" * 500 + "x" * 500
    assert levenshtein(long_a, long_b) == _naive_levenshtein(long_a, long_b)


# --- table cells -----------------------------------------------------------


def _grid(rows: list[list[str]]) -> list[TableCell]:
    return [TableCell(row=r, col=c, text=text) for r, row in enumerate(rows) for c, text in enumerate(row)]


def test_exact_grid_scores_one():
    grid = _grid([["Item", "Qty"], ["Row-01", "1"], ["Row-02", "2"]])
    assert table_cell_f1(grid, grid) == 1.0


def test_missing_column_halves_recall():
    expected_grid = _grid([["Item", "Qty"], ["Row-01", "1"], ["Row-02", "2"]])
    predicted = [cell for cell in expected_grid if cell.col == 0]
    counts = cell_counts(expected_grid, predicted)
    assert counts.recall == 0.5
    assert counts.precision == 1.0
    assert table_cell_f1(expected_grid, predicted) == pytest.approx(2 / 3)


def test_cell_whitespace_and_case_are_normalised():
    expected_grid = _grid([["Unit Price", "EUR"]])
    predicted = _grid([["  unit   price ", "eur"]])
    assert table_cell_f1(expected_grid, predicted) == 1.0


def test_cells_match_on_row_and_column_too():
    expected_grid = _grid([["a", "b"]])
    shifted = [TableCell(row=1, col=0, text="a"), TableCell(row=1, col=1, text="b")]
    assert table_cell_f1(expected_grid, shifted) == 0.0


def test_no_expected_and_no_predicted_cells_is_vacuously_perfect():
    assert table_cell_f1([], []) == 1.0
    assert table_cell_f1([], _grid([["x"]])) == 0.0


# --- reading order and headings --------------------------------------------


def test_swapping_two_of_three_anchors_keeps_two_thirds_of_pairs():
    assert reading_order_score(["A", "B", "C"], ["B", "A", "C"]) == pytest.approx(2 / 3)
    assert reading_order_score(["A", "B", "C"], ["A", "B", "C"]) == 1.0


def test_missing_anchor_breaks_its_pairs():
    assert reading_order_score(["A", "B", "C"], ["A", "C"]) == pytest.approx(1 / 3)


def test_anchor_matches_a_block_prefix_after_normalisation():
    assert reading_order_score(["Intro", "Body text"], ["INTRO", "body   text that continues"]) == 1.0


def test_heading_with_wrong_level_is_a_miss():
    expected_headings = [(1, "Intro"), (2, "Scope")]
    assert headings_f1(expected_headings, [(1, "Intro"), (2, "scope")]) == 1.0
    assert headings_f1(expected_headings, [(1, "Intro"), (3, "Scope")]) == pytest.approx(0.5)
    assert headings_f1([], []) == 1.0


# --- readers ---------------------------------------------------------------


def test_docling_reader_takes_texts_headings_and_cells_in_body_order():
    payload = json.loads(
        (PARSE_ROOT / "recorded" / BY_ID["table-en"]["sha256"] / "structured_full" / "page-2.json").read_text(encoding="utf-8")
    )
    page = read_docling_page(payload)
    assert page.blocks == ["Inventory"]
    assert page.headings == [(2, "Inventory")]
    assert (0, 0, "Item") in page.cells
    assert len(page.cells) == 39


def test_premium_markdown_reader():
    page = read_premium_markdown("# Report\n\nFirst para\nwraps here.\n\n## Totals\n\n| Item | Qty |\n|---|---:|\n| A | 1 |\n")
    assert page.blocks == ["Report", "First para wraps here.", "Totals"]
    assert page.headings == [(1, "Report"), (2, "Totals")]
    assert page.cells == [(0, 0, "Item"), (0, 1, "Qty"), (1, 0, "A"), (1, 1, "1")]


# --- recorded fixtures -----------------------------------------------------


def test_structured_full_table_f1_beats_fast_on_the_table_fixture():
    report = fixture_report("table-en")
    assert report.by_tier["structured_full"].table_cell_f1 > report.by_tier["fast"].table_cell_f1
    assert report.by_tier["structured_full"].table_cell_f1 == 1.0


@pytest.mark.parametrize("fixture", SCANNED)
def test_structured_ocr_text_beats_fast_on_scanned_fixtures(fixture):
    report = fixture_report(fixture)
    assert report.by_tier["structured_ocr"].text_similarity > report.by_tier["fast"].text_similarity


def test_premium_is_scored_only_where_every_page_was_recorded():
    assert "premium" not in fixture_report("mixed-routing").by_tier
    assert "premium" in fixture_report("scan-en").by_tier
    assert "premium" not in fixture_report("table-en").by_tier


def test_seconds_and_cost_per_page_come_from_the_routing_cost_table():
    cfg = load_routing_config()
    report = fixture_report("scan-en")
    assert report.by_tier["premium"].cost_per_page == cfg.costs.tier.premium.usd_per_page
    assert report.by_tier["premium"].s_per_page == cfg.costs.tier.premium.s_per_page
    assert report.by_tier["structured_ocr"].cost_per_page == cfg.costs.tier.structured.usd_per_page
    assert report.by_tier["fast"].s_per_page == cfg.costs.tier.fast.s_per_page


# --- page-tier accuracy ----------------------------------------------------


def test_page_tier_accuracy_lists_pages_routed_below_their_tier():
    routing = routing_from_expected({"L1": {"mixed-routing": {9}, "table-en": {2}}})
    scored = [expected(fixture) for fixture in sorted(BY_ID) if fixture != "bench-100"]
    summary, details = page_tier_accuracy(scored, routing)
    assert [item.layer_combo for item in summary] == ["L1", "L1+L2", "L1+L2+L3"]
    assert [item.pages_below_expected_tier for item in summary] == [2, 0, 0]
    l1 = details[0]
    assert {(page.fixture_id, page.page) for page in l1.below_expected} == {("mixed-routing", 9), ("table-en", 2)}
    assert l1.pages == sum(len(item.pages) for item in scored)
    assert l1.tier_accuracy == pytest.approx((l1.pages - 2) / l1.pages)
    assert details[1].tier_accuracy == 1.0


def test_pages_above_their_tier_are_not_below():
    routing = routing_from_expected()
    data = routing.model_dump(mode="json")
    for combo in data["fixtures"][[f["fixture_id"] for f in data["fixtures"]].index("digital-text")]["combos"]:
        combo["pages"][0]["tier"] = "premium"
        combo["pages"][0]["preset"] = "premium"
    summary, details = page_tier_accuracy([expected("digital-text")], RoutingReport.model_validate(data))
    assert all(item.pages_below_expected_tier == 0 for item in summary)
    assert details[0].above_expected_tier == 1


def test_a_scored_fixture_missing_from_the_routing_report_is_an_error():
    data = routing_from_expected().model_dump(mode="json")
    data["fixtures"] = [item for item in data["fixtures"] if item["fixture_id"] != "table-en"]
    with pytest.raises(ValueError, match="table-en"):
        page_tier_accuracy([expected("table-en")], RoutingReport.model_validate(data))


# --- report and CLI --------------------------------------------------------


def test_build_parser_eval_aggregates_the_test_set():
    report, details = build_parser_eval(PARSE_ROOT, routing_from_expected(), load_routing_config())
    ParserEvalReport.model_validate(report.model_dump(mode="json"))
    assert report.fixture_id == "parse-test-set"
    assert set(report.by_tier) == {"fast", "structured_layout", "structured_full", "structured_ocr", "premium"}
    assert report.by_tier["structured_full"].table_cell_f1 > report.by_tier["fast"].table_cell_f1
    assert details.excluded_fixtures == ["bench-100"]
    assert sorted(item.fixture_id for item in details.fixtures) == sorted(f for f in BY_ID if f != "bench-100")
    assert details.recall_at_k_measured is False


def test_cli_writes_a_valid_report_and_details(tmp_path):
    routing_path = tmp_path / "routing.json"
    routing_path.write_text(json.dumps(routing_from_expected({"L1+L2": {"scan-zh": {1}}}).model_dump(mode="json")), encoding="utf-8")
    out = tmp_path / "phase-03.1" / "parser-eval.json"
    args = ["--fixtures", str(PARSE_ROOT), "--routing", str(routing_path), "--out", str(out)]
    assert main(args) == 0
    report = ParserEvalReport.model_validate_json(out.read_text(encoding="utf-8"))
    assert [item.layer_combo for item in report.page_tier_accuracy] == ["L1", "L1+L2", "L1+L2+L3"]
    assert [item.pages_below_expected_tier for item in report.page_tier_accuracy] == [0, 1, 0]
    details_path = out.with_name("parser-eval-details.json")
    details = ParserEvalDetails.model_validate_json(details_path.read_text(encoding="utf-8"))
    assert details.page_tier[1].below_expected[0].fixture_id == "scan-zh"
    first = out.read_bytes()
    assert main(args) == 0
    assert out.read_bytes() == first


def test_cli_rejects_an_invalid_routing_report(tmp_path):
    routing_path = tmp_path / "routing.json"
    routing_path.write_text('{"fixtures": []}', encoding="utf-8")
    with pytest.raises(SystemExit):
        main(["--fixtures", str(PARSE_ROOT), "--routing", str(routing_path), "--out", str(tmp_path / "out.json")])
