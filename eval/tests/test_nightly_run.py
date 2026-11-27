import json
import subprocess
from pathlib import Path

import pytest

from rag_eval.nightly_run import NightlyOutcome, run_nightly_tier

GOLDEN = Path("eval/fixtures/golden.jsonl")


class FakeRunner:
    """Answers each nightly step by the module or script it runs; writes the files the real step would write."""

    def __init__(
        self,
        out_dir: Path,
        codes: dict[str, int] | None = None,
        absolute: dict | None = None,
        write_absolute: bool = True,
    ):
        self.out_dir = out_dir
        self.codes = codes or {}
        self.absolute = (
            absolute if absolute is not None else {"failed": [], "checks": []}
        )
        self.write_absolute = write_absolute
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self.kwargs: list[dict] = []

    @staticmethod
    def step(cmd: list[str]) -> str:
        joined = " ".join(cmd)
        if "run-nightly.mts" in joined or "run-smoke.mts" in joined:
            return "harness"
        if "rag_eval.runner" in joined:
            return "score"
        if "rag_eval.judge.run" in joined:
            return "judge"
        if "rag_eval.absolute_gate" in joined:
            return "absolute"
        raise AssertionError(f"unexpected command {cmd}")

    def __call__(self, cmd, **kwargs):
        assert isinstance(cmd, list), "commands are argument lists"
        assert kwargs.get("shell") in (None, False)
        self.calls.append(list(cmd))
        self.envs.append(dict(kwargs.get("env") or {}))
        self.kwargs.append(kwargs)
        name = self.step(cmd)
        code = self.codes.get(name, 0)
        if name == "harness" and code == 0:
            (self.out_dir / "traces.jsonl").write_text("", encoding="utf-8")
            (self.out_dir / "run.json").write_text(
                json.dumps({"effective_config_hash": "a" * 64}), encoding="utf-8"
            )
        if name == "score" and code == 0:
            (self.out_dir / "report.json").write_text(
                json.dumps({"items": [{}, {}, {}]}), encoding="utf-8"
            )
        if name == "judge" and code == 0:
            (self.out_dir / "judge.json").write_text("{}", encoding="utf-8")
        if name == "absolute" and self.write_absolute:
            (self.out_dir / "absolute.json").write_text(
                json.dumps(self.absolute), encoding="utf-8"
            )
        return subprocess.CompletedProcess(cmd, code, "", "")

    def steps(self) -> list[str]:
        return [self.step(cmd) for cmd in self.calls]


def _parts(outcome: NightlyOutcome) -> dict[str, tuple[str, str | None]]:
    return {part.part: (part.result, part.reason) for part in outcome.parts}


def _run(tmp_path: Path, runner: FakeRunner, **kwargs) -> NightlyOutcome:
    return run_nightly_tier(
        GOLDEN,
        tmp_path,
        runner=runner,
        env={"PATH": "/usr/bin"},
        fingerprint=lambda: "f" * 64,
        **kwargs,
    )


def test_all_steps_pass(tmp_path):
    runner = FakeRunner(tmp_path)
    outcome = _run(tmp_path, runner)
    assert _parts(outcome) == {
        "nightly_absolute": ("passed", None),
        "judge_floors": ("passed", None),
    }
    assert runner.steps() == ["harness", "score", "judge", "absolute"]
    assert outcome.report_paths["report"] == tmp_path / "report.json"
    assert outcome.report_paths["absolute"] == tmp_path / "absolute.json"
    assert outcome.counts["items"] == 3
    assert outcome.effective_config_hash == "a" * 64


def test_judge_step_and_absolute_gate_get_calibration_gates_and_fingerprint(tmp_path):
    runner = FakeRunner(tmp_path)
    _run(tmp_path, runner)
    judge = next(cmd for cmd in runner.calls if FakeRunner.step(cmd) == "judge")
    assert "--calibration" in judge and judge[
        judge.index("--calibration") + 1
    ].endswith("eval/config/judge-calibration.json")
    assert "--gates" in judge and judge[judge.index("--gates") + 1].endswith(
        "eval/config/quality-gates.json"
    )
    absolute = next(cmd for cmd in runner.calls if FakeRunner.step(cmd) == "absolute")
    assert absolute[absolute.index("--tier") + 1] == "nightly"
    assert absolute[absolute.index("--judge-fingerprint") + 1] == "f" * 64
    assert (
        "--mode" not in absolute or absolute[absolute.index("--mode") + 1] == "enforce"
    )
    harness = runner.calls[0]
    assert harness[harness.index("--generator") + 1] == "live"


def test_judge_keys_missing_skips_and_starts_no_later_step(tmp_path):
    runner = FakeRunner(tmp_path, codes={"judge": 3})
    outcome = _run(tmp_path, runner)
    parts = _parts(outcome)
    assert parts["judge_floors"] == ("skipped", "judge_keys_missing")
    assert parts["nightly_absolute"] == ("skipped", "judge_keys_missing")
    assert runner.steps() == ["harness", "score", "judge"]


