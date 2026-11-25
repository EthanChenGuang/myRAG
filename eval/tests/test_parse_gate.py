"""The paired tiered-versus-fixed parse gate (D-40, SC6) and the dev-split threshold sweep (D-41)."""

import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.parse_eval import ParseGateReport
from rag_sidecar.contracts.report import EvalReport, ItemResult
from rag_sidecar.preflight.config import load_routing_config

from rag_eval.parse_gate import (
    GateMismatch,
    IngestLedger,
    ModeRun,
    main,
    mode_projection,
    run_gate,
)

NOISE = NoiseConfig.model_validate_json((Path(__file__).resolve().parents[1] / "config" / "noise.json").read_text(encoding="utf-8"))
CFG = load_routing_config()
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")


def _item(item_id: str, *, hit: int = 1, spans: int = 1, answerable: bool = True, refused: bool = False, split: str = "dev", language: str = "en") -> ItemResult:
    return ItemResult(
        item_id=item_id,
        language=language,
        category="general",
        split=split,
        provenance="synthetic_fixture",
        answerable=answerable,
        refused=refused,
        span_count=spans if answerable else 0,
        spans_hit_at_5=hit if answerable else 0,
        spans_hit_at_10=hit if answerable else 0,
        first_hit_rank=(1 if hit else None) if answerable else None,
    )


def _slice(value: float = 0.5) -> dict:
    return {metric: {"value": value, "n": 1} for metric in METRICS}


def _report(items: list[ItemResult], *, corpus: str = "c", golden: str = "g", overall: float = 0.5) -> EvalReport:
    return EvalReport.model_validate(
        {
            "gate_population": "all",
            "run_id": "run-x",
            "tier": "smoke",
            "run_config_hash": "r" * 64,
            "corpus_sha256": corpus * 64,
            "golden_sha256": golden * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-embedder",
            "embedder_version": 1,
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            "overall": _slice(overall),
            "by_language": {"en": _slice(overall)},
            "by_category": {"general": _slice(overall)},
            "by_language_category": {},
            "by_split": {},
            "items": [item.model_dump() for item in items],
        }
    )


def _pdf(filename: str, pages: int, counts: dict[str, int] | None, *, fixed_tier: str = "structured") -> dict:
    attempts = [] if counts else [{"tier": fixed_tier, "reason": "fixed_chain", "pages": {"start": 1, "end": 1}}]
    return {
        "filename": filename,
        "mime_type": "application/pdf",
        "status": "ready",
        "doc_class": None,
        "tier": None,
        "pages": pages,
        "harness_page_count": pages,
        "tier_page_counts": counts or {},
        "page_ranges": [],
        "est_cost_usd": None,
        "attempts": attempts,
    }


def _text(filename: str) -> dict:
    return {
        "filename": filename,
        "mime_type": "text/markdown",
        "status": "ready",
        "doc_class": "native",
        "tier": "native",
        "pages": 1,
        "harness_page_count": None,
        "tier_page_counts": {"native": 1},
        "page_ranges": [],
        "est_cost_usd": None,
        "attempts": [],
    }


def _ledger(routing: str, jobs: list[dict]) -> IngestLedger:
    return IngestLedger.model_validate({"routing": routing, "force_tier": None, "jobs": jobs})


FIXED_LEDGER = _ledger("fixed", [_pdf("a.pdf", 6, None), _pdf("b.pdf", 4, None), _text("notes.md")])
TIERED_LEDGER = _ledger(
    "tiered",
    [_pdf("a.pdf", 6, {"fast": 4, "structured": 2, "premium": 0, "native": 0}), _pdf("b.pdf", 4, {"structured": 2, "premium": 2}), _text("notes.md")],
)


def _runs(items: list[ItemResult], routing: str, *, count: int = 3, overall: list[float] | None = None, corpus: str = "c") -> list[ModeRun]:
    ledger = FIXED_LEDGER if routing == "fixed" else TIERED_LEDGER
    values = overall or [0.5] * count
    return [ModeRun(report=_report(items, overall=values[index], corpus=corpus), ledger=ledger) for index in range(count)]


def _many(count: int, **overrides) -> list[ItemResult]:
    return [_item(f"en-{index:03d}", **overrides) for index in range(count)]


def _delta(report: ParseGateReport, metric: str) -> tuple[float, bool]:
    entry = next(item for item in [*report.recall_at_k, *report.correct_refusal] if item.metric == metric)
    return entry.delta, entry.within_noise_band


