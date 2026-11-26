"""Phase 5.3 D-22 to D-26, D-44: the monitor config, daily cell, alert and drift report contracts."""

from typing import Any

import pytest
from _contract_walk import FREE_TEXT_NAMES, unconstrained_strings
from pydantic import ValidationError

from rag_sidecar.contracts.monitor import (
    MonitorAlert,
    MonitorAlertsConfig,
    MonitorDailyCell,
    MonitorRule,
    DriftReport,
    default_monitor_alerts,
)

TENANT = "s:default"
SHA = "a" * 64


def _alert(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "00000000-0000-4000-8000-000000000501",
        "tenant_key": TENANT,
        "rule": "refusal_rate",
        "kind": "rate",
        "language": "en",
        "day": "2026-01-05",
        "window_days": 1,
        "severity": "alert",
        "status": "open",
        "observed": {"count": 19, "n": 50, "value": 0.38},
        "baseline": {"count": 24, "n": 200, "value": 0.12},
        "band": {
            "ratio": 2.0,
            "min_abs_delta": 0.05,
            "min_z": 3.0,
            "measured_ratio": 3.17,
            "measured_delta": 0.26,
            "measured_z": 4.36,
        },
        "breakdown": {"by_mode": {"strict": {"count": 19, "n": 50, "value": 0.38}}},
        "companions": [{"rule": "not_helpful_rate", "value": 0.04, "baseline": 0.04, "n": 50}],
        "sample_trace_ids": ["trace-0001", "trace-0002"],
        "config_changes": [
            {
                "record_id": "00000000-0000-4000-8000-000000000601",
                "at": "2026-01-04T10:00:00Z",
                "source": "config_ui",
                "changed_keys": ["RAG_RERANKER"],
                "before_hash": SHA,
                "after_hash": "b" * 64,
            }
        ],
        "suggestion": None,
        "delivered": {"webhook": {"state": "delivered", "attempts": 1, "last_attempt_at": "2026-01-05T06:00:00Z"}},
        "dedup_key": "s:default|en|refusal_rate",
        "created_at": "2026-01-05T06:00:00Z",
        "updated_at": "2026-01-05T06:00:00Z",
    }
    data.update(overrides)
    return data


def test_monitor_alert_from_the_ui_spec_fields_validates():
    alert = MonitorAlert.model_validate(_alert())
    assert alert.rule == "refusal_rate"
    assert alert.sample_trace_ids == ["trace-0001", "trace-0002"]


@pytest.mark.parametrize("name", FREE_TEXT_NAMES)
def test_monitor_alert_rejects_a_free_text_field(name: str):
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(**{name: "some words"}))


def test_monitor_alert_has_no_free_text_field():
    assert unconstrained_strings(MonitorAlert) == []
    assert unconstrained_strings(MonitorDailyCell) == []
    assert unconstrained_strings(DriftReport) == []
    assert unconstrained_strings(MonitorAlertsConfig) == []


def test_sample_trace_ids_are_capped_at_ten():
    MonitorAlert.model_validate(_alert(sample_trace_ids=[f"trace-{i:04d}" for i in range(10)]))
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(sample_trace_ids=[f"trace-{i:04d}" for i in range(11)]))


def test_trace_ids_are_ids_not_text():
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(sample_trace_ids=["a question with spaces"]))


@pytest.mark.parametrize(("field", "good", "bad"), [
    ("severity", ["warning", "alert"], "critical"),
    ("status", ["open", "acknowledged", "resolved"], "closed"),
    ("suggestion", ["recalibrate_refusal", "review_test_set", None], "rerun"),
])
def test_alert_enums(field: str, good: list[Any], bad: str):
    for value in good:
        MonitorAlert.model_validate(_alert(**{field: value}))
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(**{field: bad}))


def test_language_drop_alert_kind_and_rule_are_accepted():
    alert = MonitorAlert.model_validate(_alert(rule="language_drop", kind="language_drop"))
    assert alert.kind == "language_drop"
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(kind="sentiment"))
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(rule="made_up_rule"))


