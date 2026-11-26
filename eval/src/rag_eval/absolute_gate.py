"""Absolute quality gate (Phase 5.3 D-05 to D-09, D-30, D-49): fixed ceilings, floors, set composition and stale share
decided from one report, with no baseline. A check that did not run or had too few items is never reported as passed."""

import argparse
import importlib
import json
import sys
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import ValidationError
from rag_sidecar.contracts.golden import UNANSWERABLE_CATEGORIES
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.quality_gates import (
    AbsoluteGateResult,
    CompositionLanguageResult,
    CompositionResult,
    GateCheckRow,
    QualityGates,
)
from rag_sidecar.contracts.report import EvalReport, ItemResult, MetricValue, SliceMetrics

from rag_eval.gate import EXIT_INTERNAL, EXIT_MISMATCH, _read, _report_slices, _write_text
from rag_eval.judge.run import LIBRARIES
from rag_eval.metrics import report_gate_items
from rag_eval.paths import resolve_cli_path

EXIT_PASS = 0
EXIT_ABSOLUTE = 11
EXIT_COMPOSITION = 12

Tier = Literal["smoke", "nightly"]
Mode = Literal["enforce", "report"]

CEILING_METRICS = ("false_answer_rate", "false_refusal_rate")
CEILING_SLICE_PREFIXES = ("overall", "language:")
JUDGE_ROLE = "nightly"

FAILED_CODES = {
    "false_answer_rate": "false_answer_rate_exceeded",
    "false_refusal_rate": "false_refusal_rate_exceeded",
}
NO_ANSWER_SHARE_BELOW_MIN = "no_answer_share_below_min"
REQUIRED_KIND_MISSING = "required_no_answer_kind_missing"
STALE_SHARE_EXCEEDED = "stale_share_exceeded"
FLOOR_NOT_MET = "floor_not_met"
COMPOSITION_CODES = frozenset({NO_ANSWER_SHARE_BELOW_MIN, REQUIRED_KIND_MISSING, STALE_SHARE_EXCEEDED})


def _ceiling_metric(metrics: SliceMetrics, metric: str) -> MetricValue:
    if metric == "false_answer_rate" and metrics.false_answer_rate is None:
        correct = metrics.correct_refusal_rate
        return MetricValue(value=None if correct.value is None else 1 - correct.value, n=correct.n)
    value = getattr(metrics, metric)
    return value if value is not None else MetricValue(value=None, n=0)


def _ceiling_rows(report: EvalReport, gates: QualityGates) -> list[GateCheckRow]:
    rows: list[GateCheckRow] = []
    slices = {
        name: metrics
        for name, metrics in _report_slices(report).items()
        if name == "overall" or name.startswith(CEILING_SLICE_PREFIXES[1])
    }
    for metric in CEILING_METRICS:
        limit = getattr(gates.ceilings, metric).get(report.rag_mode)
        for name in sorted(slices, key=lambda key: (key != "overall", key)):
            observed = _ceiling_metric(slices[name], metric)
            numerator = None if observed.value is None else round(observed.value * observed.n)
            measured = numerator / observed.n if numerator is not None and observed.n else observed.value
            base = {
                "check": metric,
                "slice": name,
                "measured": measured,
                "numerator": numerator,
                "denominator": observed.n,
                "limit": limit,
                "limit_kind": "max",
            }
            if limit is None:
                rows.append(GateCheckRow(**base, result="report_only", reason="ceiling_not_set"))
            elif observed.value is None or observed.n == 0:
                rows.append(GateCheckRow(**base, result="skipped", reason="no_items"))
            elif name != "overall" and observed.n < gates.ceilings.min_n:
                rows.append(GateCheckRow(**base, result="insufficient_n", reason="below_min_n"))
            elif measured > limit:
                rows.append(GateCheckRow(**base, result="failed", reason=FAILED_CODES[metric]))
            else:
                rows.append(GateCheckRow(**base, result="passed"))
    return rows


def _population(report: EvalReport) -> list[ItemResult]:
    return report_gate_items(list(report.items), report.golden_filter.gate_split, report.gate_population)


