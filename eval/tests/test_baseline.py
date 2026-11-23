import json
import statistics

import pytest
from rag_sidecar.contracts.baseline import Baseline
from rag_sidecar.contracts.report import EvalReport

from rag_eval import baseline as baseline_module
from rag_eval.baseline import NonDeterministicRunError, main, record_baseline, write_baseline

METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")


def _slice(value: float | None = 0.5, **overrides: float | None) -> dict:
    values: dict[str, float | None] = {metric: value for metric in METRICS}
    values.update(overrides)
    return {metric: {"value": v, "n": 12} for metric, v in values.items()}


def _report(run_id: str = "run-a", config_hash: str = "r" * 64, **overall: float | None) -> EvalReport:
    return EvalReport.model_validate(
        {
            "run_id": run_id,
            "tier": "smoke",
            "run_config_hash": config_hash,
            "corpus_sha256": "c" * 64,
            "golden_sha256": "g" * 64,
            "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
            "embedder_id": "fixture-embedder",
            "embedder_version": 3,
            "deployment_mode": "single-tenant",
            "request_options": {},
            "k_values": [5, 10],
            "overall": _slice(0.5, **overall),
            "by_language": {"en": _slice(0.4), "zh": _slice(0.7)},
            "by_category": {"general": _slice(0.5)},
            "by_language_category": {},
            "by_split": {},
            "items": [],
        }
    )


def test_three_identical_reports_record_zero_spread_and_the_run_value():
    baseline = record_baseline([_report("a"), _report("b"), _report("c")], git_shas=["s1", "s2", "s3"])
    Baseline.model_validate(baseline.model_dump(mode="json"))
    assert baseline.spread_kind == "stdev_ddof1"
    assert [run.run_id for run in baseline.runs] == ["a", "b", "c"]
    assert [run.git_sha for run in baseline.runs] == ["s1", "s2", "s3"]
    assert {run.run_config_hash for run in baseline.runs} == {"r" * 64}
    assert set(baseline.slices) == {"overall", "language:en", "language:zh", "category:general"}
    for slice_stats in baseline.slices.values():
        assert set(slice_stats) == set(METRICS)
        for stat in slice_stats.values():
            assert stat.spread == 0
            assert stat.runs == [stat.mean] * 3
    assert baseline.slices["language:zh"]["mrr"].mean == 0.7
    assert baseline.slices["overall"]["mrr"].n == 12


def test_fewer_than_three_runs_is_rejected():
    with pytest.raises(ValueError, match="at least 3"):
        record_baseline([_report("a"), _report("b")])


def test_differing_run_config_hash_names_the_field():
    reports = [_report("a"), _report("b"), _report("c", config_hash="z" * 64)]
    with pytest.raises(NonDeterministicRunError, match="run_config_hash"):
        record_baseline(reports)
    with pytest.raises(NonDeterministicRunError, match="run_config_hash"):
        record_baseline(reports, allow_spread=True)


def test_differing_metric_names_the_field_unless_allow_spread():
    reports = [_report("a", mrr=0.5), _report("b", mrr=0.52), _report("c", mrr=0.55)]
    with pytest.raises(NonDeterministicRunError, match="overall mrr"):
        record_baseline(reports)
    baseline = record_baseline(reports, allow_spread=True)
    stat = baseline.slices["overall"]["mrr"]
    assert stat.runs == [0.5, 0.52, 0.55]
    assert stat.mean == pytest.approx(statistics.mean([0.5, 0.52, 0.55]))
    assert stat.spread == pytest.approx(statistics.stdev([0.5, 0.52, 0.55]))


def test_write_baseline_is_sorted_and_atomic(tmp_path):
    baseline = record_baseline([_report("a"), _report("b"), _report("c")])
    target = tmp_path / "nested" / "baseline.json"
    write_baseline(baseline, target)
    text = target.read_text(encoding="utf-8")
    assert '"spread_kind": "stdev_ddof1"' in text
    data = json.loads(text)
    assert list(data) == sorted(data)
    assert not list(target.parent.glob("*.tmp"))
    Baseline.model_validate_json(text)


def test_cli_rejects_fewer_than_three_runs_and_live_baseline_outside_private(tmp_path, capsys):
    assert main(["record", "--runs", "2", "--out", str(tmp_path / "b.json")]) == 2
    assert main(["record", "--runs", "3", "--base-url", "http://localhost:1", "--out", str(tmp_path / "b.json")]) == 2
    assert "eval/golden/private" in capsys.readouterr().err


def test_cli_exits_1_on_non_deterministic_runs_without_writing(tmp_path, monkeypatch, capsys):
    reports = iter([_report("a", mrr=0.5), _report("b", mrr=0.6), _report("c", mrr=0.7)])
    run_dirs = []

    class _Done:
        returncode = 0
        stdout = "deadbeef\n"

    def fake_run(command, **_kwargs):
        if command[0] == "git":
            return _Done()
        run_dirs.append(command[command.index("--out") + 1])
        report = next(reports)
        out = baseline_module.resolve_cli_path(run_dirs[-1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
        return _Done()

    monkeypatch.setattr(baseline_module.subprocess, "run", fake_run)
    target = tmp_path / "baseline.json"
    assert main(["record", "--runs", "3", "--out", str(target)]) == 1
    assert not target.exists()
    assert "overall mrr" in capsys.readouterr().err
    assert run_dirs == [f"eval/out/baseline/run-{i}" for i in (1, 2, 3)]


def test_baseline_carries_run_identity_and_refuses_mixed_deployments():
    baseline = record_baseline([_report("a"), _report("b"), _report("c")])
    assert (baseline.tier, baseline.deployment_mode) == ("smoke", "single-tenant")
    assert baseline.request_options.organization_id is None
    other = _report("c").model_copy(update={"deployment_mode": "multi-tenant"})
    with pytest.raises(NonDeterministicRunError, match="deployment_mode"):
        record_baseline([_report("a"), _report("b"), other])


def test_cli_forwards_org_and_user_to_every_run(tmp_path, monkeypatch):
    commands = []

    class _Done:
        returncode = 0
        stdout = "deadbeef\n"

    def fake_run(command, **_kwargs):
        if command[0] == "git":
            return _Done()
        commands.append(command)
        out = baseline_module.resolve_cli_path(command[command.index("--out") + 1])
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(_report(f"run-{len(commands)}").model_dump_json(), encoding="utf-8")
        return _Done()

    monkeypatch.setattr(baseline_module.subprocess, "run", fake_run)
    org = "11111111-1111-4111-8111-111111111111"
    user = "33333333-3333-4333-8333-333333333333"
    assert main(["record", "--runs", "3", "--org", org, "--user", user, "--out", str(tmp_path / "b.json")]) == 0
    assert len(commands) == 3
    for command in commands:
        assert command[command.index("--org") + 1] == org
        assert command[command.index("--user") + 1] == user
