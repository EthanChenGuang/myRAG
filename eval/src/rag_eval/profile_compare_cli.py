import argparse
import json
import sys
from pathlib import Path

from pydantic import TypeAdapter, ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import (
    EmbeddingProfileComparison,
    ServingModeMeasurement,
)
from rag_sidecar.contracts.report import EvalReport

from rag_eval.paths import resolve_cli_path
from rag_eval.profile_compare import build_comparison, render_comparison

_SERVING = TypeAdapter(dict[str, list[ServingModeMeasurement]])


def _read_report(path: Path) -> EvalReport:
    return EvalReport.model_validate_json(resolve_cli_path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.profile_compare_cli")
    parser.add_argument("--active-gated", required=True, type=Path)
    parser.add_argument("--active-candidate", required=True, type=Path)
    parser.add_argument("--target-gated", type=Path)
    parser.add_argument("--target-candidate", type=Path)
    parser.add_argument("--target-profile")
    parser.add_argument(
        "--arm",
        nargs=3,
        action="append",
        default=[],
        metavar=("PROFILE", "GATED", "CANDIDATE"),
        help="one target arm: profile id, gated report, candidate report (repeatable)",
    )
    parser.add_argument(
        "--serving",
        type=Path,
        help="JSON object: profile id -> list of ServingModeMeasurement",
    )
    parser.add_argument(
        "--wiring-proof",
        action="store_true",
        help="fixture run: label it, give no verdict, refuse it as evidence",
    )
    parser.add_argument("--noise", required=True, type=Path)
    parser.add_argument("--pre-migration-meta", required=True, type=Path)
    parser.add_argument("--backfill-run-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--text-out", type=Path)
    args = parser.parse_args(argv)

    legacy = (args.target_gated, args.target_candidate, args.target_profile)
    if any(value is not None for value in legacy) and not all(value is not None for value in legacy):
        parser.error("--target-gated, --target-candidate and --target-profile go together")
    arms: list[tuple[str, Path, Path]] = [
        (profile, Path(gated), Path(candidate)) for profile, gated, candidate in args.arm
    ]
    if all(value is not None for value in legacy):
        arms.insert(0, (args.target_profile, args.target_gated, args.target_candidate))
    if not arms:
        parser.error("name at least one target arm (--arm or --target-*)")
    if len({profile for profile, _, _ in arms}) != len(arms):
        parser.error("each target profile may appear once")

    try:
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
        active_gated = _read_report(args.active_gated)
        active_candidate = _read_report(args.active_candidate)
        targets = {profile: (_read_report(gated), _read_report(candidate)) for profile, gated, candidate in arms}
        serving = (
            _SERVING.validate_json(resolve_cli_path(args.serving).read_text(encoding="utf-8")) if args.serving else None
        )
        meta = json.loads(resolve_cli_path(args.pre_migration_meta).read_text(encoding="utf-8"))
        n_before = int(meta.get("corpus_documents_before_run", 0))
        pre_items = active_gated.items[: max(0, min(len(active_gated.items), n_before))]
        comparison = build_comparison(
            (active_gated, active_candidate),
            targets,
            baseline_profile="openai-3-small-1536",
            active_profile="openai-3-small-1536",
            noise=noise,
            pre_migration_items=pre_items,
            backfill_run_id=args.backfill_run_id,
            serving=serving,
            wiring_proof=args.wiring_proof,
        )
        EmbeddingProfileComparison.model_validate_json(comparison.model_dump_json())
    except (OSError, ValidationError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    out_path = resolve_cli_path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(comparison.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"profile-compare: wrote {out_path}")
    if args.text_out:
        text_path = resolve_cli_path(args.text_out)
        text_path.parent.mkdir(parents=True, exist_ok=True)
        text_path.write_text(render_comparison(comparison), encoding="utf-8")
        print(f"profile-compare: wrote {text_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