def _no_answer(item: ItemResult, excluded: frozenset[str]) -> bool:
    return item.category in UNANSWERABLE_CATEGORIES and item.category not in excluded


def _composition(report: EvalReport, gates: QualityGates) -> tuple[CompositionResult, GateCheckRow, list[str]]:
    rules = gates.composition
    excluded = frozenset(rules.excluded_categories)
    counted = [item for item in _population(report) if item.category not in excluded]
    failed: list[str] = []
    by_language: dict[str, list[ItemResult]] = {}
    for item in counted:
        by_language.setdefault(item.language, []).append(item)
    languages: list[CompositionLanguageResult] = []
    kinds_total: dict[str, int] = {}
    for language in sorted(by_language):
        members = by_language[language]
        kinds: dict[str, int] = {}
        for item in members:
            if _no_answer(item, excluded):
                kinds[item.category] = kinds.get(item.category, 0) + 1
                kinds_total[item.category] = kinds_total.get(item.category, 0) + 1
        no_answer = sum(kinds.values())
        share = no_answer / len(members) if members else None
        if len(members) < rules.min_items_per_language or share is None:
            result = "insufficient_n"
        elif share < rules.no_answer_share_min:
            result = "failed"
            failed.append(NO_ANSWER_SHARE_BELOW_MIN)
        elif share < rules.no_answer_share_target:
            result = "warning"
        else:
            result = "passed"
        languages.append(
            CompositionLanguageResult(
                language=language,
                items=len(members),
                no_answer=no_answer,
                share=share,
                min=rules.no_answer_share_min,
                target=rules.no_answer_share_target,
                result=result,
                kinds=dict(sorted(kinds.items())),
            )
        )
    pooled_no_answer = sum(kinds_total.values())
    pooled_share = pooled_no_answer / len(counted) if counted else None
    pooled = {
        "check": "no_answer_share",
        "slice": "overall",
        "measured": pooled_share,
        "numerator": pooled_no_answer,
        "denominator": len(counted),
        "limit": rules.no_answer_share_min,
        "limit_kind": "min",
    }
    if pooled_share is None or len(counted) < rules.min_items_per_language:
        pooled_row = GateCheckRow(**pooled, result="insufficient_n", reason="below_min_items")
    elif pooled_share < rules.no_answer_share_min:
        pooled_row = GateCheckRow(**pooled, result="failed", reason=NO_ANSWER_SHARE_BELOW_MIN)
        failed.append(NO_ANSWER_SHARE_BELOW_MIN)
    elif pooled_share < rules.no_answer_share_target:
        pooled_row = GateCheckRow(**pooled, result="passed", reason="below_target")
    else:
        pooled_row = GateCheckRow(**pooled, result="passed")
    missing = [kind for kind in rules.required_no_answer_kinds if kinds_total.get(kind, 0) == 0]
    if missing:
        failed.append(REQUIRED_KIND_MISSING)
    return CompositionResult(languages=languages, missing_required_kinds=missing), pooled_row, failed


def _field(cell: object, name: str) -> object:
    return cell.get(name) if isinstance(cell, Mapping) else getattr(cell, name, None)


def _cells(calibration: object | None) -> list[object]:
    if calibration is None:
        return []
    cells = _field(calibration, "cells")
    if isinstance(cells, Mapping):
        return list(cells.values())
    return list(cells or [])


def _cell_dimensions(cell: object) -> tuple[str | None, str | None, str | None, str | None, str | None]:
    """(fingerprint, role, language, library, metric); the key fingerprint|role|language|library.metric fills gaps."""
    fields = [_field(cell, name) for name in ("fingerprint", "role", "language", "library", "metric")]
    key = _field(cell, "key")
    if isinstance(key, str) and key.count("|") == 3:
        fingerprint, role, language, joined = key.split("|")
        library, _, metric = joined.partition(".")
        fields = [own if own is not None else parsed for own, parsed in zip(fields, (fingerprint, role, language, library, metric))]
    return tuple(None if value is None else str(value) for value in fields)  # type: ignore[return-value]


