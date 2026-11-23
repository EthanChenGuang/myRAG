import argparse
import sys
from pathlib import Path

from rag_eval.golden_io import load_golden, select_golden
from rag_eval.metrics import score_items
from rag_eval.paths import resolve_cli_path
from rag_eval.report import build_report, write_report
from rag_eval.traces import load_manifest, load_traces


def _cross_check(golden_ids: list[str], trace_ids: list[str | None]) -> list[str]:
    problems: list[str] = []
    seen: dict[str, int] = {}
    for item_id in trace_ids:
        if item_id is None:
            problems.append("a trace has no item_id")
            continue
        seen[item_id] = seen.get(item_id, 0) + 1
    known = set(golden_ids)
    for item_id in golden_ids:
        if item_id not in seen:
            problems.append(f"golden item {item_id!r} has no trace")
    for item_id, count in sorted(seen.items()):
        if count > 1:
            problems.append(f"item {item_id!r} has {count} traces")
        if item_id not in known:
            problems.append(f"trace names unknown item {item_id!r}")
    return problems


def _rate(label: str, metric) -> str:
    shown = "n/a" if metric.value is None else f"{round(metric.value, 3):.3f}"
    return f"{label}={shown} (n={metric.n})"


def _score(args: argparse.Namespace) -> int:
    try:
        golden = load_golden(resolve_cli_path(args.golden))
        traces = load_traces(resolve_cli_path(args.traces))
        manifest = load_manifest(resolve_cli_path(args.manifest))
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    golden = select_golden(golden, manifest.golden_filter)

    problems = _cross_check([item.id for item in golden], [trace.item_id for trace in traces])
    if problems:
        print("error: golden items and traces do not match:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 2

    results = score_items(traces, golden)
    report = build_report(manifest, results, golden)
    write_report(report, resolve_cli_path(args.out))
    overall = report.overall
    print(
        "overall: "
        + " ".join(
            [
                f"items={len(results)}",
                f"gated_{manifest.golden_filter.gate_split}={sum(1 for r in results if r.split == manifest.golden_filter.gate_split)}",
                _rate("recall@5", overall.recall_at_5),
                _rate("recall@10", overall.recall_at_10),
                _rate("mrr", overall.mrr),
                _rate("correct_refusal", overall.correct_refusal_rate),
                _rate("false_refusal", overall.false_refusal_rate),
            ]
        )
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.runner", description="myRAG eval runner")
    commands = parser.add_subparsers(dest="command", required=True)
    score = commands.add_parser("score", help="score JSONL traces into report.json and report.md")
    score.add_argument("--traces", required=True, type=Path)
    score.add_argument("--golden", required=True, type=Path)
    score.add_argument("--manifest", required=True, type=Path)
    score.add_argument("--out", required=True, type=Path)
    score.set_defaults(handler=_score)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
