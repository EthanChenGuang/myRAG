"""Shared nightly runner (Phase 5.3 D-33, D-19): harness, score, judge tier and absolute gate on one golden set.

Each child failure becomes a ReleaseGatePart; skipped (keys missing) is kept apart from passed and never folded into it.
"""

import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from rag_sidecar.contracts.release_gate import ReleaseGatePart

from rag_eval.paths import REPO_ROOT

JUDGE_CALIBRATION = REPO_ROOT / "eval" / "config" / "judge-calibration.json"
QUALITY_GATES = REPO_ROOT / "eval" / "config" / "quality-gates.json"
NIGHTLY_HARNESS = REPO_ROOT / "eval" / "harness" / "run-nightly.mts"
LIVE_HARNESS = REPO_ROOT / "eval" / "harness" / "run-smoke.mts"

EXIT_JUDGE_KEY = 3
EXIT_GENERATOR_KEY = 4
EXIT_ABSOLUTE = 11
EXIT_COMPOSITION = 12

JUDGE_KEYS_MISSING = "judge_keys_missing"
INTERNAL_ERROR = "internal_error"
HARNESS_FAILED = "harness_failed"
JUDGE_FAILED = "judge_failed"
FLOOR_NOT_MET = "floor_not_met"
COMPOSITION = "composition"
STALE_SHARE_EXCEEDED = "stale_share_exceeded"
COMPOSITION_FAILURES = frozenset(
    {"no_answer_share_below_min", "required_no_answer_kind_missing"}
)
NIGHTLY_ROLE = "nightly"

Runner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class NightlyOutcome:
    parts: tuple[ReleaseGatePart, ...]
    report_paths: dict[str, Path] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    failed_checks: tuple[str, ...] = ()
    effective_config_hash: str | None = None

    def part(self, name: str) -> ReleaseGatePart:
        return next(part for part in self.parts if part.part == name)


def _part(name: str, result: str, reason: str | None = None) -> ReleaseGatePart:
    return ReleaseGatePart(part=name, result=result, reason=reason)


def _both(result: str, reason: str) -> tuple[ReleaseGatePart, ...]:
    return (
        _part("nightly_absolute", result, reason),
        _part("judge_floors", result, reason),
    )


def running_fingerprint() -> str | None:
    """Fingerprint of the running nightly judge, so gating calibration cells bind (D-09); None when it cannot be built."""
    try:
        from rag_eval.judge.config import load_judge_config
        from rag_eval.judge_calibration import judge_fingerprint

        return judge_fingerprint(NIGHTLY_ROLE, load_judge_config())
    except Exception:  # noqa: BLE001 - without a fingerprint every floor is report-only, never passed silently
        return None


def _child_env(env: Mapping[str, str] | None, exclude: Iterable[str]) -> dict[str, str]:
    base = dict(os.environ if env is None else env)
    for name in exclude:
        base.pop(name, None)
    return base


def _join(codes: Iterable[str]) -> str:
    seen: list[str] = []
    for code in codes:
        if code not in seen:
            seen.append(code)
    return "__".join(seen)


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _effective_hash(run_json: Path) -> str | None:
    data = _read_json(run_json)
    value = data.get("effective_config_hash") if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def _item_count(report_json: Path) -> int | None:
    data = _read_json(report_json)
    items = data.get("items") if isinstance(data, dict) else None
    return len(items) if isinstance(items, list) else None


def _absolute_parts(
    code: int, absolute_json: Path
) -> tuple[tuple[ReleaseGatePart, ...], tuple[str, ...]]:
    data = _read_json(absolute_json)
    if code not in (0, EXIT_ABSOLUTE, EXIT_COMPOSITION) or not isinstance(data, dict):
        return _both("failed", INTERNAL_ERROR), (INTERNAL_ERROR,)
    failed = [
        str(entry) for entry in data.get("failed") or [] if isinstance(entry, str)
    ]
    checks = [row for row in data.get("checks") or [] if isinstance(row, dict)]
    floor_failed = any(
        str(row.get("check", "")).startswith("floor_") and row.get("result") == "failed"
        for row in checks
    )
    absolute_codes: list[str] = []
    for entry in failed:
        if entry == FLOOR_NOT_MET:
            floor_failed = True
        elif entry in COMPOSITION_FAILURES:
            absolute_codes.append(COMPOSITION)
        else:
            absolute_codes.append(entry)
    if code != 0 and not absolute_codes and not floor_failed:
        return _both("failed", INTERNAL_ERROR), (INTERNAL_ERROR,)
    absolute = (
        _part("nightly_absolute", "failed", _join(absolute_codes))
        if absolute_codes
        else _part("nightly_absolute", "passed")
    )
    floors = (
        _part("judge_floors", "failed", FLOOR_NOT_MET)
        if floor_failed
        else _part("judge_floors", "passed")
    )
    names = tuple(
        dict.fromkeys([*absolute_codes, *([FLOOR_NOT_MET] if floor_failed else [])])
    )
    return (absolute, floors), names


