import argparse
import sys
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import Baseline, GateOffender, GateResult, NoiseConfig
from rag_sidecar.contracts.report import EvalReport, SliceMetrics

from rag_eval.paths import resolve_cli_path

EXIT_PASS = 0
EXIT_MISMATCH = 2
EXIT_REGRESSION = 10
EXIT_INTERNAL = 70


def _report_slices(report: EvalReport) -> dict[str, SliceMetrics]:
    slices: dict[str, SliceMetrics] = {"overall": report.overall}
    for language, metrics in report.by_language.items():
        slices[f"language:{language}"] = metrics
    for category, metrics in report.by_category.items():
        slices[f"category:{category}"] = metrics
    return slices


def _mismatches(report: EvalReport, baseline: Baseline) -> list[str]:
    problems: list[str] = []
    checks = (
        ("golden_sha256", report.golden_sha256, baseline.golden_sha256),
        ("corpus_sha256", report.corpus_sha256, baseline.corpus_sha256),
        ("embedder_id", report.embedder_id, baseline.embedder_id),
        ("embedder_version", report.embedder_version, baseline.embedder_version),
    )
    if report.golden_filter != baseline.golden_filter:
        problems.append(
            f"golden_filter differs: report {report.golden_filter.model_dump()!r}, baseline {baseline.golden_filter.model_dump()!r}"
        )
    for name, observed, recorded in checks:
        if observed != recorded:
            problems.append(f"{name} differs: report {observed!r}, baseline {recorded!r}")
    if problems:
        problems.append("re-record the baseline: npm run eval:baseline")
    return problems


def _is_gated(slice_name: str, noise: NoiseConfig) -> bool:
    return any(
        slice_name == prefix if not prefix.endswith(":") else slice_name.startswith(prefix)
        for prefix in noise.gated_slice_prefixes
    )


def evaluate_gate(report: EvalReport, baseline: Baseline, noise: NoiseConfig) -> GateResult:
    mismatches = _mismatches(report, baseline)
    if mismatches:
        return GateResult(passed=False, offenders=[], skipped=[], mismatches=mismatches)

    observed_slices = _report_slices(report)
    offenders: list[GateOffender] = []
    skipped: list[str] = []
    for slice_name in sorted(baseline.slices):
        if not _is_gated(slice_name, noise):
            continue
        recorded = baseline.slices[slice_name]
        observed_metrics = observed_slices.get(slice_name)
        for metric, direction in noise.metrics.items():
            stat = recorded.get(metric)
            observed_value = None
            if observed_metrics is not None:
                observed_value = getattr(observed_metrics, metric).value
            if stat is None or stat.mean is None or observed_value is None:
                skipped.append(f"{slice_name}:{metric}")
                continue
            band = max(noise.k * stat.spread, noise.floor)
            if direction == "higher":
                threshold = stat.mean - band
                regressed = observed_value < threshold
            else:
                threshold = stat.mean + band
                regressed = observed_value > threshold
            if regressed:
                offenders.append(
                    GateOffender(
                        slice=slice_name,
                        metric=metric,
                        baseline_mean=stat.mean,
                        threshold=threshold,
                        observed=observed_value,
                        direction=direction,
                    )
                )
    return GateResult(passed=not offenders, offenders=offenders, skipped=skipped, mismatches=[])


def _fmt(value: float) -> str:
    return f"{round(value, 4):.4f}"


def _category_rows(report: EvalReport, baseline: Baseline, noise: NoiseConfig) -> list[str]:
    observed_slices = _report_slices(report)
    rows: list[str] = []
    for slice_name in sorted(baseline.slices):
        if not slice_name.startswith("category:"):
            continue
        for metric in noise.metrics:
            stat = baseline.slices[slice_name].get(metric)
            observed_metrics = observed_slices.get(slice_name)
            observed_value = getattr(observed_metrics, metric).value if observed_metrics is not None else None
            if stat is None or stat.mean is None or observed_value is None:
                rows.append(f"| {slice_name} | {metric} | n/a | n/a | n/a |")
                continue
            rows.append(
                f"| {slice_name} | {metric} | {_fmt(stat.mean)} | {_fmt(observed_value)} | "
                f"{observed_value - stat.mean:+.4f} |"
            )
    return rows


def render_gate_markdown(
    result: GateResult, report: EvalReport | None = None, baseline: Baseline | None = None, noise: NoiseConfig | None = None
) -> str:
    lines = ["# Eval gate", ""]
    if result.mismatches:
        lines.append(f"Result: MISMATCH (exit {EXIT_MISMATCH})")
        lines.append("")
        lines.extend(f"- {problem}" for problem in result.mismatches)
        return "\n".join(lines) + "\n"
    lines.append(f"Result: PASS (exit {EXIT_PASS})" if result.passed else f"Result: FAIL (exit {EXIT_REGRESSION})")
    lines.append("")
    lines.append("## Offenders")
    lines.append("")
    if result.offenders:
        lines.append("| Slice | Metric | Baseline mean | Threshold | Observed | Direction |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for offender in result.offenders:
            lines.append(
                f"| {offender.slice} | {offender.metric} | {_fmt(offender.baseline_mean)} | "
                f"{_fmt(offender.threshold)} | {_fmt(offender.observed)} | {offender.direction} |"
            )
    else:
        lines.append("None.")
    lines.append("")
    lines.append("## Report-only category deltas")
    lines.append("")
    if report is not None and baseline is not None and noise is not None:
        rows = _category_rows(report, baseline, noise)
        if rows:
            lines.append("| Slice | Metric | Baseline mean | Observed | Delta |")
            lines.append("| --- | --- | --- | --- | --- |")
            lines.extend(rows)
        else:
            lines.append("None.")
    else:
        lines.append("None.")
    lines.append("")
    lines.append("## Skipped")
    lines.append("")
    if result.skipped:
        lines.extend(f"- {entry} (no value to compare)" for entry in result.skipped)
    else:
        lines.append("None.")
    return "\n".join(lines) + "\n"


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _read(path: Path) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.gate", description="myRAG eval noise-band gate")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--noise", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        report = EvalReport.model_validate_json(_read(resolve_cli_path(args.report)))
        baseline = Baseline.model_validate_json(_read(resolve_cli_path(args.baseline)))
        noise = NoiseConfig.model_validate_json(_read(resolve_cli_path(args.noise)))
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_MISMATCH

    result = evaluate_gate(report, baseline, noise)
    out_dir = resolve_cli_path(args.out)
    _write_text(out_dir / "gate.json", result.model_dump_json(indent=2) + "\n")
    _write_text(out_dir / "gate.md", render_gate_markdown(result, report, baseline, noise))

    if result.mismatches:
        print("error: report and baseline were produced from different data:", file=sys.stderr)
        for problem in result.mismatches:
            print(f"  {problem}", file=sys.stderr)
        return EXIT_MISMATCH
    if result.offenders:
        print(f"gate: FAIL, {len(result.offenders)} metric(s) beyond the noise band", file=sys.stderr)
        for offender in result.offenders:
            print(
                f"  {offender.slice} {offender.metric}: observed {_fmt(offender.observed)} "
                f"vs threshold {_fmt(offender.threshold)} (baseline {_fmt(offender.baseline_mean)})",
                file=sys.stderr,
            )
        return EXIT_REGRESSION
    print(f"gate: PASS ({len(result.skipped)} skipped)")
    return EXIT_PASS


def main(argv: list[str] | None = None) -> int:
    try:
        return _main(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - any crash must not look like a regression
        print(f"gate: INTERNAL ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
