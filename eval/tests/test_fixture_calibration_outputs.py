"""Checks the committed fixture sweep, calibration and refusal outcome (plan 04-39). Reads committed files only.

Rebuild outcome.json after re-running both harness runs:
    npm run test-rag -- --run-config eval/config/runs/v2-recommended.json --no-gate --out eval/out/p4-39-rec
    npm run test-rag -- --run-config eval/config/runs/v2-all-off.json --no-gate --out eval/out/p4-39-off
    uv run --directory eval python tests/test_fixture_calibration_outputs.py eval/out/p4-39-rec eval/out/p4-39-off
"""

import json
import sys
from pathlib import Path

import pytest
from rag_sidecar.contracts.retrieval import RefusalCalibrationConfig, RefusalThresholds

from rag_eval.bounds import upper_bound
from rag_eval.calibrate.refusal import FixtureScoreCalibration
from rag_eval.sweep.retrieval import SweepResult

REPO = Path(__file__).resolve().parents[2]
THRESHOLDS = REPO / "eval" / "config" / "refusal-thresholds.json"
FLOOR = REPO / "eval" / "config" / "fixture-score-calibration.json"
CALIBRATION = REPO / "eval" / "config" / "refusal-calibration.json"
NOISE = REPO / "eval" / "config" / "noise.json"
PARAMS = REPO / "eval" / "config" / "retrieval-params.json"
GOLDEN = REPO / "eval" / "fixtures" / "golden.jsonl"
SWEEP = REPO / "eval" / "reports" / "retrieval-sweep-fixture" / "retrieval-sweep.json"
OUTCOME = REPO / "eval" / "reports" / "refusal-calibration-fixture" / "outcome.json"
RUNS = ("v2_recommended", "v2_all_off")
SPLITS = ("dev", "test")
XLG_03_DEFERRED = "not comparable on fixture — deferred to live calibration (04-43)"
AT_OR_BELOW = "at or below the target"


def _golden() -> dict[str, dict]:
    return {row["id"]: row for row in (json.loads(line) for line in GOLDEN.read_text(encoding="utf-8").splitlines() if line.strip())}


def _split_block(traces: dict[str, dict], golden: dict[str, dict], split: str) -> dict:
    items = [item for item in golden.values() if item["split"] == split and item.get("review_status") == "approved"]
    answerable = [i["id"] for i in items if i["answerable"]]
    no_answer = [i["id"] for i in items if not i["answerable"]]
    refused_answerable = sorted(i for i in answerable if traces[i]["refused"])
    answered_no_answer = sorted(i for i in no_answer if not traces[i]["refused"])
    correct = len(no_answer) - len(answered_no_answer)
    return {
        "correct_refusal": correct / len(no_answer),
        "correct_refusal_n": len(no_answer),
        "correct_refusal_upper_95": upper_bound(correct, len(no_answer)),
        "false_refusal": len(refused_answerable) / len(answerable),
        "false_refusal_n": len(answerable),
        "false_refusal_upper_95": upper_bound(len(refused_answerable), len(answerable)),
        "refused_answerable": refused_answerable,
        "answered_no_answer": answered_no_answer,
    }


