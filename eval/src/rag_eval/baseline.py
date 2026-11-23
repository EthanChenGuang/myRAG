import argparse
import json
import os
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import Baseline, BaselineMetricStat
from rag_sidecar.contracts.report import EvalReport, SliceMetrics

from rag_eval.paths import REPO_ROOT, resolve_cli_path

METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
MIN_RUNS = 3
RUNS_DIR = Path("eval/out/baseline")
LIVE_DIR = Path("eval/golden/private")


class NonDeterministicRunError(Exception):
    pass


def _slices(report: EvalReport) -> dict[str, SliceMetrics]:
    slices: dict[str, SliceMetrics] = {"overall": report.overall}
    for language, metrics in report.by_language.items():
        slices[f"language:{language}"] = metrics
    for category, metrics in report.by_category.items():
        slices[f"category:{category}"] = metrics
    return slices


def _require_same(field: str, values: list[object]) -> None:
    if any(value != values[0] for value in values[1:]):
        raise NonDeterministicRunError(f"{field} differs between runs: {values!r}")


def _stat(values: list[float | None], n: int) -> BaselineMetricStat:
    present = [value for value in values if value is not None]
    if not present:
        return BaselineMetricStat(mean=None, spread=0.0, runs=values, n=n)
    if all(value == present[0] for value in present):
        mean, spread = present[0], 0.0
    else:
        mean = statistics.mean(present)
        spread = statistics.stdev(present) if len(present) > 1 else 0.0
    return BaselineMetricStat(mean=mean, spread=spread, runs=values, n=n)


def record_baseline(
    reports: list[EvalReport],
    allow_spread: bool = False,
    git_shas: list[str | None] | None = None,
    created_at: list[str] | None = None,
) -> Baseline:
    if len(reports) < MIN_RUNS:
        raise ValueError(f"a baseline needs at least {MIN_RUNS} runs, got {len(reports)}")
    shas = git_shas if git_shas is not None else [None] * len(reports)
    stamps = created_at if created_at is not None else [datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")] * len(reports)
    if len(shas) != len(reports) or len(stamps) != len(reports):
        raise ValueError("git_shas and created_at must have one entry per run")

    _require_same("run_config_hash", [report.run_config_hash for report in reports])
    _require_same("golden_sha256", [report.golden_sha256 for report in reports])
    _require_same("golden_filter", [report.golden_filter for report in reports])
    _require_same("corpus_sha256", [report.corpus_sha256 for report in reports])
    _require_same("embedder_id", [report.embedder_id for report in reports])
    _require_same("embedder_version", [report.embedder_version for report in reports])
    _require_same("embedder_source_sha256", [report.embedder_source_sha256 for report in reports])
    _require_same("tier", [report.tier for report in reports])
    _require_same("deployment_mode", [report.deployment_mode for report in reports])
    _require_same("request_options", [report.request_options for report in reports])

    per_run = [_slices(report) for report in reports]
    _require_same("slice set", [sorted(slices) for slices in per_run])

    slices: dict[str, dict[str, BaselineMetricStat]] = {}
    for name in sorted(per_run[0]):
        slices[name] = {}
        for metric in METRICS:
            cells = [getattr(run[name], metric) for run in per_run]
            values = [cell.value for cell in cells]
            if not allow_spread and any(value != values[0] for value in values[1:]):
                raise NonDeterministicRunError(f"{name} {metric} differs between runs: {values!r}")
            slices[name][metric] = _stat(values, cells[0].n)

    first = reports[0]
    return Baseline(
        spread_kind="stdev_ddof1",
        tier=first.tier,
        deployment_mode=first.deployment_mode,
        request_options=first.request_options,
        corpus_sha256=first.corpus_sha256,
        golden_sha256=first.golden_sha256,
        golden_filter=first.golden_filter,
        embedder_id=first.embedder_id,
        embedder_version=first.embedder_version,
        embedder_source_sha256=first.embedder_source_sha256,
        run_config_hash=first.run_config_hash,
        runs=[
            {"run_id": report.run_id, "run_config_hash": report.run_config_hash, "git_sha": sha, "created_at": stamp}
            for report, sha, stamp in zip(reports, shas, stamps)
        ],
        slices=slices,
    )


def write_baseline(baseline: Baseline, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(baseline.model_dump(mode="json"), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _git_head() -> str | None:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    return result.stdout.strip() or None if result.returncode == 0 else None


def _is_under(path: Path, directory: Path) -> bool:
    try:
        path.resolve().relative_to(resolve_cli_path(directory).resolve())
        return True
    except ValueError:
        return False


def _record(args: argparse.Namespace) -> int:
    if args.runs < MIN_RUNS:
        print(f"error: --runs must be at least {MIN_RUNS}", file=sys.stderr)
        return 2
    out = resolve_cli_path(args.out)
    if args.base_url and not _is_under(out, LIVE_DIR):
        print(f"error: a live baseline must be written under {LIVE_DIR}/ (it is not tracked)", file=sys.stderr)
        return 2

    reports: list[EvalReport] = []
    shas: list[str | None] = []
    stamps: list[str] = []
    for index in range(1, args.runs + 1):
        run_dir = RUNS_DIR / f"run-{index}"
        command = ["npx", "tsx", "eval/harness/run-smoke.mts", "--no-gate", "--out", str(run_dir)]
        for flag, value in (("--golden", args.golden), ("--corpus", args.corpus), ("--base-url", args.base_url)):
            if value:
                command.extend([flag, str(value)])
        if args.include_drafts:
            command.append("--include-drafts")
        print(f"[Eval Baseline] run {index}/{args.runs}: {' '.join(command)}")
        result = subprocess.run(command, cwd=REPO_ROOT, check=False, env=os.environ.copy())
        if result.returncode != 0:
            print(f"error: run {index} exited with code {result.returncode}", file=sys.stderr)
            return 3
        try:
            reports.append(EvalReport.model_validate_json((resolve_cli_path(run_dir) / "report.json").read_text(encoding="utf-8")))
        except (OSError, ValidationError, ValueError) as exc:
            print(f"error: run {index} report is unreadable: {exc}", file=sys.stderr)
            return 3
        shas.append(_git_head())
        stamps.append(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    try:
        baseline = record_baseline(reports, allow_spread=args.allow_spread, git_shas=shas, created_at=stamps)
    except NonDeterministicRunError as exc:
        print(f"error: non-deterministic runs, baseline not written: {exc}", file=sys.stderr)
        return 1
    write_baseline(baseline, out)
    print(f"[Eval Baseline] wrote {out} (run_config_hash {baseline.run_config_hash[:12]}, {len(baseline.runs)} runs)")
    for name in sorted(baseline.slices):
        stats = baseline.slices[name]
        cells = " ".join(
            f"{metric}={'n/a' if stats[metric].mean is None else format(stats[metric].mean, '.3f')}+-{stats[metric].spread:.3f}"
            for metric in METRICS
        )
        print(f"  {name}: {cells}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.baseline", description="myRAG eval baseline recorder")
    commands = parser.add_subparsers(dest="command", required=True)
    record = commands.add_parser("record", help="run the smoke harness in separate processes and record a baseline")
    record.add_argument("--runs", type=int, default=3)
    record.add_argument("--out", required=True, type=Path)
    record.add_argument("--golden")
    record.add_argument("--corpus")
    record.add_argument("--base-url")
    record.add_argument("--allow-spread", action="store_true")
    record.add_argument("--include-drafts", action="store_true", help="also score review_status=draft items")
    record.set_defaults(handler=_record)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
