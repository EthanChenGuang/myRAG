"""Phase 5.3 D-13 to D-17: setting checks, change records and the weekly gates section hold names and hashes only."""

from typing import Any

import pytest
from _contract_walk import unconstrained_strings
from pydantic import ValidationError

from rag_sidecar.contracts.config_change import (
    ConfigChangeRecord,
    ConfigGateCheck,
    ConfigGateLayer,
    WeeklyGatesSection,
)
from rag_sidecar.contracts.feedback_loop import WeeklyReport

H = "a" * 64
H2 = "b" * 64
RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567"


def _layer(layer: str, result: str = "pass", **extra: Any) -> dict[str, Any]:
    data: dict[str, Any] = {"layer": layer, "result": result, "checks": []}
    if result in ("skipped", "error"):
        data["reason"] = "live_layer_off" if result == "skipped" else "timeout"
    data.update(extra)
    return data


def _check(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "check_id": "chk-00000001",
        "status": "done",
        "stage": None,
        "started_at": "2026-01-05T06:00:00Z",
        "finished_at": "2026-01-05T06:04:00Z",
        "mode": "enforce",
        "cached": False,
        "rag_settings_hash": H,
        "changed_keys": ["RAG_SYSTEM_PROMPT", "RAG_RERANKER"],
        "result": "pass",
        "layers": [
            _layer(
                "deterministic",
                set_hash=H2,
                checks=[
                    {
                        "check": "false_answer_rate",
                        "slice": "language:en",
                        "measured": 0.0,
                        "numerator": 0,
                        "denominator": 10,
                        "limit": 0.05,
                        "limit_kind": "max",
                        "result": "passed",
                    }
                ],
            ),
            _layer("live", "skipped"),
            _layer("real_set", "skipped"),
        ],
        "not_evaluated_on_real_set": ["RAG_SYSTEM_PROMPT"],
        "not_evaluated": [{"key": "RAG_CONTEXT_COMPRESSION", "reason": "no_layer_exercised"}],
        "uncalibrated_cells": ["cohere|rerank-model-a|en|same"],
        "saved_as": None,
    }
    data.update(overrides)
    return data


def test_check_validates_with_the_three_layers_and_no_text():
    check = ConfigGateCheck.model_validate(_check())
    assert [layer.layer for layer in check.layers] == ["deterministic", "live", "real_set"]
    assert unconstrained_strings(ConfigGateCheck) == []


def test_check_needs_the_three_layers_in_order():
    layers = _check()["layers"]
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(layers=layers[:2]))
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(layers=[layers[1], layers[0], layers[2]]))
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(layers=[layers[0], layers[0], layers[2]]))


def test_done_needs_a_result_and_error_needs_a_reason():
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(result=None))
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(result="error"))
    ConfigGateCheck.model_validate(_check(result="error", error_reason="timeout"))
    ConfigGateCheck.model_validate(_check(status="running", stage="deterministic", result=None, finished_at=None))
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(result="skipped"))


def test_changed_keys_are_env_names():
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(changed_keys=["rag system prompt"]))


def test_layer_skip_and_error_need_a_reason():
    with pytest.raises(ValidationError):
        ConfigGateLayer.model_validate({"layer": "live", "result": "skipped", "checks": []})
    with pytest.raises(ValidationError):
        ConfigGateLayer.model_validate({"layer": "manual", "result": "pass", "checks": []})


def test_saved_as_values():
    for value in ("pass", "override", "warn", "skipped", "not_saved", None):
        ConfigGateCheck.model_validate(_check(saved_as=value))
    with pytest.raises(ValidationError):
        ConfigGateCheck.model_validate(_check(saved_as="forced"))


def _record(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "00000000-0000-4000-8000-000000000701",
        "created_at": "2026-01-05T06:05:00Z",
        "actor": "local-config-ui",
        "source": "config_ui",
        "changed_keys": ["RAG_RERANKER"],
        "before_hash": H,
        "after_hash": H2,
        "retrieval_config_hash": None,
        "gate_result": "pass",
        "gate_summary": {"checks": 12, "failed": 0, "skipped": 2, "offenders": []},
        "override_reason": None,
        "uncalibrated_cells": [],
    }
    data.update(overrides)
    return data


