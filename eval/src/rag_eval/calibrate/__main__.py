import argparse
import os
import sys
from pathlib import Path

from rag_eval.calibrate import dup_clusters, groundedness, refusal
from rag_eval.calibrate.refusal import CalibrationError, run_refusal_calibration
from rag_eval.harness_runner import HarnessError
from rag_eval.paths import resolve_cli_path

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HARNESS = 3


def _refusal(args: argparse.Namespace) -> int:
    try:
        result = run_refusal_calibration(
            resolve_cli_path(args.run_config),
            resolve_cli_path(args.out),
            base_url=args.base_url,
            write=args.write_thresholds,
            golden=resolve_cli_path(args.golden),
            fixture_mode=args.fixture_mode,
        )
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    except (CalibrationError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    counts: dict[str, int] = {}
    for record in result.cells:
        counts[record.cell.status] = counts.get(record.cell.status, 0) + 1
    summary = " ".join(f"{status}={count}" for status, count in sorted(counts.items())) or "no cells"
    print(f"refusal calibration ({result.source}): {summary}")
    print(f"wrote {resolve_cli_path(args.out) / refusal.RESULT_NAME} and {resolve_cli_path(args.out) / refusal.REPORT_NAME}")
    if result.thresholds_written:
        print(f"wrote thresholds to {result.thresholds_path}")
    return EXIT_OK


def _dup_clusters(args: argparse.Namespace) -> int:
    out = resolve_cli_path(args.out)
    try:
        result = dup_clusters.run_dup_cluster_calibration(
            out,
            source=args.source,
            pairs_path=resolve_cli_path(args.pairs) if args.pairs is not None else None,
            embedding_profile=args.embedding_profile,
            write_params=args.write_params,
            corpus=args.corpus,
            deployment_mode=args.deployment_mode,
        )
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_HARNESS
    except (dup_clusters.CalibrationError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    chosen = f"threshold={result.threshold:.4f}" if result.threshold is not None else f"reason={result.reason}"
    print(f"dup-cluster calibration ({result.source}, {result.embedding_profile_id or 'no profile'}): {result.status} {chosen} pairs={result.n_pairs}")
    print(f"wrote {out / dup_clusters.RESULT_NAME} and {out / dup_clusters.REPORT_NAME}")
    if result.params_written:
        print(f"wrote the {result.source} entry to {result.params_path}")
    elif result.write_skipped_reason:
        print(f"not written: {result.write_skipped_reason}")
    return EXIT_OK


def _groundedness(args: argparse.Namespace) -> int:
    pairs = resolve_cli_path(args.pairs)
    out = resolve_cli_path(args.out)
    write = resolve_cli_path(args.write) if args.write is not None else None
    scorer: groundedness.Scorer | None = None
    try:
        if args.scorer == "sidecar":
            scorer = groundedness.SidecarScorer(
                args.sidecar_url or os.environ.get(groundedness.URL_ENV_VAR, ""),
                allow_vectara=args.allow_vectara,
            )
        else:
            if args.allow_vectara:
                raise groundedness.CalibrationError("--allow-vectara needs --scorer sidecar")
            scorer = groundedness.StubScorer(groundedness.load_pairs(pairs))
        result = groundedness.run_groundedness_calibration(pairs, out, scorer=scorer, write=write)
    except (groundedness.CalibrationError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    finally:
        if isinstance(scorer, groundedness.SidecarScorer):
            scorer.close()
    counts: dict[str, int] = {}
    for record in result.cells:
        counts[record.status] = counts.get(record.status, 0) + 1
    summary = " ".join(f"{status}={count}" for status, count in sorted(counts.items())) or "no cells"
    skipped = sum(sum(reasons.values()) for reasons in result.not_checked.values())
    print(f"groundedness calibration ({result.scorer_kind}): {summary} not_checked={skipped}")
    print(f"wrote {out / groundedness.RESULT_NAME} and {out / groundedness.REPORT_NAME}")
    if result.thresholds_written:
        print(f"wrote thresholds to {result.thresholds_path}")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.calibrate", description="myRAG refusal, groundedness and duplicate-cluster calibration")
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("refusal", help="fit per-cell refusal thresholds on dev, check once on the frozen holdout")
    cmd.add_argument("--run-config", required=True, type=Path)
    cmd.add_argument("--out", required=True, type=Path)
    cmd.add_argument("--golden", type=Path, default=refusal.DEFAULT_GOLDEN)
    cmd.add_argument("--base-url", default=None, help="live app base URL; cells are labelled live (default: fake edge, fixture)")
    cmd.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    cmd.add_argument("--write-thresholds", action="store_true", help="merge the cells into eval/config/refusal-thresholds.json")
    cmd.set_defaults(handler=_refusal)
    cmd = commands.add_parser("dup-clusters", help="fit the duplicate-cluster threshold precision first from labelled candidate pairs")
    cmd.add_argument("--out", type=Path, default=dup_clusters.DEFAULT_OUT)
    cmd.add_argument("--source", choices=("fixture", "live"), default="fixture")
    cmd.add_argument("--pairs", type=Path, default=None, help="labelled pairs JSONL (live: required, kept outside the repository)")
    cmd.add_argument("--embedding-profile", default=None, help="embedding profile id the pairs belong to (live: required)")
    cmd.add_argument("--corpus", default=dup_clusters.DEFAULT_CORPUS, help="fixture corpus for the pair harness")
    cmd.add_argument("--deployment-mode", choices=("single-tenant", "multi-tenant"), default="single-tenant")
    cmd.add_argument(
        "--write-params", action="store_true", help="store the profile's entry in eval/config/dup-cluster-params.json (top level unchanged)"
    )
    cmd.set_defaults(handler=_dup_clusters)
    cmd = commands.add_parser(
        "groundedness", help="fit per (scorer, language) groundedness thresholds on dev, check once on test"
    )
    cmd.add_argument("--pairs", type=Path, default=groundedness.DEFAULT_PAIRS, help="labelled pairs JSONL (default: the synthetic fixture)")
    cmd.add_argument("--out", type=Path, default=groundedness.DEFAULT_OUT)
    cmd.add_argument("--scorer", choices=("stub", "sidecar"), default="stub")
    cmd.add_argument("--sidecar-url", default=None, help=f"sidecar base URL (default: ${groundedness.URL_ENV_VAR})")
    cmd.add_argument("--allow-vectara", action="store_true", help="let the sidecar send pairs to Vectara")
    cmd.add_argument(
        "--write",
        nargs="?",
        type=Path,
        const=groundedness.THRESHOLDS_PATH,
        default=None,
        help="merge the cells into a thresholds file (default path: eval/config/groundedness-thresholds.json); live runs on real pairs only",
    )
    cmd.set_defaults(handler=_groundedness)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
