import argparse
import sys
from pathlib import Path

from rag_sidecar.contracts.judge import JudgeReport

from rag_eval.config_files import load_gate_population
from rag_eval.corpus import load_corpus
from rag_eval.golden_io import load_golden, select_golden
from rag_eval.metrics import RealSetTooSmall, score_items
from rag_eval.paths import REPO_ROOT, resolve_cli_path
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


DEFAULT_CORPUS_DIR = REPO_ROOT / "eval" / "fixtures" / "corpus"
EXIT_REAL_SET_TOO_SMALL = 3
REPORT_FILES = ("report.json", "report.md")


def _remove_stale_report(out_dir: Path) -> None:
    """A failed real run must not leave an older report behind that a gate could pick up."""
    for name in REPORT_FILES:
        (out_dir / name).unlink(missing_ok=True)


def _doc_types(corpus_dir: Path | None, corpus_sha256: str | None) -> dict[str, str] | None:
    if corpus_dir is None:
        if corpus_sha256 is None or not DEFAULT_CORPUS_DIR.is_dir():
            return None
        corpus_dir = DEFAULT_CORPUS_DIR
    return {doc.filename.casefold(): doc.doc_type for doc in load_corpus(corpus_dir) if doc.doc_type}


def _rate(label: str, metric) -> str:
    shown = "n/a" if metric.value is None else f"{round(metric.value, 3):.3f}"
    return f"{label}={shown} (n={metric.n})"


def _score(args: argparse.Namespace) -> int:
    try:
        golden = load_golden(resolve_cli_path(args.golden))
        traces = load_traces(resolve_cli_path(args.traces))
        manifest = load_manifest(resolve_cli_path(args.manifest))
        judge = (
            JudgeReport.model_validate_json(resolve_cli_path(args.judge).read_text(encoding="utf-8"))
            if args.judge
            else None
        )
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

    try:
        doc_types = _doc_types(resolve_cli_path(args.corpus) if args.corpus else None, manifest.corpus_sha256)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    try:
        gate_config = load_gate_population(resolve_cli_path(args.gate_population) if args.gate_population else None)
    except (OSError, ValueError) as exc:
        print(f"error: gate population: {exc}", file=sys.stderr)
        return 2
    results = score_items(traces, golden, rank_field=args.rank_source, doc_types=doc_types)
    out_dir = resolve_cli_path(args.out)
    try:
        report = build_report(manifest, results, golden, traces, judge=judge, gate_population_config=gate_config)
    except RealSetTooSmall as exc:
        _remove_stale_report(out_dir)
        print(
            f"error: {exc.reason}: the real gate population has {exc.count} approved item(s) in split "
            f"{manifest.golden_filter.gate_split}, min_items is {exc.min_items}; no report written",
            file=sys.stderr,
        )
        return EXIT_REAL_SET_TOO_SMALL
    write_report(report, out_dir)
    print(f"gate_population={report.gate_population} sha256={gate_config[1]} (mode {gate_config[0].mode})")
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
    score.add_argument(
        "--rank-source",
        choices=("kept", "candidates"),
        default="kept",
        help="rank list used for recall (candidates = threshold-free RPC list)",
    )
    score.add_argument(
        "--corpus",
        type=Path,
        default=None,
        help="corpus directory whose fixture-meta doc_type keys feed by_doc_type "
        "(default: the fixture corpus when the manifest records a corpus hash, else every item is general)",
    )
    score.add_argument(
        "--judge",
        type=Path,
        default=None,
        help="judge.json from rag_eval.judge.run; fills Faithfulness per citation strategy (report-only)",
    )
    score.add_argument(
        "--gate-population",
        type=Path,
        default=None,
        help="GatePopulationConfig JSON (default: eval/config/gate-population.json); real mode below min_items "
        f"exits {EXIT_REAL_SET_TOO_SMALL} with real_set_too_small",
    )
    score.set_defaults(handler=_score)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
