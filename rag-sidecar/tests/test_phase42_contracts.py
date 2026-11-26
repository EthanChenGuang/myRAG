import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from rag_sidecar.contracts import latency
from rag_sidecar.contracts import retrieval as contracts

REPO_ROOT = Path(__file__).resolve().parents[2]
_HASH = "a" * 64


def _metric_block() -> dict:
    return {
        "no_answer_count": 1,
        "answerable_count": 2,
        "false_refusal_rate": 0.0,
        "false_refusal_rate_upper_bound": 0.5,
        "correct_refusal_rate": 1.0,
    }


def _cell(**overrides) -> dict:
    payload = {
        "key": "local_bm25|bm25-v1|en|same",
        "provider": "local_bm25",
        "model": "bm25-v1",
        "query_language": "en",
        "pairing": "same",
        "threshold": None,
        "status": "uncalibrated",
        "tokenizer_version": 2,
        "rerank_text_version": 1,
        "config_hash": _HASH,
        "source": "fixture",
        "recorded_at": "2026-11-26",
        "holdout_evaluations": 0,
        "dev": _metric_block(),
        "holdout": _metric_block(),
    }
    payload.update(overrides)
    return payload


# --- contracts.RetrievalParams / contracts.RetrievalOverrides cap bounds (D-41)


def test_cap_minimum_is_25_and_cap_not_above_pool():
    assert contracts.RetrievalParams(rerank_input_cap=25, candidate_pool_size=25).rerank_input_cap == 25
    with pytest.raises(ValidationError):
        contracts.RetrievalParams(rerank_input_cap=24, candidate_pool_size=25)
    with pytest.raises(ValidationError):
        contracts.RetrievalParams(rerank_input_cap=75, candidate_pool_size=50)
    assert contracts.RetrievalParams(rerank_input_cap=75, candidate_pool_size=75).rerank_input_cap == 75


def test_override_cap_minimum_is_25():
    assert contracts.RetrievalOverrides(rerank_input_cap=25).rerank_input_cap == 25
    with pytest.raises(ValidationError):
        contracts.RetrievalOverrides(rerank_input_cap=24)


def test_mmr_lambda_is_omitted_when_unset_and_bounded():
    assert "mmr_lambda" not in contracts.RetrievalParams().model_dump(mode="json")
    assert contracts.RetrievalParams(mmr_lambda=0.7).model_dump(mode="json")["mmr_lambda"] == 0.7
    for bad in (-0.1, 1.1):
        with pytest.raises(ValidationError):
            contracts.RetrievalParams(mmr_lambda=bad)


# --- contracts.RetrievalFilters.versions (D-12)


def test_versions_filter_is_omitted_when_unset():
    assert "versions" not in contracts.RetrievalFilters().model_dump(mode="json")


@pytest.mark.parametrize(
    "value",
    ["current", "all", {"from": "2024-01-01"}, {"to": "2024-12-31"}, {"from": "2024-01-01", "to": "2024-12-31"}],
)
def test_versions_filter_accepts_closed_union(value):
    dumped = contracts.RetrievalFilters.model_validate({"versions": value}).model_dump(mode="json", by_alias=True)
    assert dumped["versions"] == value


@pytest.mark.parametrize(
    "value",
    [{"from": "2024-12-31", "to": "2024-01-01"}, {}, "latest", {"from": "2024-01-01", "extra": 1}, 3],
)
def test_versions_filter_rejects_invalid(value):
    with pytest.raises(ValidationError):
        contracts.RetrievalFilters.model_validate({"versions": value})


def test_version_range_round_trips_with_from_alias():
    payload = {"from": "2024-01-01", "to": "2024-06-30"}
    assert contracts.VersionRange.model_validate(payload).model_dump(mode="json", by_alias=True) == payload
    assert contracts.VersionRange.model_validate({"to": "2024-06-30"}).model_dump(mode="json", by_alias=True) == {
        "to": "2024-06-30"
    }


def test_current_only_stays_literal_true():
    with pytest.raises(ValidationError):
        contracts.RetrievalFilters(current_only=False)


# --- Override sections (D-16, D-21)


def test_overrides_omit_new_sections_when_unset():
    dumped = contracts.RetrievalOverrides().model_dump(mode="json")
    for key in ("table_lookup", "diversity", "dup_cluster"):
        assert key not in dumped


