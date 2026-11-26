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


def _record_commands(tmp_path, monkeypatch, extra_args: list[str]) -> list[list[str]]:
    commands: list[list[str]] = []

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
    assert main(["record", "--runs", "3", *extra_args, "--out", str(tmp_path / "b.json")]) == 0
    return commands


def test_cli_forwards_the_fixture_mode_to_every_run(tmp_path, monkeypatch):
    commands = _record_commands(tmp_path, monkeypatch, ["--fixture-mode", "ingest"])
    assert len(commands) == 3
    for command in commands:
        assert command[command.index("--fixture-mode") + 1] == "ingest"


def test_cli_without_a_fixture_mode_leaves_the_harness_default(tmp_path, monkeypatch):
    commands = _record_commands(tmp_path, monkeypatch, [])
    assert len(commands) == 3
    assert all("--fixture-mode" not in command for command in commands)


def test_cli_rejects_an_unknown_fixture_mode(tmp_path):
    with pytest.raises(SystemExit) as excinfo:
        main(["record", "--runs", "3", "--fixture-mode", "nope", "--out", str(tmp_path / "b.json")])
    assert excinfo.value.code == 2


def _item_dicts(rank: int | None = 2) -> list[dict]:
    base = {"language": "en", "category": "general", "refused": False, "provenance": "synthetic_fixture"}
    return [
        {**base, "item_id": "a1", "split": "dev", "answerable": True, "span_count": 4, "spans_hit_at_5": 2, "spans_hit_at_10": 2, "first_hit_rank": rank},
        {**base, "item_id": "u1", "split": "dev", "answerable": False, "refused": True, "span_count": 0, "spans_hit_at_5": 0, "spans_hit_at_10": 0, "first_hit_rank": None},
        {**base, "item_id": "t1", "split": "test", "answerable": True, "span_count": 1, "spans_hit_at_5": 0, "spans_hit_at_10": 0, "first_hit_rank": None},
    ]


def _report_with_items(run_id: str, rank: int | None = 2) -> EvalReport:
    return EvalReport.model_validate({**_report(run_id).model_dump(mode="json"), "items": _item_dicts(rank)})


def test_record_stores_per_item_rows_for_every_split_and_run():
    baseline = record_baseline([_report_with_items("a"), _report_with_items("b"), _report_with_items("c")])
    assert baseline.items is not None
    assert set(baseline.items) == {"a1", "u1", "t1"}
    assert baseline.items["a1"] == {
        "recall_at_5": [0.5, 0.5, 0.5],
        "recall_at_10": [0.5, 0.5, 0.5],
        "mrr": [0.5, 0.5, 0.5],
        "correct_refusal_rate": [None, None, None],
        "false_refusal_rate": [0.0, 0.0, 0.0],
    }
    assert baseline.items["u1"]["correct_refusal_rate"] == [1.0, 1.0, 1.0]
    assert baseline.items["t1"]["mrr"] == [0.0, 0.0, 0.0]


def test_record_keeps_per_run_values_in_recording_order_when_spread_is_allowed():
    reports = [_report_with_items("a", rank=1), _report_with_items("b", rank=2), _report_with_items("c", rank=4)]
    baseline = record_baseline(reports, allow_spread=True)
    assert baseline.items is not None
    assert baseline.items["a1"]["mrr"] == [1.0, 0.5, 0.25]


def test_runs_over_different_item_sets_are_non_deterministic():
    shorter = EvalReport.model_validate({**_report("c").model_dump(mode="json"), "items": _item_dicts()[:2]})
    with pytest.raises(NonDeterministicRunError, match="item set"):
        record_baseline([_report_with_items("a"), _report_with_items("b"), shorter])


def _production_report(run_id: str) -> EvalReport:
    return EvalReport.model_validate({**_report(run_id).model_dump(mode="json"), "gate_population": "production"})


def test_record_stores_the_gate_population_of_the_runs():
    baseline = record_baseline([_production_report("a"), _production_report("b"), _production_report("c")])
    assert baseline.gate_population == "production"
    assert record_baseline([_report("a"), _report("b"), _report("c")]).gate_population == "all"


def test_runs_with_different_gate_populations_are_non_deterministic():
    with pytest.raises(NonDeterministicRunError, match="gate_population"):
        record_baseline([_report("a"), _report("b"), _production_report("c")])


def test_reports_without_items_record_no_item_rows():
    assert record_baseline([_report("a"), _report("b"), _report("c")]).items is None


def _write_reports(tmp_path, reports: list[EvalReport]) -> list[str]:
    paths = []
    for index, report in enumerate(reports, start=1):
        path = tmp_path / f"run-{index}" / "report.json"
        path.parent.mkdir(parents=True)
        path.write_text(report.model_dump_json(), encoding="utf-8")
        paths.append(str(path))
    return paths


def test_record_reports_writes_a_baseline_from_three_finished_reports(tmp_path):
    paths = _write_reports(tmp_path, [_report("run-a"), _report("run-b"), _report("run-c")])
    out = tmp_path / "domain-baseline.json"
    argv = ["record-reports", "--out", str(out)]
    for path in paths:
        argv += ["--report", path]
    assert main(argv) == 0
    recorded = Baseline.model_validate_json(out.read_text(encoding="utf-8"))
    assert recorded.golden_sha256 == "g" * 64
    assert len(recorded.runs) == 3
    assert [run.run_id for run in recorded.runs] == ["run-a", "run-b", "run-c"]
    assert all(stat.spread == 0 for stats in recorded.slices.values() for stat in stats.values())


def test_record_reports_refuses_fewer_than_three_or_differing_runs(tmp_path, capsys):
    two = _write_reports(tmp_path / "two", [_report("run-a"), _report("run-b")])
    assert main(["record-reports", "--out", str(tmp_path / "a.json"), "--report", two[0], "--report", two[1]]) == 2
    differing = _write_reports(tmp_path / "diff", [_report("run-a"), _report("run-b"), _report("run-c", recall_at_10=0.9)])
    argv = ["record-reports", "--out", str(tmp_path / "b.json")]
    for path in differing:
        argv += ["--report", path]
    assert main(argv) == 1
    assert not (tmp_path / "b.json").exists()
    assert "non-deterministic" in capsys.readouterr().err