def test_record_holds_key_names_and_hashes_never_values():
    ConfigChangeRecord.model_validate(_record())
    assert unconstrained_strings(ConfigChangeRecord, allow=frozenset({"override_reason"})) == []
    for name in ("value", "before", "after", "values"):
        assert name not in ConfigChangeRecord.model_fields
        with pytest.raises(ValidationError):
            ConfigChangeRecord.model_validate(_record(**{name: "x"}))


@pytest.mark.parametrize("source", ["config_ui", "cli", "release_override", "local_prerelease", "profile_activation"])
def test_record_sources(source: str):
    extra: dict[str, Any] = {}
    if source == "release_override":
        extra["override_reason"] = "Emergency fix for a broken build"
    ConfigChangeRecord.model_validate(_record(source=source, **extra))


@pytest.mark.parametrize("gate_result", ["pass", "fail", "error", "skipped", "not_required"])
def test_record_gate_results(gate_result: str):
    ConfigChangeRecord.model_validate(_record(gate_result=gate_result))


def test_record_rejects_unknown_source_and_result():
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(source="vercel"))
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(gate_result="passed"))


def test_override_reason_is_capped():
    ConfigChangeRecord.model_validate(_record(gate_result="fail", override_reason="x" * 500))
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(gate_result="fail", override_reason="x" * 501))
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(gate_result="fail", override_reason="short"))


def test_release_override_needs_a_reason():
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(source="release_override"))


def test_release_sha_and_github_actor_only_on_release_records():
    summary = {"checks": 0, "failed": 0, "skipped": 0, "offenders": [], "release_sha": RELEASE_SHA, "github_actor": "repo-admin"}
    ConfigChangeRecord.model_validate(
        _record(source="release_override", gate_summary=summary, override_reason="Emergency fix for a broken build")
    )
    ConfigChangeRecord.model_validate(_record(source="local_prerelease", gate_summary=summary))
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(_record(gate_summary=summary))
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(
            _record(source="local_prerelease", gate_summary={**summary, "release_sha": "abc"})
        )
    with pytest.raises(ValidationError):
        ConfigChangeRecord.model_validate(
            _record(source="local_prerelease", gate_summary={**summary, "github_actor": "not a login"})
        )


def _section(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "overrides": [
            {
                "date": "2026-01-05",
                "actor": "local-config-ui",
                "changed_keys": ["RAG_RERANKER"],
                "before_hash": H,
                "after_hash": H2,
                "gate_result": "fail",
                "override_reason": "Owner accepted the change",
            }
        ],
        "change_counts": [{"source": "config_ui", "gate_result": "pass", "count": 3}],
        "release_overrides": [
            {"date": "2026-01-05", "sha": RELEASE_SHA, "github_actor": "repo-admin", "override_reason": "Emergency fix"}
        ],
        "open_alerts": {"refusal_rate": 1},
        "judge_cells": {"gating": 2, "report_only": 4, "uncalibrated": 0},
        "drift": [{"tenant_hash": "0123abcd", "week": "2026-W02", "divergence": 0.04, "state": "ok"}],
        "skipped_runs": {"no_real_set": 1},
        "overdue_re_reviews": 0,
    }
    data.update(overrides)
    return data


def test_weekly_gates_section_validates_with_numbers_ids_and_the_capped_reason():
    WeeklyGatesSection.model_validate(_section())
    assert unconstrained_strings(WeeklyGatesSection, allow=frozenset({"override_reason"})) == []
    for name in ("question", "answer", "query", "content"):
        with pytest.raises(ValidationError):
            WeeklyGatesSection.model_validate(_section(**{name: "x"}))
    long_reason = _section()["overrides"][0] | {"override_reason": "x" * 201}
    with pytest.raises(ValidationError):
        WeeklyGatesSection.model_validate(_section(overrides=[long_reason]))


def _weekly(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "generated_at": "2026-01-05T06:00:00Z",
        "since": "2025-12-29",
        "until": "2026-01-05",
        "stats_skipped_reason": "no_database",
    }
    data.update(overrides)
    return data


def test_weekly_report_without_gates_is_unchanged():
    report = WeeklyReport.model_validate(_weekly())
    assert report.gates is None
    assert "gates" not in report.model_dump(mode="json")


def test_weekly_report_carries_the_gates_section():
    report = WeeklyReport.model_validate(_weekly(gates=_section()))
    assert report.gates is not None
    assert report.model_dump(mode="json")["gates"]["open_alerts"] == {"refusal_rate": 1}