def test_overrides_carry_new_sections():
    dumped = contracts.RetrievalOverrides(
        table_lookup=contracts.TableLookupParams(),
        diversity=contracts.DiversityParams(),
        dup_cluster=contracts.DupClusterParams(),
    ).model_dump(mode="json")
    assert dumped["table_lookup"] == {"min_cells": 2, "limit": 10, "weight": 1.0}
    assert dumped["diversity"] == {"mmr_lambda": 0.7, "mmr_window_factor": 3}
    assert dumped["dup_cluster"] == {"threshold": 0.95, "by_profile": {}}


def test_table_lookup_params_defaults_and_bounds():
    params = contracts.TableLookupParams()
    assert (params.min_cells, params.limit, params.weight) == (2, 10, 1.0)
    for bad in ({"min_cells": 0}, {"limit": 0}, {"weight": 0}):
        with pytest.raises(ValidationError):
            contracts.TableLookupParams(**bad)


def test_diversity_params_defaults_and_bounds():
    params = contracts.DiversityParams()
    assert (params.mmr_lambda, params.mmr_window_factor) == (0.7, 3)
    with pytest.raises(ValidationError):
        contracts.DiversityParams(mmr_lambda=1.5)
    with pytest.raises(ValidationError):
        contracts.DiversityParams(mmr_window_factor=0)


def test_dup_cluster_params_per_profile_entry_records_source():
    params = contracts.DupClusterParams()
    assert params.threshold == 0.95 and params.by_profile == {}
    entry = contracts.DupClusterProfileEntry(threshold=0.93, source="fixture")
    params = contracts.DupClusterParams(by_profile={"profile-a": entry})
    assert params.model_dump(mode="json")["by_profile"]["profile-a"] == {"threshold": 0.93, "source": "fixture"}
    with pytest.raises(ValidationError):
        contracts.DupClusterProfileEntry(threshold=0.93, source="guess")
    with pytest.raises(ValidationError):
        contracts.DupClusterProfileEntry(threshold=1.2, source="live")


# --- Identifier contracts (D-29, T-04.2-02)


def test_identifier_pattern_bounds():
    assert contracts.IdentifierPattern(name="code", pattern=r"[A-Z]{2}-\d{4}", flags="u").flags == "u"
    assert contracts.IdentifierPattern(name="code", pattern=r"[a-z]{2}-\d{4}", flags="iu").flags == "iu"
    with pytest.raises(ValidationError):
        contracts.IdentifierPattern(name="n" * 81, pattern="x", flags="u")
    with pytest.raises(ValidationError):
        contracts.IdentifierPattern(name="code", pattern="x" * 201, flags="u")
    for flags in ("g", "i", "gu", "ium", ""):
        with pytest.raises(ValidationError):
            contracts.IdentifierPattern(name="code", pattern="x", flags=flags)


def test_identifier_index_entry_holds_raw_and_normalized():
    entry = contracts.IdentifierIndexEntry(raw="AB-0012", normalized="ab0012")
    assert entry.model_dump(mode="json") == {"raw": "AB-0012", "normalized": "ab0012"}


def test_table_row_shape():
    row = contracts.TableRow(
        table_key="t0",
        row_index=0,
        header=["Column A", "Column B"],
        cells=["alpha", "12"],
        cell_tokens=[["alpha"], ["12"]],
        chunk_ids=["chunk-1"],
    )
    assert row.model_dump(mode="json")["cell_tokens"] == [["alpha"], ["12"]]
    with pytest.raises(ValidationError):
        contracts.TableRow(table_key="t0", row_index=-1, header=[], cells=[], cell_tokens=[], chunk_ids=["c"])


# --- Refusal cells per mode (D-23, D-24, D-46)


def test_refusal_cell_without_mode_dumps_no_mode_and_keeps_null_threshold():
    dumped = contracts.RefusalCell.model_validate(_cell()).model_dump(mode="json")
    assert "mode" not in dumped
    assert "threshold" in dumped and dumped["threshold"] is None


def test_refusal_cell_mode_needs_mode_suffix_on_key():
    cell = contracts.RefusalCell.model_validate(_cell(mode="strict", key="local_bm25|bm25-v1|en|same|strict"))
    assert cell.model_dump(mode="json")["mode"] == "strict"
    with pytest.raises(ValidationError):
        contracts.RefusalCell.model_validate(_cell(mode="strict"))
    with pytest.raises(ValidationError):
        contracts.RefusalCell.model_validate(_cell(key="local_bm25|bm25-v1|en|same|strict"))
    with pytest.raises(ValidationError):
        contracts.RefusalCell.model_validate(_cell(mode="balanced", key="local_bm25|bm25-v1|en|same|strict"))


