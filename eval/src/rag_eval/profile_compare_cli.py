import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import EmbeddingProfileComparison
from rag_sidecar.contracts.report import EvalReport

from rag_eval.paths import resolve_cli_path
from rag_eval.profile_compare import build_comparison


def _read_report(path: Path) -> EvalReport:
    return EvalReport.model_validate_json(resolve_cli_path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.profile_compare_cli")
    parser.add_argument("--active-gated", required=True, type=Path)
    parser.add_argument("--active-candidate", required=True, type=Path)
    parser.add_argument("--target-gated", required=True, type=Path)
    parser.add_argument("--target-candidate", required=True, type=Path)
    parser.add_argument("--target-profile", required=True)
    parser.add_argument("--noise", required=True, type=Path)
    parser.add_argument("--pre-migration-meta", required=True, type=Path)
    parser.add_argument("--backfill-run-id", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
        active_gated = _read_report(args.active_gated)
        active_candidate = _read_report(args.active_candidate)
        target_gated = _read_report(args.target_gated)
        target_candidate = _read_report(args.target_candidate)
        meta = json.loads(resolve_cli_path(args.pre_migration_meta).read_text(encoding="utf-8"))
        n_before = int(meta.get("corpus_documents_before_run", 0))
        pre_items = active_gated.items[: max(0, min(len(active_gated.items), n_before))]
        comparison = build_comparison(
            (active_gated, active_candidate),
            {args.target_profile: (target_gated, target_candidate)},
            baseline_profile="openai-3-small-1536",
            active_profile="openai-3-small-1536",
            noise=noise,
            pre_migration_items=pre_items,
            backfill_run_id=args.backfill_run_id,
        )
        EmbeddingProfileComparison.model_validate_json(comparison.model_dump_json())
    except (OSError, ValidationError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    out_path = resolve_cli_path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(comparison.model_dump_json(indent=2) + "\n", encoding="utf-8")
    print(f"profile-compare: wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())