def test_config_change_entry_is_names_and_hashes():
    unrecorded = {"at": "2026-01-04", "source": "retrieval_log", "changed_keys": [], "after_hash": SHA, "unrecorded": True}
    MonitorAlert.model_validate(_alert(config_changes=[unrecorded]))
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(
            _alert(config_changes=[{**unrecorded, "changed_keys": ["not an env name"]}])
        )
    with pytest.raises(ValidationError):
        MonitorAlert.model_validate(_alert(config_changes=[{**unrecorded, "value": "secret"}]))


def _rate_rule(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "refusal_rate",
        "kind": "rate",
        "metric": "refusal_rate",
        "min_sample": 50,
        "baseline_min_sample": 200,
        "ratio": 2.0,
        "min_abs_delta": 0.05,
        "min_z": 3.0,
        "enabled": True,
    }
    data.update(overrides)
    return data


def _config(rules: list[dict[str, Any]]) -> dict[str, Any]:
    data = default_monitor_alerts().model_dump(mode="json")
    data["rules"] = rules
    data["config_hash"] = None
    return data


def test_config_rejects_duplicate_rule_ids():
    MonitorAlertsConfig.model_validate(_config([_rate_rule()]))
    with pytest.raises(ValidationError):
        MonitorAlertsConfig.model_validate(_config([_rate_rule(), _rate_rule()]))


@pytest.mark.parametrize("missing", ["ratio", "min_abs_delta", "min_z"])
def test_rate_rule_needs_its_three_conditions(missing: str):
    rule = _rate_rule()
    del rule[missing]
    with pytest.raises(ValidationError):
        MonitorRule.model_validate(rule)


def test_distribution_rule_alert_must_be_above_warn():
    rule = {
        "id": "top_score_psi",
        "kind": "distribution",
        "metric": "top_score",
        "min_sample": 300,
        "baseline_min_sample": 1000,
        "warn": 0.10,
        "alert": 0.25,
        "enabled": True,
    }
    MonitorRule.model_validate(rule)
    with pytest.raises(ValidationError):
        MonitorRule.model_validate({**rule, "alert": 0.10})
    with pytest.raises(ValidationError):
        MonitorRule.model_validate({**rule, "alert": 0.05})


def test_language_drop_rule_validates_without_rate_fields():
    rule = MonitorRule.model_validate(
        {
            "id": "language_drop",
            "kind": "language_drop",
            "enabled": True,
            "min_sample": 50,
            "params": {"min_drop": 0.1, "metrics": ["refusal_rate"], "label": "lang_cells"},
        }
    )
    assert rule.metric is None
    with pytest.raises(ValidationError):
        MonitorRule.model_validate({"id": "language_drop", "kind": "sentiment", "enabled": True, "min_sample": 50})


def test_rule_params_keys_are_codes():
    with pytest.raises(ValidationError):
        MonitorRule.model_validate(_rate_rule(params={"Not A Code": 1}))


def test_default_config_carries_the_d24_and_d44_numbers():
    config = default_monitor_alerts()
    rules = {rule.id: rule for rule in config.rules}
    assert list(rules) == [
        "refusal_rate",
        "zero_result_rate",
        "below_threshold_rate",
        "not_helpful_rate",
        "groundedness_flagged_rate",
        "kb_error_rate",
        "kb_degraded_rate",
        "kb_unavailable_rate",
        "top_score_psi",
        "latency_p95",
        "online_judge_mean",
        "test_set_not_representative",
        "offline_online_gap",
    ]
    assert "language_drop" not in rules
    for rule in config.rules:
        if rule.kind == "rate":
            assert (rule.ratio, rule.min_abs_delta, rule.min_z) == (2.0, 0.05, 3.0)
            assert (rule.min_sample, rule.baseline_min_sample) == (50, 200)
    psi = rules["top_score_psi"]
    assert (psi.warn, psi.alert, psi.min_sample, psi.baseline_min_sample) == (0.10, 0.25, 300, 1000)
    assert rules["latency_p95"].ratio == 1.5
    assert rules["online_judge_mean"].drop == 0.10
    assert (rules["test_set_not_representative"].warn, rules["test_set_not_representative"].alert) == (0.10, 0.20)
    assert rules["offline_online_gap"].alert == 0.15
    assert (config.drift.jsd_warn, config.drift.jsd_alert, config.drift.gap_alert) == (0.10, 0.20, 0.15)
    assert config.window_days == [1, 3, 7]
    assert config.baseline_days == 30
    assert config.sampling.weekly_cap == 30
    assert config.sampling.max_queries == 5000
    assert config.provenance.source == "defaults"


