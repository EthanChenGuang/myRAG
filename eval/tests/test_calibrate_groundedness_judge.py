import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.claims import GroundednessJudgeThresholdCell, GroundednessJudgeThresholds

from rag_eval.calibrate.__main__ import main
from rag_eval.calibrate.groundedness_judge import (
    DEFAULT_LABELLED,
    FAKE_JUDGE_MODEL,
    THRESHOLDS_PATH,
    JudgeCalibrationError,
    JudgedAnswer,
    Row,
    balanced_accuracy,
    build_rows,
    calibrate_language,
    fit_max_share,
    load_labelled,
    merge_cells,
    run_judge_calibration,
    run_judge_harness,
    sentence_scores,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
NEEDS_NODE = pytest.mark.skipif(
    shutil.which("npx") is None or not (REPO_ROOT / "node_modules" / ".bin" / "tsx").exists(),
    reason="needs node and the repository node_modules",
)


def _row(answer_id: str, language: str, split: str, faithful: bool, share: float, sentences=((False, False),)) -> Row:
    return Row(answer_id=answer_id, language=language, split=split, faithful=faithful, share=share, sentences=tuple(sentences))


def test_the_labelled_fixture_holds_twelve_answers_per_language_and_split_with_both_labels():
    answers = load_labelled(DEFAULT_LABELLED)
    for language in ("zh", "en", "it"):
        for split in ("dev", "test"):
            own = [a for a in answers if a.language == language and a.split == split]
            assert len(own) >= 12
            assert any(a.faithful for a in own) and any(not a.faithful for a in own)
            labels = {s.label for a in own for s in a.sentences}
            assert labels == {"supported", "unsupported"}


def test_fit_picks_the_share_with_the_best_balanced_accuracy_on_dev_and_ties_go_stricter():
    rows = [_row(f"f{i}", "it", "dev", True, 0.0) for i in range(4)] + [_row("f4", "it", "dev", True, 1 / 3)]
    rows += [_row(f"u{i}", "it", "dev", False, 2 / 3) for i in range(4)] + [_row("u4", "it", "dev", False, 1 / 3)]
    share, accuracy = fit_max_share(rows)
    # 1/3 verifies all faithful and flags 4/5 unfaithful (0.9); 0 verifies 4/5 and flags all (0.9): the tie goes to 0.
    assert share == 0.0 and accuracy == pytest.approx(0.9)
    rows.append(_row("f5", "it", "dev", True, 1 / 3))
    share, accuracy = fit_max_share(rows)
    assert share == pytest.approx(1 / 3)
    assert balanced_accuracy(rows, share) == accuracy


def test_sentence_recall_and_precision_are_on_unsupported_sentences():
    rows = [_row("a", "it", "test", False, 0.5, [(True, True), (True, False), (False, True), (False, False)])]
    scores = sentence_scores(rows)
    assert scores == {"unsupported_sentences": 2, "judged_unsupported": 2, "recall": 0.5, "precision": 0.5}


def _language_rows(language: str, dev_ok: bool = True) -> list[Row]:
    rows: list[Row] = []
    for split, count in (("dev", 4 if dev_ok else 2), ("test", 3)):
        rows += [_row(f"{split}-f{i}", language, split, True, 0.0, [(False, False)]) for i in range(count)]
        rows += [_row(f"{split}-u{i}", language, split, False, 0.5, [(True, True), (False, False)]) for i in range(count)]
    return rows


def test_a_language_calibrates_on_dev_and_is_checked_once_on_test():
    record = calibrate_language(
        "it", _language_rows("it"), judge_model=FAKE_JUDGE_MODEL, judge_version="v", source="fixture", run_id="r", config_hash="h", now="2026-11-27"
    )
    assert record.status == "calibrated"
    assert record.cell is not None
    assert record.cell.max_unsupported_share == 0.0
    assert record.cell.recall == 1.0 and record.cell.precision == 1.0
    assert record.holdout is not None and record.holdout["balanced_accuracy"] == 1.0
    assert (record.cell.judge_model, record.cell.judge_version, record.cell.language) == (FAKE_JUDGE_MODEL, "v", "it")


def test_too_few_dev_answers_give_no_cell():
    record = calibrate_language(
        "it", _language_rows("it", dev_ok=False), judge_model=FAKE_JUDGE_MODEL, judge_version="v", source="fixture", run_id="r", config_hash="h", now="d"
    )
    assert record.status == "insufficient_data" and record.cell is None


def test_a_holdout_worse_than_zero_tolerance_gives_no_cell():
    rows = [_row(f"df{i}", "it", "dev", True, 0.5) for i in range(4)] + [_row(f"du{i}", "it", "dev", False, 1.0) for i in range(4)]
    rows += [_row(f"tf{i}", "it", "test", True, 0.0) for i in range(3)] + [_row(f"tu{i}", "it", "test", False, 0.5) for i in range(3)]
    record = calibrate_language("it", rows, judge_model=FAKE_JUDGE_MODEL, judge_version="v", source="fixture", run_id="r", config_hash="h", now="d")
    assert record.max_unsupported_share == 0.5
    assert record.status == "failed_holdout" and record.cell is None


def _cell(model: str, language: str, version: str = "v") -> GroundednessJudgeThresholdCell:
    return GroundednessJudgeThresholdCell(
        judge_model=model, judge_version=version, language=language, max_unsupported_share=0.0, recall=1.0, precision=1.0,
        source="fixture", run_ids=["r"], config_hash="h",
    )


def test_the_thresholds_contract_rejects_duplicate_cells():
    with pytest.raises(ValidationError, match="duplicate"):
        GroundednessJudgeThresholds(cells=[_cell(FAKE_JUDGE_MODEL, "it"), _cell(FAKE_JUDGE_MODEL, "it")])


def test_merge_replaces_this_judges_cells_and_drops_one_that_no_longer_calibrates():
    existing = GroundednessJudgeThresholds(cells=[_cell(FAKE_JUDGE_MODEL, "it"), _cell(FAKE_JUDGE_MODEL, "en"), _cell("other/judge", "it")])
    calibrated = calibrate_language(
        "it", _language_rows("it"), judge_model=FAKE_JUDGE_MODEL, judge_version="v", source="fixture", run_id="new", config_hash="h", now="d"
    )
    failed = calibrate_language(
        "en", _language_rows("en", dev_ok=False), judge_model=FAKE_JUDGE_MODEL, judge_version="v", source="fixture", run_id="new", config_hash="h", now="d"
    )
    merged = merge_cells(existing, [calibrated, failed], FAKE_JUDGE_MODEL, "v")
    keys = [(c.judge_model, c.language, c.run_ids[0]) for c in merged.cells]
    assert keys == [(FAKE_JUDGE_MODEL, "it", "new"), ("other/judge", "it", "r")]


def _judged_line(answer_id: str, language: str, split: str, verdicts: list[str], model: str = FAKE_JUDGE_MODEL) -> str:
    return json.dumps(
        {
            "id": answer_id,
            "language": language,
            "split": split,
            "status": "judged",
            "reason": None,
            "judge_model": model,
            "judge_version": "v1",
            "verdicts": [{"index": i, "verdict": v} for i, v in enumerate(verdicts)],
        }
    )


def test_build_rows_requires_one_judge_and_one_line_per_answer():
    answers = load_labelled(DEFAULT_LABELLED)[:2]
    one = JudgedAnswer.model_validate_json(_judged_line(answers[0].id, answers[0].language, answers[0].split, ["supported"] * 3))
    with pytest.raises(JudgeCalibrationError, match="one line per labelled answer"):
        build_rows(answers, [one])
    other = JudgedAnswer.model_validate_json(_judged_line(answers[1].id, answers[1].language, answers[1].split, ["supported"] * 3, model="x/y"))
    with pytest.raises(JudgeCalibrationError, match="exactly one judge"):
        build_rows(answers, [one, other])


def test_a_real_judge_never_writes_cells_from_the_fixture_answers(tmp_path: Path):
    def spawner(argv, cwd):
        raise AssertionError("must refuse before spawning")

    with pytest.raises(JudgeCalibrationError, match="real labelled file"):
        run_judge_calibration(
            DEFAULT_LABELLED, tmp_path / "t.json", tmp_path / "r", judge="openai/gpt-4.1-mini", generator_model="anthropic/claude-x", spawner=spawner
        )


def test_the_harness_spawn_failure_is_reported(tmp_path: Path):
    def spawner(argv, cwd):
        return SimpleNamespace(returncode=2, stdout="", stderr="[Run Judge] malformed labelled input: line 1: bad id")

    with pytest.raises(JudgeCalibrationError, match="exit code 2"):
        run_judge_harness(DEFAULT_LABELLED, tmp_path / "j.jsonl", judge="fake", spawner=spawner)


def test_the_committed_cells_are_fixture_cells_of_the_fake_judge_only():
    thresholds = GroundednessJudgeThresholds.model_validate_json(THRESHOLDS_PATH.read_text(encoding="utf-8"))
    assert thresholds.cells, "run python -m rag_eval.calibrate groundedness-judge --judge fake once on the fixtures"
    assert {cell.judge_model for cell in thresholds.cells} == {FAKE_JUDGE_MODEL}
    assert {cell.source for cell in thresholds.cells} == {"fixture"}
    assert {cell.language for cell in thresholds.cells} == {"zh", "en", "it"}
    production = [c for c in thresholds.cells if not c.judge_model.startswith("fake/")]
    assert production == []


def _sample(tmp_path: Path) -> Path:
    lines = DEFAULT_LABELLED.read_text(encoding="utf-8").splitlines()
    picked = [line for line in lines if json.loads(line)["id"] in {"judge-it-dev-01", "judge-it-dev-05", "judge-it-dev-07"}]
    path = tmp_path / "sample.jsonl"
    path.write_text("\n".join(picked) + "\n", encoding="utf-8")
    return path


@NEEDS_NODE
def test_harness_run_judge_with_the_fake_writes_one_line_per_answer(tmp_path: Path):
    sample = _sample(tmp_path)
    judged = run_judge_harness(sample, tmp_path / "judged.jsonl", judge="fake")
    by_id = {line.id: line for line in judged}
    assert set(by_id) == {"judge-it-dev-01", "judge-it-dev-05", "judge-it-dev-07"}
    for line in judged:
        assert line.status == "judged" and line.judge_model == FAKE_JUDGE_MODEL and line.judge_version
    labelled = {a.id: a for a in load_labelled(sample)}
    assert [v.verdict for v in by_id["judge-it-dev-01"].verdicts] == ["supported"] * 3
    assert [v.index for v in by_id["judge-it-dev-07"].verdicts] == [s.index for s in labelled["judge-it-dev-07"].sentences]
    assert by_id["judge-it-dev-07"].verdicts[2].verdict == "unsupported"


@NEEDS_NODE
def test_harness_run_judge_exits_2_on_a_malformed_line(tmp_path: Path):
    bad = tmp_path / "bad.jsonl"
    good = _sample(tmp_path).read_text(encoding="utf-8").splitlines()[0]
    broken = json.loads(good)
    broken["sentences"][0]["label"] = "maybe"
    bad.write_text(good + "\n" + json.dumps(broken) + "\n", encoding="utf-8")
    with pytest.raises(JudgeCalibrationError, match="exit code 2"):
        run_judge_harness(bad, tmp_path / "judged.jsonl", judge="fake")


@NEEDS_NODE
def test_harness_end_to_end_fixture_calibration_writes_three_fixture_cells_to_a_temporary_file(tmp_path: Path):
    out = tmp_path / "thresholds.json"
    before = THRESHOLDS_PATH.read_bytes()
    result = run_judge_calibration(DEFAULT_LABELLED, out, tmp_path / "report", judge="fake")
    assert THRESHOLDS_PATH.read_bytes() == before
    cells = GroundednessJudgeThresholds.model_validate_json(out.read_text(encoding="utf-8")).cells
    assert sorted(c.language for c in cells) == ["en", "it", "zh"]
    assert all(c.source == "fixture" and c.judge_model == FAKE_JUDGE_MODEL and c.judge_version == result.judge_version for c in cells)
    assert all(0 < c.recall <= 1 and 0 < c.precision <= 1 for c in cells)
    committed = GroundednessJudgeThresholds.model_validate_json(before)
    assert [c.model_dump(exclude={"fitted_at"}) for c in committed.cells] == [c.model_dump(exclude={"fitted_at"}) for c in cells]


def test_cli_requires_a_judge(capsys):
    with pytest.raises(SystemExit):
        main(["groundedness-judge"])
