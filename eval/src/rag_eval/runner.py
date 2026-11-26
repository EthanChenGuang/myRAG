import argparse
import sys
from pathlib import Path

from rag_sidecar.contracts.judge import JudgeReport

from rag_eval.config_files import load_gate_population
from rag_eval.corpus import load_corpus
from rag_eval.golden_io import item_sha256, load_golden, select_golden
from rag_eval.golden_set import LifecycleError, load_manifest as load_set_manifest
from rag_eval.metrics import RealSetTooSmall, score_items
from rag_eval.paths import REPO_ROOT, resolve_cli_path
from rag_eval.report import build_report, write_report
from rag_eval.split import DOCGROUP_SPLIT_RULE, load_group_manifest
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


def _missing_from_manifest(golden_path: Path, golden_ids: list[str], explicit: Path | None) -> list[str]:
    """Ids of the set's split manifest that the golden file lacks (D-20: the set only grows, deletions are refused).

    Without --split-manifest only a docgroup-rule manifest next to the golden file is the set's own; an item-rule
    manifest there may be shared by several files (the private root) and is not checked.
    """
    path = explicit if explicit is not None else golden_path.with_name("split-manifest.json")
    manifest = load_group_manifest(path)
    if manifest is None:
        if explicit is not None:
            raise ValueError(f"split manifest {path} does not exist")
        return []
    if explicit is None and manifest.rule != DOCGROUP_SPLIT_RULE:
        return []
    return sorted(set(manifest.assignments) - set(golden_ids))


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


def _set_manifest_problems(golden, set_manifest) -> list[str]:
    """Every scored item must be in the set manifest with its recorded hash (D-46); the set may hold items this run
    does not score (for example table_split items left out of a queued run)."""
    recorded = {entry.id: entry for entry in set_manifest.items}
    problems: list[str] = []
    for item in golden:
        entry = recorded.get(item.id)
        if entry is None:
            problems.append(f"added: {item.id} is in the golden file but not in the manifest")
        elif item_sha256(item) != entry.item_sha256:
            problems.append(f"changed: {item.id} differs from its manifest hash")
    return problems


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
    set_manifest = None
    if args.golden_manifest:
        try:
            set_manifest = load_set_manifest(resolve_cli_path(args.golden_manifest))
        except (OSError, ValueError, LifecycleError) as exc:
            print(f"error: golden manifest: {exc}", file=sys.stderr)
            return 2
        lifecycle_problems = _set_manifest_problems(golden, set_manifest)
        if lifecycle_problems:
            print("error: the golden file does not match its golden-set manifest:", file=sys.stderr)
            for problem in lifecycle_problems:
                print(f"  {problem}", file=sys.stderr)
            return 2
    try:
        missing = _missing_from_manifest(
            resolve_cli_path(args.golden),
            [item.id for item in golden],
            resolve_cli_path(args.split_manifest) if args.split_manifest else None,
        )
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if missing:
        print("error: the golden file lacks items its split manifest froze (deleted items are refused):", file=sys.stderr)
        for item_id in missing:
            print(f"  {item_id}", file=sys.stderr)
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
        report = build_report(
            manifest, results, golden, traces, judge=judge, gate_population_config=gate_config, golden_manifest=set_manifest
        )
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
    score.add_argument(
        "--split-manifest",
        type=Path,
        default=None,
        help="split manifest whose every item id must be in the golden file (default: a docgroup-rule "
        "split-manifest.json next to the golden file; a deleted item is refused)",
    )
    score.add_argument(
        "--golden-manifest",
        type=Path,
        default=None,
        help="golden-set manifest (D-46): every scored item must match its hash; fills golden_set_version, "
        "golden_manifest_sha256, stale_count and stale_share and leaves stale and retired items out of the gated slices",
    )
    score.set_defaults(handler=_score)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
