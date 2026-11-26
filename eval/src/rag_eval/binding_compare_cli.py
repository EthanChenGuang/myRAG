import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import BindingComparison, BindingComparisonHashes
from rag_sidecar.contracts.report import EvalReport

from rag_eval.binding_compare import CandidateCatalog, compare, golden_doc_types_from_tags
from rag_eval.golden_io import load_golden
from rag_eval.paths import resolve_cli_path

EXIT_WRITTEN = 0
EXIT_INVALID = 2


def _read_report(path: Path) -> EvalReport:
    return EvalReport.model_validate_json(resolve_cli_path(path).read_text(encoding="utf-8"))


def _pairs(values: list[str], flag: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        key, sep, rest = value.partition("=")
        if not sep or not key or not rest:
            raise ValueError(f"{flag} expects <profile_id>=<value>, got {value!r}")
        if key in parsed:
            raise ValueError(f"{flag} names {key} twice")
        parsed[key] = rest
    return parsed


def _catalog(path: Path) -> dict[str, CandidateCatalog]:
    raw = json.loads(resolve_cli_path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("--catalog-json must hold an object keyed by profile id")
    return {
        profile_id: CandidateCatalog(
            model=str(entry["model"]),
            usd_per_million_tokens=float(entry["usd_per_million_tokens"]),
            supported_languages=tuple(str(language) for language in entry.get("supported_languages", [])),
        )
        for profile_id, entry in raw.items()
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.binding_compare_cli")
    parser.add_argument("--doc-type", required=True)
    parser.add_argument("--baseline-profile", required=True)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--control", required=True, type=Path)
    parser.add_argument("--candidate", action="append", default=[], help="<profile_id>=<report.json>")
    parser.add_argument("--golden", required=True, type=Path)
    parser.add_argument("--noise", required=True, type=Path)
    parser.add_argument("--reembed-run", action="append", default=[], help="<profile_id>=<run uuid>")
    parser.add_argument("--hashes-json", required=True, type=Path)
    parser.add_argument("--catalog-json", required=True, type=Path, help="profile id → model, price and supported languages")
    parser.add_argument("--fixture-embedder", action="store_true")
    parser.add_argument("--note", action="append", default=[], help="extra note recorded in the comparison")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        candidate_paths = _pairs(args.candidate, "--candidate")
        if not candidate_paths:
            raise ValueError("at least one --candidate is required")
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
        hashes = BindingComparisonHashes.model_validate_json(resolve_cli_path(args.hashes_json).read_text(encoding="utf-8"))
        comparison = compare(
            _read_report(args.baseline),
            _read_report(args.control),
            {profile_id: _read_report(Path(path)) for profile_id, path in candidate_paths.items()},
            noise,
            args.doc_type,
            baseline_profile=args.baseline_profile,
            catalog=_catalog(args.catalog_json),
            hashes=hashes,
            reembed_run_ids=_pairs(args.reembed_run, "--reembed-run"),
            fixture_embedder=args.fixture_embedder,
            golden_doc_types=golden_doc_types_from_tags(load_golden(resolve_cli_path(args.golden))),
            report_paths={"baseline": str(args.baseline), "control": str(args.control), **candidate_paths},
            extra_notes=args.note,
        )
        BindingComparison.model_validate_json(comparison.model_dump_json())
    except (OSError, KeyError, ValidationError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    out_path = resolve_cli_path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(comparison.model_dump_json(indent=2) + "\n", encoding="utf-8")
    verdict = comparison.recommended_profile or "none"
    print(f"binding-compare: wrote {out_path} (doc type {comparison.doc_type}, recommended {verdict})")
    return EXIT_WRITTEN


if __name__ == "__main__":
    raise SystemExit(main())
