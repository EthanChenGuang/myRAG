import argparse
import os
import sys
from pathlib import Path

from rag_eval.calibrate import groundedness, refusal
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.calibrate", description="myRAG refusal and groundedness calibration")
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
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
