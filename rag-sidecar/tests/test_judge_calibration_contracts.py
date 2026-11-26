"""Phase 5.3 D-28, D-29, D-31: judge calibration cells and seed cases."""

from typing import Any

import pytest
from _contract_walk import unconstrained_strings
from pydantic import ValidationError

from rag_sidecar.contracts.judge_calibration import JudgeCalibration, JudgeCalibrationCell, JudgeSeedCase

FP = "f" * 64


def _cell(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "key": f"{FP}|nightly|en|ragas.faithfulness",
        "fingerprint": FP,
        "role": "nightly",
        "language": "en",
        "library": "ragas",
        "metric": "faithfulness",
        "status": "gating",
        "reasons": [],
        "kappa": 0.74,
        "accuracy": 0.88,
        "n": 100,
        "source": "review_queue",
        "unsupported_recall": 0.9,
        "unsupported_precision": 0.85,
        "length_bias_delta": 0.02,
        "expanded_delta": 0.01,
        "assertive_delta": 0.03,
        "labels_human_confirmed": True,
        "recorded_at": "2026-01-05T06:00:00Z",
    }
    data.update(overrides)
    return data


def test_cell_validates_and_holds_numbers_only():
    JudgeCalibrationCell.model_validate(_cell())
    assert unconstrained_strings(JudgeCalibrationCell) == []
    assert unconstrained_strings(JudgeCalibration) == []
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(tenant_key="s:default"))


def test_cell_key_must_match_its_dimensions():
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(key=f"{FP}|online|en|ragas.faithfulness"))
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(key=f"{FP}|nightly|en|deepeval.faithfulness"))


def test_gating_needs_a_kappa_and_confirmed_labels_and_no_reasons():
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(kappa=None))
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(labels_human_confirmed=False))
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(reasons=["n_below_minimum"]))


def test_report_only_with_undefined_kappa_is_accepted():
    cell = JudgeCalibrationCell.model_validate(
        _cell(status="report_only", kappa=None, reasons=["kappa_undefined", "labels_not_confirmed"], labels_human_confirmed=False)
    )
    assert cell.kappa is None
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(status="report_only", reasons=[]))


@pytest.mark.parametrize(
    "reason",
    [
        "kappa_below_floor",
        "accuracy_below_floor",
        "n_below_minimum",
        "labels_not_confirmed",
        "length_bias",
        "perturbation",
        "kappa_undefined",
    ],
)
def test_known_reason_codes(reason: str):
    JudgeCalibrationCell.model_validate(_cell(status="report_only", reasons=[reason]))


def test_unknown_reason_and_uncalibrated_status_are_rejected():
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(status="report_only", reasons=["felt_wrong"]))
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(status="uncalibrated", reasons=["n_below_minimum"]))


def test_holistic_metric_can_never_gate():
    key = f"{FP}|nightly|en|ragas.holistic_quality"
    with pytest.raises(ValidationError):
        JudgeCalibrationCell.model_validate(_cell(key=key, metric="holistic_quality"))
    JudgeCalibrationCell.model_validate(
        _cell(key=key, metric="holistic_quality", status="report_only", reasons=["n_below_minimum"])
    )


def test_calibration_file_rejects_duplicate_keys_and_starts_empty():
    empty = JudgeCalibration.model_validate({"cells": [], "provenance": {"source": "defaults"}})
    assert empty.cells == []
    assert empty.running_fingerprints == {}
    with pytest.raises(ValidationError):
        JudgeCalibration.model_validate({"cells": [_cell(), _cell()], "provenance": {"source": "calibration"}})
    calibrated = JudgeCalibration.model_validate(
        {"cells": [_cell()], "running_fingerprints": {"nightly": FP}, "provenance": {"source": "calibration"}}
    )
    assert calibrated.running_fingerprints == {"nightly": FP}


def _seed(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "en-seed-001",
        "language": "en",
        "question": "Which colour is the sample box?",
        "contexts": ["The sample box is blue."],
        "answer": "The sample box is blue.",
        "expected": {"faithfulness": True, "answer_relevance": True},
        "unsupported_content": False,
        "variant": "base",
        "review_status": "draft",
    }
    data.update(overrides)
    return data


def test_seed_case_variants_need_a_base_id():
    JudgeSeedCase.model_validate(_seed())
    with pytest.raises(ValidationError):
        JudgeSeedCase.model_validate(_seed(id="en-seed-001-long", variant="long"))
    JudgeSeedCase.model_validate(_seed(id="en-seed-001-long", variant="long", base_id="en-seed-001", pair_id="p-001"))
    with pytest.raises(ValidationError):
        JudgeSeedCase.model_validate(_seed(base_id="en-seed-000"))


def test_seed_review_status():
    with pytest.raises(ValidationError):
        JudgeSeedCase.model_validate(_seed(review_status="approved"))
    JudgeSeedCase.model_validate(_seed(review_status="approved", reviewed_by="reviewer-01"))
    with pytest.raises(ValidationError):
        JudgeSeedCase.model_validate(_seed(review_status="published"))


def test_seed_expected_verdicts_name_known_metrics():
    with pytest.raises(ValidationError):
        JudgeSeedCase.model_validate(_seed(expected={"made_up": True}))
