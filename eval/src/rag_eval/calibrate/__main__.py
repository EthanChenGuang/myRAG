import argparse
import sys
from pathlib import Path

from rag_eval.calibrate import refusal
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.calibrate", description="myRAG refusal calibration")
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("refusal", help="fit per-cell refusal thresholds on dev, check once on the frozen holdout")
    cmd.add_argument("--run-config", required=True, type=Path)
    cmd.add_argument("--out", required=True, type=Path)
    cmd.add_argument("--golden", type=Path, default=refusal.DEFAULT_GOLDEN)
    cmd.add_argument("--base-url", default=None, help="live app base URL; cells are labelled live (default: fake edge, fixture)")
    cmd.add_argument("--fixture-mode", choices=("prechunked", "ingest"), default=None)
    cmd.add_argument("--write-thresholds", action="store_true", help="merge the cells into eval/config/refusal-thresholds.json")
    cmd.set_defaults(handler=_refusal)
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
