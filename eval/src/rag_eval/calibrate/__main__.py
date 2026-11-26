import argparse
import os
import sys
from pathlib import Path

from rag_eval.calibrate import cache, groundedness, refusal
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


EXIT_GATE = 1


def _cache(args: argparse.Namespace) -> int:
    pairs = resolve_cli_path(args.pairs)
    out = resolve_cli_path(args.out)
    write = resolve_cli_path(args.write) if args.write is not None else None
    try:
        result, gate_failures, effective = cache.run_cache_calibration(
            pairs,
            out,
            profile_id=args.profile,
            write=write,
            config_path=resolve_cli_path(args.config),
            gate=args.check,
            default_distance=args.default_distance,
        )
    except (cache.CalibrationError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    entry = result.profile
    print(
        f"cache calibration ({entry.embedding_profile_id}): source={entry.source} max_distance={entry.max_distance:.4f}"
        + (f" reason={result.reason}" if result.reason else "")
    )
    print(f"wrote {out / cache.RESULT_NAME} and {out / cache.REPORT_NAME}")
    if write is not None:
        print(f"wrote {write}")
    if gate_failures:
        print(f"near-miss wrong hit at the effective distance {effective:.4f} on: {', '.join(gate_failures)}", file=sys.stderr)
        return EXIT_GATE
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.calibrate", description="myRAG refusal, groundedness and semantic-cache calibration")
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("refusal", help="fit per-cell refusal thresholds on dev, check once on the frozen holdout")
    cmd.add_argument("--run-config", required=True, type=Path)
    cmd.add_argument("--out", required=True, type=Path)
    cmd.add_argument("--golden", type=Path, default=refusal.DEFAULT_GOLDEN)
    cmd.add_argument("--base-url", default=None, help="live app base URL; cells are labelled live (default: fake edge, fixture)")
    cmd.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    cmd.add_argument("--write-thresholds", action="store_true", help="merge the cells into eval/config/refusal-thresholds.json")
    cmd.set_defaults(handler=_refusal)
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
    cmd = commands.add_parser(
        "cache", help="fit the semantic-cache distance per embedding profile on dev cache pairs, check once on test"
    )
    cmd.add_argument("--pairs", required=True, type=Path, help="cache-pairs.json from npm run test-rag -- --cache-pairs")
    cmd.add_argument("--out", type=Path, default=cache.DEFAULT_OUT)
    cmd.add_argument("--profile", default=None, help="embedding profile id (default: the one the pairs file names)")
    cmd.add_argument("--config", type=Path, default=cache.CONFIG_PATH, help="the calibration file --check reads")
    cmd.add_argument(
        "--write",
        nargs="?",
        type=Path,
        const=cache.CONFIG_PATH,
        default=None,
        help="merge the profile into a calibration file (default path: eval/config/semantic-cache.json)",
    )
    cmd.add_argument("--check", action="store_true", help="exit 1 on any near-miss wrong hit at the effective distance")
    cmd.add_argument(
        "--default-distance",
        type=float,
        default=cache.DEFAULT_MAX_DISTANCE,
        help="RAG_SEMANTIC_CACHE_MAX_DISTANCE, used when the profile has no calibrated entry",
    )
    cmd.set_defaults(handler=_cache)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