def test_drift_rule_bands_must_match_the_drift_block():
    data = default_monitor_alerts().model_dump(mode="json")
    data["drift"]["jsd_alert"] = 0.3
    with pytest.raises(ValidationError):
        MonitorAlertsConfig.model_validate(data)


def _cell(**overrides: Any) -> dict[str, Any]:
    hist = {"bins": [0] * 20, "underflow": 0, "overflow": 0}
    data: dict[str, Any] = {
        "tenant_key": TENANT,
        "day": "2026-01-05",
        "language": "en",
        "rag_mode": "strict",
        "channel": "chat",
        "doc_type": "general",
        "retrievals": 50,
        "refused": 19,
        "kb_unavailable": 0,
        "degraded": 0,
        "error": 0,
        "zero_result": 0,
        "below_threshold": 0,
        "helpful": 2,
        "not_helpful": 1,
        "judged": 0,
        "judge_score_sums": {},
        "groundedness_flagged": 0,
        "top_score_hist": {"similarity": hist},
        "latency_hist": {"bins": [0] * 18},
    }
    data.update(overrides)
    return data


def test_daily_cell_holds_counts_and_histograms_only():
    MonitorDailyCell.model_validate(_cell())
    MonitorDailyCell.model_validate(_cell(doc_type="unknown", language="und"))
    with pytest.raises(ValidationError):
        MonitorDailyCell.model_validate(_cell(refused=-1))
    with pytest.raises(ValidationError):
        MonitorDailyCell.model_validate(_cell(query="words"))


def test_daily_cell_histograms_have_fixed_bins():
    with pytest.raises(ValidationError):
        MonitorDailyCell.model_validate(
            _cell(top_score_hist={"similarity": {"bins": [0] * 10, "underflow": 0, "overflow": 0}})
        )
    with pytest.raises(ValidationError):
        MonitorDailyCell.model_validate(
            _cell(top_score_hist={"bm25": {"bins": [0] * 20, "underflow": 0, "overflow": 0}})
        )
    with pytest.raises(ValidationError):
        MonitorDailyCell.model_validate(_cell(latency_hist={"bins": [0] * 5}))


def test_drift_report_validates_and_keeps_cluster_ids_opaque():
    report = {
        "week": "2026-W02",
        "divergence": 0.12,
        "state": "warn",
        "null_p95": 0.067,
        "limits": {"warn": 0.10, "alert": 0.20, "gap": 0.15},
        "trend": [{"week": "2026-W01", "divergence": 0.05, "state": "ok"}],
        "clusters": [
            {"id": "c-01", "production_share": 0.2, "test_share": 0.05, "test_items": 3, "state": "under"},
            {"id": "novel", "production_share": 0.02, "test_share": 0.0, "test_items": 0, "state": "ok"},
        ],
    }
    DriftReport.model_validate(report)
    with pytest.raises(ValidationError):
        DriftReport.model_validate({**report, "state": "bad"})
    with pytest.raises(ValidationError):
        DriftReport.model_validate(
            {**report, "clusters": [{**report["clusters"][0], "id": "Named Cluster"}]}
        )