def test_refusal_thresholds_schema_version_follows_mode_cells():
    base = contracts.RefusalThresholds.model_validate({"cells": [_cell()]})
    assert base.model_dump(mode="json")["schema_version"] == 1
    mode_cell = _cell(mode="flexible", key="local_bm25|bm25-v1|en|same|flexible")
    with pytest.raises(ValidationError):
        contracts.RefusalThresholds.model_validate({"schema_version": 1, "cells": [_cell(), mode_cell]})
    with pytest.raises(ValidationError):
        contracts.RefusalThresholds.model_validate({"schema_version": 2, "cells": [_cell()]})
    both = contracts.RefusalThresholds.model_validate({"schema_version": 2, "cells": [_cell(), mode_cell]})
    assert both.schema_version == 2
    with pytest.raises(ValidationError):
        contracts.RefusalThresholds.model_validate({"schema_version": 2, "cells": [mode_cell, mode_cell]})


def test_refusal_calibration_targets_by_mode():
    assert "targets_by_mode" not in contracts.RefusalCalibrationConfig().model_dump(mode="json")
    config = contracts.RefusalCalibrationConfig(
        targets_by_mode={
            "strict": contracts.RefusalModeTargets(max_false_answer=0.05),
            "balanced": contracts.RefusalModeTargets(),
            "flexible": contracts.RefusalModeTargets(),
        }
    )
    dumped = config.model_dump(mode="json")["targets_by_mode"]
    assert dumped["strict"]["max_false_answer"] == 0.05
    assert dumped["balanced"]["max_false_answer"] is None
    with pytest.raises(ValidationError):
        contracts.RefusalModeTargets(max_false_answer=1.5)
    with pytest.raises(ValidationError):
        contracts.RefusalCalibrationConfig.model_validate({"targets_by_mode": {"bypass": {}}})


# --- Latency TTFT and pre-generation (D-25, D-26)


def _committed_latency() -> dict:
    return json.loads((REPO_ROOT / "eval/config/latency-budgets.json").read_text(encoding="utf-8"))


def test_committed_latency_budgets_validate_and_dump_without_new_sections():
    payload = _committed_latency()
    dumped = latency.LatencyBudgets.model_validate(payload).model_dump(mode="json")
    assert "ttft" not in dumped and "pre_generation" not in dumped


def test_latency_budgets_ttft_and_pre_generation():
    payload = _committed_latency()
    payload["ttft"] = {
        "chat": {"hit": {"p50_ms": 300, "p95_ms": 600}, "miss": {"p50_ms": 1200, "p95_ms": 2500}},
        "voice": {"bypass": {"p50_ms": 800, "p95_ms": 1500}},
    }
    payload["pre_generation"] = {"chat": {"p95_ms": 1500}, "voice": {"p95_ms": 700}}
    budgets = latency.LatencyBudgets.model_validate(payload)
    assert budgets.ttft is not None and budgets.ttft["chat"]["miss"].p95_ms == 2500
    assert budgets.pre_generation is not None and budgets.pre_generation["voice"].p95_ms == 700
    bad = dict(payload, ttft={"chat": {"hit": {"p50_ms": 900, "p95_ms": 600}}})
    with pytest.raises(ValidationError):
        latency.LatencyBudgets.model_validate(bad)
    bad = dict(payload, ttft={"chat": {"warm": {"p50_ms": 100, "p95_ms": 600}}})
    with pytest.raises(ValidationError):
        latency.LatencyBudgets.model_validate(bad)


# --- Committed configs stay byte-identical (D-46, T-04.2-03)


@pytest.mark.parametrize(
    ("rel", "model"),
    [
        ("eval/config/retrieval-params.json", contracts.RetrievalParams),
        ("eval/config/refusal-thresholds.json", contracts.RefusalThresholds),
        ("eval/config/refusal-calibration.json", contracts.RefusalCalibrationConfig),
    ],
)
def test_committed_configs_redump_identically(rel, model):
    raw = (REPO_ROOT / rel).read_text(encoding="utf-8")
    loaded = model.model_validate_json(raw)
    text = json.dumps(loaded.model_dump(mode="json"), sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    assert text == raw
    assert loaded.config_hash == contracts.compute_config_hash(loaded)
