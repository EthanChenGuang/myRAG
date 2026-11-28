import json
from pathlib import Path

import pytest
from rag_sidecar.contracts.baseline import NoiseConfig

from rag_eval.decisions import decide_table_header_default, main

REPO = Path(__file__).resolve().parents[2]
NOISE = NoiseConfig.model_validate(json.loads((REPO / "eval/config/noise.json").read_text(encoding="utf-8")))
DATE = "2026-11-26"
HIGHER = {"recall_at_5": True, "recall_at_10": True, "mrr": True, "correct_refusal_rate": True, "false_refusal_rate": False}


def _row(slice_name: str, metric: str, off: float, on: float, n: int = 10) -> dict:
    mean_d = round(on - off, 6)
    better = mean_d > 0 if HIGHER[metric] else mean_d < 0
    return {
        "slice": slice_name,
        "metric": metric,
        "n": n,
        "off": off,
        "on": on,
        "paired": {"n": n, "n_nonzero": 0 if mean_d == 0 else n, "mean_d": mean_d, "ci_low": mean_d, "ci_high": mean_d},
        "band": 0.02,
        "beyond_band": abs(mean_d) > 0.02,
        "direction": "none" if mean_d == 0 else ("up" if better else "down"),
    }


def _flat(*slices: str) -> list[dict]:
    return [_row(name, metric, 0.8, 0.8) for name in slices for metric in ("recall_at_5", "recall_at_10", "mrr")]


OTHER = ("overall", "language:en", "language:it", "language:zh", "category:cross_lingual", "pair:en->it")


def _comparison(split_gain: float = 0.1, *, extra: list[dict] | None = None, split_rows: list[dict] | None = None, **arm) -> dict:
    split = split_rows if split_rows is not None else [
        _row("category:table_split", "recall_at_5", 0.8, 0.8 + split_gain),
        _row("category:table_split", "recall_at_10", 0.8, 0.8 + split_gain),
        _row("category:table_split", "mrr", 0.7, 0.7 + split_gain),
    ]
    others = _flat(*OTHER)
    for override in extra or []:
        others = [row for row in others if (row["slice"], row["metric"]) != (override["slice"], override["metric"])] + [override]
    table_arm = {
        "name": "table_header_repeat",
        "switch": "RAG_TABLE_HEADER_REPEAT",
        "off_value": "profile",
        "on_value": "always",
        "side": "ingestion",
        "fixture_mode": "ingest",
        "optional": False,
        "status": "passed",
        "judged_slices": ["category:table", "category:table_split"],
        "rows": [_row("category:table", "recall_at_10", 1.0, 1.0), *split],
        "gated_rows": sorted(others + split, key=lambda row: (row["slice"], row["metric"])),
        "runs": {"off": "run-off-0001", "on": "run-on-0001"},
        "failures": [],
        "wiring_proof": True,
        "recommendation": None,
        "notes": [],
    }
    table_arm.update(arm)
    return {
        "schema_version": 3,
        "phase": "03.2",
        "passed": True,
        "wiring_proof": True,
        "label": "wiring proof",
        "band": 0.02,
        "live_checks": "03.2-53",
        "arms": [table_arm],
        "notes": [],
    }


def _decide(comparison: dict | None) -> dict:
    result = decide_table_header_default(comparison, NOISE, date=DATE)
    return result if isinstance(result, dict) else result.model_dump(mode="json")


def test_table_header_rule_flips_to_always_when_table_split_gains_beyond_the_band_and_nothing_drops():
    record = _decide(_comparison(0.1))
    assert record.get("decision") == "always"
    assert record.get("reason") == "gain_without_regression"
    assert record.get("failing_slices") == []


def test_table_header_rule_keeps_profile_with_no_gain_when_the_gain_is_inside_the_band():
    record = _decide(_comparison(0.01))
    assert (record.get("decision"), record.get("reason")) == ("profile", "no_gain")


def test_table_header_rule_recomputes_beyond_band_from_the_difference_not_from_the_row_flags():
    rows = [dict(row, beyond_band=True, direction="up") for row in _comparison(0.02)["arms"][0]["rows"] if row["slice"] == "category:table_split"]
    record = _decide(_comparison(split_rows=rows))
    assert (record.get("decision"), record.get("reason")) == ("profile", "no_gain"), "a difference equal to the band is not beyond it"


def test_table_header_rule_keeps_profile_on_a_regression_and_names_the_slices():
    drop = _row("language:it", "recall_at_10", 0.8, 0.75)
    rise = _row("overall", "false_refusal_rate", 0.1, 0.15)
    record = _decide(_comparison(0.1, extra=[drop, rise]))
    assert (record.get("decision"), record.get("reason")) == ("profile", "regression")
    assert record.get("failing_slices") == ["language:it:recall_at_10", "overall:false_refusal_rate"]


def test_table_header_rule_counts_a_table_split_drop_on_another_metric_as_a_regression():
    split = [
        _row("category:table_split", "recall_at_10", 0.8, 0.9),
        _row("category:table_split", "mrr", 0.8, 0.7),
    ]
    record = _decide(_comparison(split_rows=split))
    assert (record.get("decision"), record.get("reason")) == ("profile", "regression")
    assert record.get("failing_slices") == ["category:table_split:mrr"]