def test_equal_runs_pass_with_zero_deltas():
    items = _many(10) + [_item("na-1", answerable=False, refused=True)]
    report = run_gate(_runs(items, "fixed"), _runs(items, "tiered", corpus="t"), NOISE, CFG).report

    assert report.passed is True
    assert report.recall_at_k and report.correct_refusal
    assert all(entry.delta == 0 and entry.within_noise_band for entry in [*report.recall_at_k, *report.correct_refusal])
    assert {entry.metric for entry in report.recall_at_k} >= {"overall/recall_at_5", "overall/recall_at_10", "language:en/recall_at_5"}
    assert report.noise_band_k == NOISE.k and report.noise_band_floor == NOISE.floor


def test_tiered_recall_lower_beyond_the_band_fails_and_names_the_metric():
    fixed = _many(10)
    tiered = _many(9) + [_item("en-009", hit=0)]
    report = run_gate(_runs(fixed, "fixed"), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report

    assert report.passed is False
    delta, within = _delta(report, "overall/recall_at_5")
    assert delta == pytest.approx(-0.1)
    assert within is False


def test_tiered_recall_lower_within_the_band_passes():
    fixed = _many(60, spans=4, hit=4)
    tiered = _many(59, spans=4, hit=4) + [_item("en-059", spans=4, hit=3)]
    report = run_gate(_runs(fixed, "fixed"), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report

    delta, within = _delta(report, "overall/recall_at_5")
    assert delta == pytest.approx(-0.25 / 60)
    assert within is True
    assert report.passed is True


def test_tiered_higher_recall_never_fails():
    fixed = _many(9) + [_item("en-009", hit=0)]
    tiered = _many(10)
    report = run_gate(_runs(fixed, "fixed"), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report
    assert _delta(report, "overall/recall_at_5") == (pytest.approx(0.1), True)
    assert report.passed is True


def test_correct_refusal_is_compared_the_same_way():
    fixed = _many(5) + [_item(f"na-{index}", answerable=False, refused=True) for index in range(4)]
    tiered = _many(5) + [_item(f"na-{index}", answerable=False, refused=index != 0) for index in range(4)]
    report = run_gate(_runs(fixed, "fixed"), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report

    delta, within = _delta(report, "overall/correct_refusal_rate")
    assert delta == pytest.approx(-0.25)
    assert within is False
    assert report.passed is False


def test_only_the_gate_split_is_compared():
    fixed = _many(10) + [_item("test-1", split="test")]
    tiered = _many(10) + [_item("test-1", split="test", hit=0)]
    report = run_gate(_runs(fixed, "fixed"), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report
    assert report.passed is True
    assert _delta(report, "overall/recall_at_5") == (0, True)


def test_the_band_widens_with_the_fixed_run_spread():
    fixed = _many(10)
    tiered = _many(9) + [_item("en-009", hit=0)]
    report = run_gate(_runs(fixed, "fixed", overall=[0.5, 0.6, 0.7]), _runs(tiered, "tiered", corpus="t"), NOISE, CFG).report
    # stdev of 0.5, 0.6, 0.7 is 0.1, so the overall band is 3 * 0.1 = 0.3 and -0.1 is inside it.
    assert _delta(report, "overall/recall_at_5") == (pytest.approx(-0.1), True)


def test_projection_counts_pdf_pages_per_tier_with_the_cost_table():
    tier_cost = {tier: getattr(CFG.costs.tier, tier).usd_per_page for tier in ("fast", "structured", "premium")}

    fixed = mode_projection([FIXED_LEDGER], CFG)
    assert fixed.premium_page_share == 0
    assert fixed.projected_cost_per_1000_pages_usd == pytest.approx(1000 * tier_cost["structured"])

    tiered = mode_projection([TIERED_LEDGER, TIERED_LEDGER], CFG)
    assert tiered.premium_page_share == pytest.approx(2 / 10)
    expected = 1000 * (4 * tier_cost["fast"] + 4 * tier_cost["structured"] + 2 * tier_cost["premium"]) / 10
    assert tiered.projected_cost_per_1000_pages_usd == pytest.approx(expected)


def test_the_gate_report_carries_both_projections():
    items = _many(10)
    report = run_gate(_runs(items, "fixed"), _runs(items, "tiered", corpus="t"), NOISE, CFG).report
    assert report.fixed == mode_projection([FIXED_LEDGER], CFG)
    assert report.tiered == mode_projection([TIERED_LEDGER], CFG)


def test_runs_on_different_golden_files_are_refused():
    items = _many(10)
    fixed = _runs(items, "fixed")
    tiered = [ModeRun(report=_report(items, golden="h", corpus="t"), ledger=TIERED_LEDGER) for _ in range(3)]
    with pytest.raises(GateMismatch, match="golden_sha256"):
        run_gate(fixed, tiered, NOISE, CFG)


def test_a_run_of_the_wrong_routing_mode_is_refused():
    items = _many(10)
    swapped = [ModeRun(report=_report(items, corpus="t"), ledger=FIXED_LEDGER) for _ in range(3)]
    with pytest.raises(GateMismatch, match="routing"):
        run_gate(_runs(items, "fixed"), swapped, NOISE, CFG)


def _write_runs(root: Path, mode: str, items: list[ItemResult], count: int = 3) -> None:
    ledger = FIXED_LEDGER if mode == "fixed" else TIERED_LEDGER
    for index in range(1, count + 1):
        run_dir = root / f"{mode}-{index}"
        run_dir.mkdir(parents=True)
        (run_dir / "report.json").write_text(_report(items, corpus="c" if mode == "fixed" else "t").model_dump_json(), encoding="utf-8")
        (run_dir / "ingest-ledger.json").write_text(ledger.model_dump_json(), encoding="utf-8")


def _spec(tmp_path: Path, run_root: Path) -> Path:
    spec = json.loads((Path(__file__).resolve().parents[1] / "config" / "phase31-parse-gate.json").read_text(encoding="utf-8"))
    spec["run_root"] = str(run_root)
    path = tmp_path / "spec.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    return path


@pytest.mark.parametrize(("tiered_hit", "code", "passed"), [(1, 0, True), (0, 10, False)])
def test_cli_writes_a_valid_report_and_exits_non_zero_on_failure(tmp_path: Path, tiered_hit: int, code: int, passed: bool):
    runs = tmp_path / "runs"
    _write_runs(runs, "fixed", _many(10))
    _write_runs(runs, "tiered", _many(9) + [_item("en-009", hit=tiered_hit)])
    out = tmp_path / "out"

    assert main(["--spec", str(_spec(tmp_path, runs)), "--out", str(out), "--skip-runs"]) == code

    report = ParseGateReport.model_validate_json((out / "parse-gate.json").read_text(encoding="utf-8"))
    assert report.passed is passed


def test_cli_refuses_missing_runs(tmp_path: Path):
    runs = tmp_path / "runs"
    _write_runs(runs, "fixed", _many(10))
    assert main(["--spec", str(_spec(tmp_path, runs)), "--out", str(tmp_path / "out"), "--skip-runs"]) == 2
    assert not (tmp_path / "out" / "parse-gate.json").exists()


# -------------------------------------------------------------------------------------------------------------------------
# The dev-split threshold sweep (D-41)
# -------------------------------------------------------------------------------------------------------------------------

from rag_sidecar.contracts.routing import ParseRoutingConfig  # noqa: E402

from rag_eval.parse_gate import (  # noqa: E402
    SweepCandidate,
    SweepFixture,
    SweepGrid,
    SweepItem,
    SweepSpec,
    apply_thresholds,
    fixture_split,
    sweep,
)

CURRENT = SweepCandidate(garbled_ratio=0.05, min_ruling_paths=4, scanned_max_chars=30)
GRID = SweepGrid(garbled_ratio=[0.03, 0.05], min_ruling_paths=[2, 4], scanned_max_chars=[20, 30])
SPEC = SweepSpec(grid=GRID, report="eval/reports/phase-03.1/threshold-sweep.json")


def _fixture(fixture_id: str, split: str, tiers: list[str]) -> SweepFixture:
    return SweepFixture(fixture_id=fixture_id, split=split, expected_tiers={page: tier for page, tier in enumerate(tiers, start=1)})


# dev-table: page 2 holds a table; only min_ruling_paths 2 sees it. dev-scan: page 1 is a scan; only scanned_max_chars 30 sees it.
# test-doc: a test fixture whose only well-routed candidate is garbled 0.03, ruling 2, scanned 20 (the poisoned answer).
FIXTURES = [
    _fixture("dev-table", "dev", ["fast", "structured"]),
    _fixture("dev-scan", "dev", ["structured"]),
    _fixture("test-doc", "test", ["structured", "structured"]),
]


class FakeRouter:
    """Routes from the candidate's values alone and records every call."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[SweepCandidate], list[str]]] = []

    def __call__(self, candidates, fixture_ids):
        self.calls.append((list(candidates), list(fixture_ids)))
        out = []
        for candidate in candidates:
            routed: dict[str, dict[int, str]] = {}
            for fixture in fixture_ids:
                if fixture == "dev-table":
                    routed[fixture] = {1: "fast", 2: "structured" if candidate.min_ruling_paths <= 2 else "fast"}
                elif fixture == "dev-scan":
                    routed[fixture] = {1: "structured" if candidate.scanned_max_chars >= 30 else "fast"}
                else:
                    good = candidate == SweepCandidate(garbled_ratio=0.03, min_ruling_paths=2, scanned_max_chars=20)
                    routed[fixture] = {1: "structured" if good else "fast", 2: "structured" if good else "fast"}
            out.append(routed)
        return out


def _items(test_recall: float = 1.0) -> list[SweepItem]:
    full = {"fast": 0.0, "structured": 1.0, "premium": 1.0}
    return [
        SweepItem(item_id="dev-table-q", fixture_id="dev-table", split="dev", pages=[2], recall_by_tier=full, fixed_recall=1.0),
        SweepItem(item_id="dev-table-p1", fixture_id="dev-table", split="dev", pages=[1], recall_by_tier={"fast": 1.0, "structured": 1.0, "premium": 1.0}, fixed_recall=1.0),
        SweepItem(item_id="dev-scan-q", fixture_id="dev-scan", split="dev", pages=[1], recall_by_tier=full, fixed_recall=1.0),
        SweepItem(item_id="test-q", fixture_id="test-doc", split="test", pages=[], recall_by_tier={"fast": test_recall, "structured": 1.0, "premium": 1.0}, fixed_recall=1.0),
    ]


def _sweep(fixtures=FIXTURES, items=None, router=None):
    return sweep(SPEC, fixtures=fixtures, items=items or _items(), router=router or FakeRouter(), current=CURRENT, cfg=CFG, noise=NOISE)


def test_the_sweep_picks_the_best_dev_accuracy_among_candidates_that_keep_recall():
    report = _sweep()
    assert report.chosen == SweepCandidate(garbled_ratio=0.05, min_ruling_paths=2, scanned_max_chars=30)
    chosen = next(row for row in report.candidates if row.candidate == report.chosen)
    assert chosen.dev_tier_accuracy == 1.0 and chosen.within_band is True
    assert len(report.candidates) == 8


def test_a_candidate_that_loses_dev_recall_beyond_the_band_is_not_chosen():
    report = _sweep()
    lossy = next(row for row in report.candidates if row.candidate == SweepCandidate(garbled_ratio=0.05, min_ruling_paths=4, scanned_max_chars=20))
    assert lossy.within_band is False
    assert lossy.dev_projected_recall == pytest.approx(1 / 3)


def test_the_sweep_routes_only_dev_fixtures_until_the_choice_and_the_test_split_once():
    router = FakeRouter()
    report = _sweep(router=router)
    *selection, final = router.calls
    assert selection and all(set(ids) == {"dev-table", "dev-scan"} for _candidates, ids in selection)
    assert final == ([report.chosen], ["test-doc"])
    assert report.test_split.fixtures == ["test-doc"]
    assert report.test_split.items == 1


def test_a_poisoned_test_split_never_changes_the_choice():
    clean = _sweep()
    poisoned_fixtures = [*FIXTURES[:2], _fixture("test-doc", "test", ["fast", "fast"])]
    poisoned = _sweep(fixtures=poisoned_fixtures, items=_items(test_recall=0.0))
    assert poisoned.chosen == clean.chosen
    assert [row.model_dump() for row in poisoned.candidates] == [row.model_dump() for row in clean.candidates]
    assert poisoned.test_split != clean.test_split


def test_ties_keep_the_values_closest_to_the_current_config():
    report = _sweep()
    tied = [row for row in report.candidates if row.within_band and row.dev_tier_accuracy == 1.0]
    assert len(tied) == 2
    assert report.chosen.garbled_ratio == CURRENT.garbled_ratio


def test_fixture_split_follows_the_phase_1_rule():
    from rag_eval.split import assign_split

    for fixture_id in ("cross-boundary", "digital-text", "table-en", "scan-zh"):
        assert fixture_split(fixture_id) == assign_split(fixture_id)


def test_apply_thresholds_writes_the_choice_and_the_reference_and_still_validates():
    raw = json.loads((Path(__file__).resolve().parents[2] / "config" / "rag" / "parse-routing.json").read_text(encoding="utf-8"))
    chosen = SweepCandidate(garbled_ratio=0.06, min_ruling_paths=3, scanned_max_chars=40)
    updated = apply_thresholds(raw, chosen, "eval/reports/phase-03.1/threshold-sweep.json")
    cfg = ParseRoutingConfig.model_validate(updated)
    assert (cfg.l1.garbled_ratio, cfg.l1.min_ruling_paths, cfg.l1.scanned_max_chars) == (0.06, 3, 40)
    assert cfg.thresholds_ref == "eval/reports/phase-03.1/threshold-sweep.json"
    assert list(updated) == list(raw), "key order is kept"
    assert updated["l1"]["thin_path_pt"] == raw["l1"]["thin_path_pt"]