def _recorded_on(cell: object) -> date | None:
    value = _field(cell, "recorded_at")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).date() if value.tzinfo else value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.astimezone(timezone.utc).date() if parsed.tzinfo else parsed.date()
    return None


def _calibration_reason(
    cells: list[object],
    *,
    language: str,
    library: str,
    metric: str,
    running: str | None,
    today: date,
    max_age_days: int,
) -> str | None:
    """None when the floor gates; otherwise the reason it is report-only (D-09, D-29, D-30)."""
    matching = [
        cell
        for cell in cells
        if _cell_dimensions(cell)[1:] == (JUDGE_ROLE, language, library, metric)
    ]
    if not matching:
        return "uncalibrated"
    if not running:
        return "judge_fingerprint_unknown"
    current = [cell for cell in matching if _cell_dimensions(cell)[0] == running]
    if not current:
        return "fingerprint_mismatch"
    cell = current[0]
    if _field(cell, "status") != "gating":
        return "calibration_report_only"
    recorded = _recorded_on(cell)
    if recorded is None or (today - recorded).days > max_age_days:
        return "calibration_expired"
    return None


def _floor_rows(
    gates: QualityGates,
    tier: str,
    judge_report: JudgeReport | None,
    calibration: object | None,
    running_fingerprints: Mapping[str, str] | None,
    today: date,
) -> list[GateCheckRow]:
    floors: dict[str, float] = getattr(gates.floors, tier, {}) or {}
    rows: list[GateCheckRow] = []
    if not floors:
        return rows
    if judge_report is None:
        for metric, floor in sorted(floors.items()):
            rows.append(
                GateCheckRow(
                    check=f"floor_{metric}",
                    slice="overall",
                    limit=floor,
                    limit_kind="min",
                    result="skipped",
                    reason="judge_report_missing",
                )
            )
        return rows
    cells = _cells(calibration)
    running = (running_fingerprints or {}).get(JUDGE_ROLE)
    for metric, floor in sorted(floors.items()):
        for language in sorted(judge_report.by_language):
            values = judge_report.by_language[language]
            for library in LIBRARIES:
                observed = values.get(f"{library}.{metric}")
                base = {
                    "check": f"floor_{metric}",
                    "slice": f"language:{language}:{library}",
                    "measured": None if observed is None else observed.value,
                    "denominator": None if observed is None else observed.n,
                    "limit": floor,
                    "limit_kind": "min",
                }
                if observed is None or observed.value is None:
                    rows.append(GateCheckRow(**base, result="skipped", reason="no_value"))
                    continue
                reason = _calibration_reason(
                    cells,
                    language=language,
                    library=library,
                    metric=metric,
                    running=running,
                    today=today,
                    max_age_days=gates.judge.max_age_days,
                )
                if reason is not None:
                    rows.append(GateCheckRow(**base, result="report_only", reason=reason))
                elif observed.value < floor:
                    rows.append(GateCheckRow(**base, result="failed", reason=FLOOR_NOT_MET))
                else:
                    rows.append(GateCheckRow(**base, result="passed"))
    return rows


def _unique(codes: Iterable[str]) -> list[str]:
    seen: list[str] = []
    for code in codes:
        if code not in seen:
            seen.append(code)
    return seen


def _code(failed: list[str]) -> int:
    if any(code in COMPOSITION_CODES for code in failed):
        return EXIT_COMPOSITION
    return EXIT_ABSOLUTE if failed else EXIT_PASS


def evaluate(
    report: EvalReport,
    gates: QualityGates,
    *,
    tier: str,
    judge_report: JudgeReport | None = None,
    calibration: object | None = None,
    running_fingerprints: Mapping[str, str] | None = None,
    today: date | None = None,
    mode: Mode = "enforce",
) -> AbsoluteGateResult:
    """Pure: no I/O and no baseline. Ceilings follow report.rag_mode (D-07); floors apply to the tier's judge metrics."""
    checks = _ceiling_rows(report, gates)
    composition, pooled, composition_failed = _composition(report, gates)
    checks.append(pooled)
    checks.extend(
        _floor_rows(gates, tier, judge_report, calibration, running_fingerprints, today or datetime.now(timezone.utc).date())
    )
    stale_failed = report.stale_share > gates.lifecycle.max_stale_share
    failed = _unique(
        [*composition_failed, *([STALE_SHARE_EXCEEDED] if stale_failed else []), *(r.reason for r in checks if r.result == "failed" and r.reason)]
    )
    return AbsoluteGateResult(
        passed=not failed,
        mode=mode,
        rag_mode=report.rag_mode,
        checks=checks,
        composition=composition,
        stale_count=report.stale_count,
        stale_share=report.stale_share,
        stale_result="failed" if stale_failed else "passed",
        failed=failed,
        exit_code=EXIT_PASS if mode == "report" else _code(failed),
    )