def test_table_header_rule_keeps_profile_on_a_drop_the_arm_reports_as_a_failure():
    record = _decide(_comparison(0.1, status="failed", failures=["language:zh:mrr dropped by 0.0500 (band 0.02, n=10)"]))
    assert (record.get("decision"), record.get("reason")) == ("profile", "regression")
    assert "language:zh:mrr" in record.get("failing_slices", [])


@pytest.mark.parametrize(
    "comparison, problem",
    [
        (None, "comparison missing"),
        ({**_comparison(), "arms": []}, "no table_header_repeat arm"),
        (_comparison(status="not_run", rows=[], gated_rows=[], runs=None), "the arm was not run"),
        (_comparison(split_rows=[]), "category:table_split has no counting item"),
        ({**_comparison(), "schema_version": 2}, "comparison is not schema 3"),
    ],
)
def test_table_header_rule_keeps_profile_on_insufficient_evidence(comparison, problem):
    record = _decide(comparison)
    assert (record.get("decision"), record.get("reason")) == ("profile", "insufficient_evidence")
    assert any(problem in entry for entry in record.get("evidence_problems", [])), record.get("evidence_problems")


def test_table_header_rule_without_gated_rows_is_insufficient_evidence():
    comparison = _comparison()
    del comparison["arms"][0]["gated_rows"]
    record = _decide(comparison)
    assert (record.get("decision"), record.get("reason")) == ("profile", "insufficient_evidence")


def test_table_header_record_carries_the_numbers_runs_rule_and_date():
    record = _decide(_comparison(0.1, extra=[_row("language:en", "mrr", 0.8, 0.81)]))
    assert record.get("switch") == "RAG_TABLE_HEADER_REPEAT"
    assert record.get("off_value") == "profile" and record.get("on_value") == "always"
    assert record.get("band") == 0.02
    assert record.get("runs") == {"off": "run-off-0001", "on": "run-on-0001"}
    assert record.get("date") == DATE
    assert "table_split" in record.get("rule", "") and "noise band" in record.get("rule", "")
    assert record.get("wiring_proof") is True
    split = {row["metric"]: row for row in record.get("table_split", [])}
    assert split["recall_at_10"]["off"] == 0.8 and split["recall_at_10"]["on"] == pytest.approx(0.9)
    assert split["recall_at_10"]["mean_d"] == pytest.approx(0.1) and split["recall_at_10"]["beyond_band"] is True
    others = {(row["slice"], row["metric"]): row for row in record.get("other_gated", [])}
    assert set(OTHER) == {key[0] for key in others}
    assert others[("language:en", "mrr")]["mean_d"] == pytest.approx(0.01)
    assert not any(key[0] == "category:table_split" for key in others)


def _write_world(tmp_path: Path, comparison: dict) -> tuple[Path, Path]:
    report = tmp_path / "reports" / "phase32"
    report.mkdir(parents=True)
    (report / "comparison.json").write_text(json.dumps(comparison, indent=2), encoding="utf-8")
    return report, tmp_path / "decisions" / "03.2-table-header-default.json"


def _cli(report: Path, out: Path, *extra: str) -> int:
    return main(["table-header-default", "--report", str(report), "--out", str(out), "--date", DATE, *extra])


def test_table_header_cli_writes_a_record_that_validates_and_is_byte_stable(tmp_path: Path):
    from rag_eval.decisions import TableHeaderDecision

    report, out = _write_world(tmp_path, _comparison(0.1))
    assert _cli(report, out) == 0
    first = out.read_bytes()
    assert _cli(report / "comparison.json", out) == 0
    assert out.read_bytes() == first
    payload = json.loads(first)
    assert TableHeaderDecision.model_validate(payload).decision == "always"
    assert payload["source"]["sha256"] and payload["source"]["path"].endswith("comparison.json")
    with pytest.raises(ValueError):
        TableHeaderDecision.model_validate({**payload, "unexpected": 1})
    with pytest.raises(ValueError):
        TableHeaderDecision.model_validate({**payload, "decision": "sometimes"})


def test_table_header_cli_keeps_the_recorded_date_when_no_date_is_given(tmp_path: Path):
    report, out = _write_world(tmp_path, _comparison(0.1))
    assert _cli(report, out) == 0
    first = out.read_bytes()
    assert main(["table-header-default", "--report", str(report), "--out", str(out)]) == 0
    assert out.read_bytes() == first


def test_table_header_cli_check_passes_on_the_same_inputs_and_fails_when_they_differ(tmp_path: Path):
    report, out = _write_world(tmp_path, _comparison(0.1))
    assert _cli(report, out) == 0
    before = out.read_bytes()
    assert _cli(report, out, "--check") == 0
    assert out.read_bytes() == before, "--check writes nothing"
    (report / "comparison.json").write_text(json.dumps(_comparison(0.01)), encoding="utf-8")
    assert _cli(report, out, "--check") == 1
    assert out.read_bytes() == before


def test_table_header_cli_check_fails_without_a_record_and_a_missing_report_is_insufficient_evidence(tmp_path: Path):
    report, out = _write_world(tmp_path, _comparison(0.1))
    assert _cli(report, out, "--check") == 1
    missing = tmp_path / "nowhere"
    assert _cli(missing, out) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["reason"] == "insufficient_evidence"


def test_the_committed_table_header_record_matches_the_committed_comparison():
    assert main(
        [
            "table-header-default",
            "--report",
            str(REPO / "eval/reports/phase32"),
            "--out",
            str(REPO / "eval/decisions/03.2-table-header-default.json"),
            "--check",
        ]
    ) == 0
