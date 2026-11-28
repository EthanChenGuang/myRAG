"""Phase 5.3 D-33 to D-36: the release gate config and result; skipped is never folded into passed."""

from typing import Any

import pytest
from _contract_walk import unconstrained_strings
from pydantic import ValidationError

from rag_sidecar.contracts.release_gate import ReleaseGateConfig, ReleaseGatePart, ReleaseGateResult

SHA = "0123456789abcdef0123456789abcdef01234567"
H = "a" * 64


def _parts(**results: str) -> list[dict[str, Any]]:
    base = {"nightly_absolute": "passed", "judge_floors": "passed", "ship_check": "not_applicable", "pr_smoke": "passed"}
    base.update(results)
    parts = []
    for part, result in base.items():
        entry: dict[str, Any] = {"part": part, "result": result}
        if result in ("skipped", "failed"):
            entry["reason"] = "judge_keys_missing" if result == "skipped" else "false_answer_rate"
        if result == "not_applicable":
            entry["reason"] = "population_legacy"
        parts.append(entry)
    return parts


def _result(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "sha": SHA,
        "result": "passed",
        "parts": _parts(),
        "gate_file_hashes": {"quality_gates": H, "release_gate": H, "noise": H},
        "changed_gate_files": [],
        "source": "ci",
        "report_hashes": {"nightly": H},
        "created_at": "2026-01-05T06:00:00Z",
    }
    data.update(overrides)
    return data


def test_passed_result_validates_and_holds_no_text():
    ReleaseGateResult.model_validate(_result())
    assert unconstrained_strings(ReleaseGateResult, allow=frozenset({"override_reason"})) == []


def test_sha_must_be_forty_hex():
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(sha="abc123"))
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(sha="g" * 40))


def test_skipped_needs_a_reason_and_is_never_passed():
    parts = _parts(judge_floors="skipped")
    ReleaseGateResult.model_validate(_result(result="skipped", skip_reason="judge_keys_missing", parts=parts))
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(result="skipped", parts=parts))
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(result="passed", parts=parts))


def test_a_failed_part_makes_the_result_failed():
    parts = _parts(nightly_absolute="failed")
    ReleaseGateResult.model_validate(_result(result="failed", parts=parts))
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(result="passed", parts=parts))


def test_not_applicable_only_for_ship_check():
    ReleaseGatePart.model_validate({"part": "ship_check", "result": "not_applicable", "reason": "population_legacy"})
    with pytest.raises(ValidationError):
        ReleaseGatePart.model_validate({"part": "judge_floors", "result": "not_applicable"})
    with pytest.raises(ValidationError):
        ReleaseGatePart.model_validate({"part": "judge_floors", "result": "skipped"})


def test_result_values_are_closed():
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(result="success"))
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(source="manual"))


def test_override_needs_actor_and_a_capped_reason():
    override = _result(source="override", actor="repo-admin", override_reason="Emergency fix for a broken build")
    ReleaseGateResult.model_validate(override)
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate({**override, "actor": None})
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate({**override, "override_reason": "too short"})
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate({**override, "override_reason": "x" * 501})
    with pytest.raises(ValidationError):
        ReleaseGateResult.model_validate(_result(override_reason="Emergency fix for a broken build"))


def test_local_prerelease_source_is_accepted():
    ReleaseGateResult.model_validate(_result(source="local_prerelease", actor="repo-admin"))


def _config(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "status_context": "rag-release-gate",
        "required_parts": ["nightly_absolute", "judge_floors", "ship_check", "pr_smoke"],
        "provenance": {"source": "defaults"},
    }
    data.update(overrides)
    return data


def test_release_gate_config():
    config = ReleaseGateConfig.model_validate(_config())
    assert config.status_context == "rag-release-gate"
    with pytest.raises(ValidationError):
        ReleaseGateConfig.model_validate(_config(status_context="release"))
    with pytest.raises(ValidationError):
        ReleaseGateConfig.model_validate(_config(required_parts=["nightly_absolute", "manual_review"]))
    with pytest.raises(ValidationError):
        ReleaseGateConfig.model_validate(_config(required_parts=["pr_smoke", "pr_smoke"]))
    with pytest.raises(ValidationError):
        ReleaseGateConfig.model_validate(_config(required_parts=[]))