def build_outcome(rec_dir: Path, off_dir: Path) -> dict:
    """Outcome of the two fixture runs with the fixture thresholds and floor applied; stdlib plus the shared bounds helper."""
    golden = _golden()
    config = RefusalCalibrationConfig.model_validate_json(CALIBRATION.read_text(encoding="utf-8"))
    noise_floor = json.loads(NOISE.read_text(encoding="utf-8"))["floor"]
    floor = FixtureScoreCalibration.model_validate_json(FLOOR.read_text(encoding="utf-8"))
    outcome: dict = {"schema_version": 1, "source": "fixture", "runs": {}, "dev": {}, "test": {}}
    for name, run_dir in zip(RUNS, (Path(rec_dir), Path(off_dir))):
        report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
        traces = {}
        for line in (run_dir / "traces.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                trace = json.loads(line)
                traces[trace["item_id"]] = trace
        outcome["runs"][name] = {
            "run_config": f"eval/config/runs/{name.replace('_', '-')}.json",
            "run_config_hash": report["run_config_hash"],
            "golden_sha256": report["golden_sha256"],
        }
        for split in SPLITS:
            block = _split_block(traces, golden, split)
            reported = report["by_split"][split]
            assert block["false_refusal"] == pytest.approx(reported["false_refusal_rate"]["value"]), (name, split)
            assert block["correct_refusal"] == pytest.approx(reported["correct_refusal_rate"]["value"]), (name, split)
            outcome[split][name] = block
    target = config.target_false_refusal
    rec, off = outcome["dev"]["v2_recommended"], outcome["dev"]["v2_all_off"]
    outcome["target_false_refusal"] = target
    outcome["noise_floor"] = noise_floor
    outcome["fixture_floor"] = {"source": floor.source, "fixture_mode": floor.fixture_mode, **floor.score_calibration}
    outcome["comparison"] = {
        "dev_correct_refusal_delta": rec["correct_refusal"] - off["correct_refusal"],
        "dev_correct_refusal_improved": rec["correct_refusal"] > off["correct_refusal"],
        "dev_false_refusal_delta": rec["false_refusal"] - off["false_refusal"],
        "dev_false_refusal_within_target_plus_noise": rec["false_refusal"] <= target + noise_floor,
        "dev_false_refusal_upper_95_at_or_below_target": rec["false_refusal_upper_95"] <= target,
    }
    outcome["xlg_03"] = XLG_03_DEFERRED
    upper_ok = rec["false_refusal_upper_95"] <= target
    outcome["notes"] = [
        (
            f"Dev false refusal with thresholds applied: {rec['false_refusal']:.3f} (95% upper {rec['false_refusal_upper_95']:.3f}); "
            + (
                f"the upper bound is {AT_OR_BELOW} ({target})."
                if upper_ok
                else f"the point estimate is within target plus noise floor ({target + noise_floor:.2f}), but the upper bound is above the {target} target, so it is not shown to meet it."
            )
        ),
        (
            f"Dev correct refusal: v2-recommended {rec['correct_refusal']:.3f} versus v2-all-off {off['correct_refusal']:.3f}. "
            "Both runs use the dev-fitted fixture floor; on the fixture the fake reranker scores track the fixture embedder, "
            "so the threshold cells refuse the same no-answer items the floor refuses and the gain shows up as fewer false refusals."
        ),
        "Every cross cell is insufficient_data on the fixture (translation off), so cross-lingual items fall back to the floor.",
    ]
    return outcome


def _outcome() -> dict:
    assert OUTCOME.is_file(), f"{OUTCOME} is missing; build it with this module's __main__"
    return json.loads(OUTCOME.read_text(encoding="utf-8"))


def test_thresholds_file_is_valid_and_every_cell_carries_counts_bounds_and_status():
    thresholds = RefusalThresholds.model_validate_json(THRESHOLDS.read_text(encoding="utf-8"))
    assert thresholds.cells
    for cell in thresholds.cells:
        for block in (cell.dev, cell.holdout):
            assert block is not None
            assert block.answerable_count >= 0 and block.no_answer_count >= 0
            assert 0 <= block.false_refusal_rate <= block.false_refusal_rate_upper_bound <= 1
        assert cell.status in ("calibrated", "uncalibrated", "insufficient_data", "failed_holdout")
        if cell.status == "calibrated":
            assert cell.threshold is not None
        assert (cell.source == "fixture") == cell.model.startswith("fake-"), cell.key


def test_each_language_has_a_calibrated_same_language_fixture_cell():
    thresholds = RefusalThresholds.model_validate_json(THRESHOLDS.read_text(encoding="utf-8"))
    fixture = [c for c in thresholds.cells if c.source == "fixture"]
    for language in ("en", "it", "zh"):
        assert any(c.query_language == language and c.pairing == "same" and c.status == "calibrated" for c in fixture), language
    for cell in fixture:
        assert cell.holdout_evaluations <= 1, cell.key


def test_fixture_floor_is_a_calibrated_fixture_record_with_only_a_context_threshold():
    floor = FixtureScoreCalibration.model_validate_json(FLOOR.read_text(encoding="utf-8"))
    assert floor.source == "fixture" and floor.status == "calibrated"
    assert list(floor.score_calibration) == ["context_threshold"]
    assert 0 < floor.score_calibration["context_threshold"] < 0.65
    assert floor.dev is not None and floor.dev.false_refusal_rate <= floor.target_false_refusal


def test_sweep_result_is_a_fixture_run_on_dev_that_left_the_params_alone():
    sweep = SweepResult.model_validate_json(SWEEP.read_text(encoding="utf-8"))
    assert sweep.mode == "fixture"
    assert not sweep.params_written
    assert sweep.selection.chosen in sweep.cells
    assert {c.candidate_pool_size for c in sweep.cells} == {25, 50, 75, 100}
    assert all(not Path(c.out_dir).is_absolute() for c in sweep.cells)
    assert json.loads(PARAMS.read_text(encoding="utf-8"))["provenance"]["source"] == "defaults"


@pytest.mark.parametrize("split", SPLITS)
@pytest.mark.parametrize("run", RUNS)
def test_outcome_blocks_are_consistent_with_their_id_lists(split, run):
    golden = _golden()
    block = _outcome()[split][run]
    for key in ("correct_refusal", "false_refusal"):
        assert 0 <= block[key] <= block[f"{key}_upper_95"] <= 1
    assert block["false_refusal"] == pytest.approx(len(block["refused_answerable"]) / block["false_refusal_n"])
    assert 1 - block["correct_refusal"] == pytest.approx(len(block["answered_no_answer"]) / block["correct_refusal_n"])
    for item_id in block["refused_answerable"]:
        assert golden[item_id]["answerable"] and golden[item_id]["split"] == split
    for item_id in block["answered_no_answer"]:
        assert not golden[item_id]["answerable"] and golden[item_id]["split"] == split


def test_thresholds_do_not_lose_correct_refusals_and_cut_false_refusals_on_dev():
    outcome = _outcome()
    rec, off = outcome["dev"]["v2_recommended"], outcome["dev"]["v2_all_off"]
    assert rec["correct_refusal"] >= off["correct_refusal"]
    assert rec["false_refusal"] < off["false_refusal"]
    assert outcome["comparison"]["dev_correct_refusal_improved"] == (rec["correct_refusal"] > off["correct_refusal"])


def test_dev_false_refusal_point_estimate_is_within_target_plus_noise_floor():
    outcome = _outcome()
    config = RefusalCalibrationConfig.model_validate_json(CALIBRATION.read_text(encoding="utf-8"))
    noise_floor = json.loads(NOISE.read_text(encoding="utf-8"))["floor"]
    assert outcome["dev"]["v2_recommended"]["false_refusal"] <= config.target_false_refusal + noise_floor


def test_outcome_never_claims_the_target_without_the_upper_bound():
    outcome = _outcome()
    upper = outcome["dev"]["v2_recommended"]["false_refusal_upper_95"]
    claims = [note for note in outcome["notes"] if AT_OR_BELOW in note]
    if upper > outcome["target_false_refusal"]:
        assert not claims
        assert outcome["comparison"]["dev_false_refusal_upper_95_at_or_below_target"] is False


def test_xlg_03_stays_deferred_while_no_fixture_cross_cell_is_calibrated():
    thresholds = RefusalThresholds.model_validate_json(THRESHOLDS.read_text(encoding="utf-8"))
    cross = [c for c in thresholds.cells if c.source == "fixture" and c.pairing == "cross"]
    if not any(c.status == "calibrated" for c in cross):
        assert _outcome()["xlg_03"] == XLG_03_DEFERRED


def test_outcome_uses_the_committed_floor():
    floor = FixtureScoreCalibration.model_validate_json(FLOOR.read_text(encoding="utf-8"))
    assert _outcome()["fixture_floor"] == {"source": "fixture", "fixture_mode": floor.fixture_mode, **floor.score_calibration}


if __name__ == "__main__":
    data = build_outcome(Path(sys.argv[1]), Path(sys.argv[2]))
    OUTCOME.write_text(json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUTCOME.relative_to(REPO)}")