def exit_code_for(result: AbsoluteGateResult) -> int:
    """12 for a composition or stale-share failure, else 11 for a ceiling or floor failure, else 0; report mode is 0."""
    if result.mode == "report":
        return EXIT_PASS
    return _code(list(result.failed))


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{round(value, 4):.4f}"


def _check_table(rows: list[GateCheckRow]) -> list[str]:
    if not rows:
        return ["None."]
    lines = ["| Check | Slice | Measured | n | Limit | Result | Reason |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for row in rows:
        n = "-" if row.denominator is None else str(row.denominator)
        limit = "n/a" if row.limit is None else f"{row.limit_kind} {_fmt(row.limit)}"
        lines.append(
            f"| {row.check} | {row.slice} | {_fmt(row.measured)} | {n} | {limit} | {row.result} | {row.reason or '-'} |"
        )
    return lines


def render_absolute_markdown(result: AbsoluteGateResult) -> str:
    verdict = "PASS" if result.passed else "FAIL"
    lines = ["# Absolute gate", "", f"Result: {verdict} (exit {result.exit_code}, mode {result.mode}, rag_mode {result.rag_mode})", ""]
    ceilings = [row for row in result.checks if row.check in CEILING_METRICS]
    floors = [row for row in result.checks if row.check.startswith("floor_")]
    pooled = [row for row in result.checks if row.check == "no_answer_share"]
    lines += ["## Ceilings", "", *_check_table(ceilings), "", "## Floors", "", *_check_table(floors), ""]
    lines += ["## Composition", ""]
    if result.composition.languages:
        lines += ["| Language | Items | No-answer | Share | Min | Target | Result | Kinds |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for entry in result.composition.languages:
            kinds = ", ".join(f"{kind} {count}" for kind, count in entry.kinds.items()) or "-"
            lines.append(
                f"| {entry.language} | {entry.items} | {entry.no_answer} | {_fmt(entry.share)} | {_fmt(entry.min)} | "
                f"{_fmt(entry.target)} | {entry.result} | {kinds} |"
            )
    else:
        lines.append("None.")
    lines += ["", "Pooled:", "", *_check_table(pooled), ""]
    missing = result.composition.missing_required_kinds
    lines += ["Missing required no-answer kinds: " + (", ".join(missing) if missing else "None."), ""]
    lines += ["## Stale share", "", f"{result.stale_count} stale, share {_fmt(result.stale_share)}: {result.stale_result}", ""]
    lines += ["## Failed", ""]
    lines += [f"- {code}" for code in result.failed] if result.failed else ["None."]
    return "\n".join(lines) + "\n"


def _load_calibration(path: Path) -> object:
    text = _read(path)
    try:
        module = importlib.import_module("rag_sidecar.contracts.judge_calibration")
    except ImportError:
        module = None
    model = getattr(module, "JudgeCalibration", None) if module is not None else None
    if model is not None:
        return model.model_validate_json(text)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("cells", []), (list, dict)):
        raise ValueError(f"{path}: expected a calibration object with cells")
    return data


def _print_failures(result: AbsoluteGateResult) -> None:
    if result.passed:
        print(f"absolute gate: PASS (mode {result.mode})")
        return
    print(f"absolute gate: FAIL (exit {exit_code_for(result)}, mode {result.mode})", file=sys.stderr)
    for code in result.failed:
        print(f"  {code}", file=sys.stderr)
    for row in result.checks:
        if row.result == "failed":
            print(
                f"  {row.check} {row.slice}: measured {_fmt(row.measured)} vs {row.limit_kind} {_fmt(row.limit)}",
                file=sys.stderr,
            )


def _check(args: argparse.Namespace) -> int:
    try:
        report = EvalReport.model_validate_json(_read(resolve_cli_path(args.report)))
        gates = QualityGates.model_validate_json(_read(resolve_cli_path(args.gates)))
        judge = JudgeReport.model_validate_json(_read(resolve_cli_path(args.judge_report))) if args.judge_report else None
        calibration = _load_calibration(resolve_cli_path(args.calibration)) if args.calibration else None
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_MISMATCH
    fingerprints = {JUDGE_ROLE: args.judge_fingerprint} if args.judge_fingerprint else None
    result = evaluate(
        report,
        gates,
        tier=args.tier,
        judge_report=judge,
        calibration=calibration,
        running_fingerprints=fingerprints,
        mode=args.mode,
    )
    out_dir = resolve_cli_path(args.out)
    _write_text(out_dir / "absolute.json", result.model_dump_json(indent=2) + "\n")
    _write_text(out_dir / "absolute.md", render_absolute_markdown(result))
    _print_failures(result)
    return exit_code_for(result)


def _floor_tier(name: str) -> Tier:
    return "nightly" if name.startswith("nightly") else "smoke"


def _measure(args: argparse.Namespace) -> int:
    try:
        gates = QualityGates.model_validate_json(_read(resolve_cli_path(args.gates)))
        tiers: dict[str, EvalReport] = {}
        paths: dict[str, str] = {}
        for entry in args.tier:
            name, sep, raw_path = entry.partition("=")
            if not sep or not name or not raw_path:
                raise ValueError(f"--tier expects <name>=<report.json>, got {entry!r}")
            if name in tiers:
                raise ValueError(f"--tier {name} given twice")
            tiers[name] = EvalReport.model_validate_json(_read(resolve_cli_path(Path(raw_path))))
            paths[name] = raw_path
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_MISMATCH
    record: dict[str, object] = {"stage": args.stage, "tiers": {}}
    for name in sorted(tiers):
        enforced = evaluate(tiers[name], gates, tier=_floor_tier(name))
        record["tiers"][name] = {  # type: ignore[index]
            "report": paths[name],
            "stage": args.stage,
            "floor_tier": _floor_tier(name),
            "would_exit": exit_code_for(enforced),
            "passed": enforced.passed,
            "failed": list(enforced.failed),
            "checks": [row.model_dump(mode="json") for row in enforced.checks],
            "composition": enforced.composition.model_dump(mode="json"),
            "stale_result": enforced.stale_result,
        }
    out = resolve_cli_path(args.out)
    _write_text(out, json.dumps(record, indent=2, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"absolute gate measure: {len(tiers)} tier(s) recorded ({args.stage})")
    return EXIT_PASS


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rag_eval.absolute_gate", description="myRAG eval absolute quality gate")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="evaluate one report against eval/config/quality-gates.json")
    check.add_argument("--report", required=True, type=Path)
    check.add_argument("--gates", required=True, type=Path)
    check.add_argument("--tier", required=True, choices=["smoke", "nightly"])
    check.add_argument("--judge-report", type=Path)
    check.add_argument("--calibration", type=Path)
    check.add_argument("--judge-fingerprint", help="fingerprint of the running nightly judge; without it no floor gates")
    check.add_argument("--mode", choices=["enforce", "report"], default="enforce")
    check.add_argument("--out", required=True, type=Path)
    measure = sub.add_parser("measure", help="record the checks and would-be exit code of several tier reports")
    measure.add_argument("--stage", required=True, choices=["before", "after"])
    measure.add_argument("--tier", required=True, action="append", metavar="NAME=REPORT")
    measure.add_argument("--gates", required=True, type=Path)
    measure.add_argument("--out", required=True, type=Path)
    return parser


def _main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "check":
        return _check(args)
    return _measure(args)


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - a crash must not look like a gate failure
        print(f"absolute gate: INTERNAL ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