def run_nightly_tier(
    golden: Path | str,
    out_dir: Path | str,
    *,
    generator: str = "live",
    base_url: str | None = None,
    runner: Runner = subprocess.run,
    env: Mapping[str, str] | None = None,
    exclude_env: Iterable[str] = (),
    fingerprint: Callable[[], str | None] = running_fingerprint,
    python: str = sys.executable,
) -> NightlyOutcome:
    """Runs the nightly tier on one golden set; never raises on a child failure (D-33)."""
    golden_path = Path(golden).resolve()
    out = Path(out_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    child_env = _child_env(env, exclude_env)
    paths = {
        "traces": out / "traces.jsonl",
        "run": out / "run.json",
        "report": out / "report.json",
        "judge": out / "judge.json",
        "absolute": out / "absolute.json",
    }

    def call(cmd: list[str]) -> int:
        try:
            completed = runner(cmd, cwd=str(REPO_ROOT), env=child_env, check=False)
        except Exception:  # noqa: BLE001 - a child that cannot start is a failed step, not a crash
            return -1
        return int(completed.returncode)

    def finish(
        parts: tuple[ReleaseGatePart, ...], failed: tuple[str, ...] = ()
    ) -> NightlyOutcome:
        counts: dict[str, int] = {}
        items = _item_count(paths["report"])
        if items is not None:
            counts["items"] = items
        counts["failed_checks"] = len(failed)
        present = {name: path for name, path in paths.items() if path.exists()}
        return NightlyOutcome(
            parts=parts,
            report_paths=present,
            counts=counts,
            failed_checks=failed,
            effective_config_hash=_effective_hash(paths["run"]),
        )

    if base_url:
        harness = [
            "npx",
            "tsx",
            str(LIVE_HARNESS),
            "--base-url",
            base_url,
            "--golden",
            str(golden_path),
            "--out",
            str(out),
            "--no-gate",
        ]
    else:
        harness = [
            "npx",
            "tsx",
            str(NIGHTLY_HARNESS),
            "--generator",
            generator,
            "--golden",
            str(golden_path),
            "--out",
            str(out),
        ]
    code = call(harness)
    if code == EXIT_GENERATOR_KEY:
        return finish(_both("skipped", JUDGE_KEYS_MISSING))
    if code != 0:
        return finish(_both("failed", HARNESS_FAILED), (HARNESS_FAILED,))

    if not base_url:
        score = [
            python, "-m", "rag_eval.runner", "score",
            "--traces", str(paths["traces"]), "--golden", str(golden_path), "--manifest", str(paths["run"]), "--out", str(out),
        ]  # fmt: skip
        if call(score) != 0:
            return finish(_both("failed", INTERNAL_ERROR), (INTERNAL_ERROR,))
    if not paths["report"].exists():
        return finish(_both("failed", INTERNAL_ERROR), (INTERNAL_ERROR,))

    judge = [
        python, "-m", "rag_eval.judge.run",
        "--traces", str(paths["traces"]), "--golden", str(golden_path), "--manifest", str(paths["run"]), "--out", str(out),
        "--calibration", str(JUDGE_CALIBRATION), "--gates", str(QUALITY_GATES),
    ]  # fmt: skip
    judge_code = call(judge)
    if judge_code == EXIT_JUDGE_KEY:
        return finish(_both("skipped", JUDGE_KEYS_MISSING))

    absolute = [
        python, "-m", "rag_eval.absolute_gate", "check",
        "--report", str(paths["report"]), "--gates", str(QUALITY_GATES), "--tier", "nightly",
        "--calibration", str(JUDGE_CALIBRATION), "--mode", "enforce", "--out", str(out),
    ]  # fmt: skip
    if judge_code == 0 and paths["judge"].exists():
        absolute += ["--judge-report", str(paths["judge"])]
    running = fingerprint()
    if running:
        absolute += ["--judge-fingerprint", running]
    paths["absolute"].unlink(missing_ok=True)
    parts, failed = _absolute_parts(call(absolute), paths["absolute"])
    if judge_code != 0:
        parts = (parts[0], _part("judge_floors", "failed", JUDGE_FAILED))
        failed = tuple(dict.fromkeys([*failed, JUDGE_FAILED]))
    return finish(parts, failed)