def test_generator_key_missing_skips_before_any_paid_step(tmp_path):
    runner = FakeRunner(tmp_path, codes={"harness": 4})
    outcome = _run(tmp_path, runner)
    assert {result for result, _ in _parts(outcome).values()} == {"skipped"}
    assert runner.steps() == ["harness"]


def test_absolute_exit_11_names_the_failed_checks(tmp_path):
    absolute = {
        "failed": ["false_answer_rate_exceeded"],
        "checks": [{"check": "false_answer_rate", "result": "failed"}],
    }
    runner = FakeRunner(tmp_path, codes={"absolute": 11}, absolute=absolute)
    parts = _parts(_run(tmp_path, runner))
    assert parts["nightly_absolute"] == ("failed", "false_answer_rate_exceeded")
    assert parts["judge_floors"] == ("passed", None)


def test_floor_failure_fails_judge_floors_only(tmp_path):
    absolute = {
        "failed": ["floor_not_met"],
        "checks": [
            {
                "check": "floor_faithfulness",
                "result": "failed",
                "reason": "floor_not_met",
            }
        ],
    }
    runner = FakeRunner(tmp_path, codes={"absolute": 11}, absolute=absolute)
    parts = _parts(_run(tmp_path, runner))
    assert parts["judge_floors"] == ("failed", "floor_not_met")
    assert parts["nightly_absolute"] == ("passed", None)


def test_report_only_floor_cells_never_fail(tmp_path):
    absolute = {
        "failed": [],
        "checks": [
            {
                "check": "floor_faithfulness",
                "result": "report_only",
                "reason": "uncalibrated",
            }
        ],
    }
    runner = FakeRunner(tmp_path, absolute=absolute)
    assert _parts(_run(tmp_path, runner))["judge_floors"] == ("passed", None)


@pytest.mark.parametrize(
    ("failed", "reason"),
    [
        (["no_answer_share_below_min"], "composition"),
        (["required_no_answer_kind_missing"], "composition"),
        (["stale_share_exceeded"], "stale_share_exceeded"),
    ],
)
def test_absolute_exit_12(tmp_path, failed, reason):
    runner = FakeRunner(
        tmp_path, codes={"absolute": 12}, absolute={"failed": failed, "checks": []}
    )
    assert _parts(_run(tmp_path, runner))["nightly_absolute"] == ("failed", reason)


def test_absolute_exit_70_is_internal_error(tmp_path):
    runner = FakeRunner(tmp_path, codes={"absolute": 70})
    parts = _parts(_run(tmp_path, runner))
    assert parts["nightly_absolute"] == ("failed", "internal_error")


def test_missing_absolute_report_is_internal_error(tmp_path):
    runner = FakeRunner(tmp_path, write_absolute=False)
    parts = _parts(_run(tmp_path, runner))
    assert parts["nightly_absolute"] == ("failed", "internal_error")
    assert parts["judge_floors"] == ("failed", "internal_error")


def test_child_exception_never_raises(tmp_path):
    def broken(cmd, **kwargs):
        raise OSError("no such binary")

    outcome = run_nightly_tier(
        GOLDEN, tmp_path, runner=broken, env={}, fingerprint=lambda: None
    )
    assert {result for result, _ in _parts(outcome).values()} == {"failed"}


def test_env_is_the_callers_minus_excluded_names(tmp_path):
    runner = FakeRunner(tmp_path)
    run_nightly_tier(
        GOLDEN,
        tmp_path,
        runner=runner,
        env={
            "PATH": "/usr/bin",
            "GITHUB_TOKEN": "placeholder-token",
            "OPENAI_API_KEY": "placeholder",
        },
        exclude_env=["GITHUB_TOKEN"],
        fingerprint=lambda: None,
    )
    for env in runner.envs:
        assert "GITHUB_TOKEN" not in env
        assert env["OPENAI_API_KEY"] == "placeholder"


def test_base_url_runs_the_live_tier_against_the_app(tmp_path):
    runner = FakeRunner(tmp_path)
    # The live harness scores its own traces, so the fake writes report.json on the harness step.
    original = runner.__call__

    def with_report(cmd, **kwargs):
        result = original(cmd, **kwargs)
        if FakeRunner.step(cmd) == "harness":
            (tmp_path / "report.json").write_text(
                json.dumps({"items": [{}]}), encoding="utf-8"
            )
        return result

    outcome = run_nightly_tier(
        GOLDEN,
        tmp_path,
        base_url="https://app.example.test",
        runner=with_report,
        env={},
        fingerprint=lambda: None,
    )
    harness = runner.calls[0]
    assert "run-smoke.mts" in " ".join(harness)
    assert harness[harness.index("--base-url") + 1] == "https://app.example.test"
    assert "score" not in runner.steps()
    assert _parts(outcome)["nightly_absolute"] == ("passed", None)
