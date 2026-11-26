"""Ship rule (Phase 5.1.1 D-24, FBK-09): an improvement must be proven on the real domain test set before going live.

`python -m rag_eval.ship_check --baseline <report.json> --candidate <report.json> --target <metric>` passes (exit 0) only when
- both reports are gate_population "real" (reason not_real_population otherwise);
- both scored the same golden manifest (golden_sha256 and golden_filter; reason manifest_mismatch);
- both gate the same real item ids (reason item_set_mismatch; none at all is no_gated_items);
- no metric of the overall, per-language, per-category or language-pair slice falls, as a paired mean difference over the
  shared items, beyond the noise band (single-run reports have no spread, so the band is the noise floor; reason
  slice_regression_<slice>);
- the seeded paired bootstrap 95% interval of the target metric's per-item difference lies strictly on the improving side
  of zero (above zero for a higher-is-better metric, below for a lower-is-better one; reason target_not_improved).
The ShipCheckResult (hashes, codes and numbers only) is written under eval/golden/private/ship/ in every case; a failed
check exits 1 and lists its reasons.
"""

import argparse
import hashlib
import math
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig, ShipCheckResult
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.config_files import load_gate_population
from rag_eval.draft import writer
from rag_eval.draft.writer import PrivatePathError, assert_private_path
from rag_eval.failure_report import file_stamp, write_text
from rag_eval.metrics import report_gate_items
from rag_eval.paired import _bootstrap_interval, _slice_members, item_metrics
from rag_eval.paths import REPO_ROOT, resolve_cli_path

EXIT_OK, EXIT_FAIL, EXIT_INPUT, EXIT_PRIVATE = 0, 1, 2, 6
DEFAULT_RESAMPLES = 10000
DEFAULT_SEED = 0
DEFAULT_NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
SHIP_SUBDIR = "ship"
REAL = "real"

NOT_REAL_POPULATION = "not_real_population"
MANIFEST_MISMATCH = "manifest_mismatch"
ITEM_SET_MISMATCH = "item_set_mismatch"
NO_GATED_ITEMS = "no_gated_items"
TARGET_NOT_SCORED = "target_not_scored"
TARGET_NOT_IMPROVED = "target_not_improved"
SLICE_REGRESSION = "slice_regression"

_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_CODE_UNSAFE = re.compile(r"[^a-z0-9_]+")


def bootstrap_interval(differences: list[float], seed: int = DEFAULT_SEED, resamples: int = DEFAULT_RESAMPLES) -> tuple[float, float]:
    """Percentile 95% interval of the mean over `resamples` seeded resamples (the paired.py rule)."""
    return _bootstrap_interval(differences, seed=seed, resamples=resamples)


def slice_reason(slice_name: str) -> str:
    return f"{SLICE_REGRESSION}_{_CODE_UNSAFE.sub('_', slice_name.lower())}"[:64].rstrip("_")


def _differences(baseline: dict[str, ItemResult], members: list[ItemResult], metric: str) -> list[float]:
    differences: list[float] = []
    for item in members:
        observed = item_metrics(item)[metric]
        recorded = item_metrics(baseline[item.item_id])[metric]
        if observed is None or recorded is None:
            continue
        differences.append(observed - recorded)
    return differences


def _result_population(baseline: EvalReport, candidate: EvalReport) -> str:
    for report in (baseline, candidate):
        if report.gate_population != REAL:
            return report.gate_population
    return REAL


def run_ship_check(
    baseline: EvalReport,
    candidate: EvalReport,
    target: str,
    *,
    noise: NoiseConfig,
    population: GatePopulationConfig,
    baseline_hash: str,
    candidate_hash: str,
    seed: int = DEFAULT_SEED,
    resamples: int = DEFAULT_RESAMPLES,
) -> tuple[ShipCheckResult, list[str]]:
    """The ShipCheckResult and one detail line per finding (slice, metric and numbers; never item text)."""
    if target not in noise.metrics:
        raise ValueError(f"unknown target metric {target!r}; choose one of {sorted(noise.metrics)}")
    same_manifest = baseline.golden_sha256 == candidate.golden_sha256 and baseline.golden_filter == candidate.golden_filter
    fields: dict[str, object] = {
        "target_metric": target,
        "seed": seed,
        "resamples": resamples,
        "baseline_hash": baseline_hash,
        "candidate_hash": candidate_hash,
        "manifest_hash": baseline.golden_sha256 if same_manifest and _SHA256.match(baseline.golden_sha256) else None,
        "gate_population": _result_population(baseline, candidate),
    }

    def finish(reasons: list[str], details: list[str], **extra: object) -> tuple[ShipCheckResult, list[str]]:
        unique = list(dict.fromkeys(reasons))
        return ShipCheckResult(passed=not unique, reasons=unique, **fields, **extra), details

    reasons: list[str] = []
    details: list[str] = []
    if baseline.gate_population != REAL or candidate.gate_population != REAL:
        reasons.append(NOT_REAL_POPULATION)
        details.append(
            f"{NOT_REAL_POPULATION}: baseline {baseline.gate_population}, candidate {candidate.gate_population}"
        )
    if not same_manifest:
        reasons.append(MANIFEST_MISMATCH)
        details.append(f"{MANIFEST_MISMATCH}: golden_sha256 or golden_filter differs")
    if reasons:
        return finish(reasons, details)

    split = baseline.golden_filter.gate_split
    base_items = {item.item_id: item for item in report_gate_items(baseline.items, split, REAL, population)}
    cand_items = report_gate_items(candidate.items, split, REAL, population)
    cand_ids = {item.item_id for item in cand_items}
    if not base_items or not cand_items:
        return finish([NO_GATED_ITEMS], [f"{NO_GATED_ITEMS}: no real items in the gated split"])
    if cand_ids != set(base_items) or len(cand_ids) != len(cand_items):
        missing, extra = len(set(base_items) - cand_ids), len(cand_ids - set(base_items))
        return finish([ITEM_SET_MISMATCH], [f"{ITEM_SET_MISMATCH}: {missing} only in baseline, {extra} only in candidate"])

    for slice_name, members in sorted(_slice_members(cand_items).items()):
        for metric, direction in noise.metrics.items():
            differences = _differences(base_items, members, metric)
            if not differences:
                continue
            mean_d = math.fsum(differences) / len(differences)
            dropped = mean_d < -noise.floor if direction == "higher" else mean_d > noise.floor
            if dropped:
                reasons.append(slice_reason(slice_name))
                details.append(
                    f"{SLICE_REGRESSION}:{slice_name}:{metric} mean_d={mean_d:+.4f} band={noise.floor:.4f} n={len(differences)}"
                )

    target_differences = _differences(base_items, cand_items, target)
    if not target_differences:
        reasons.append(TARGET_NOT_SCORED)
        details.append(f"{TARGET_NOT_SCORED}: no item scores {target}")
        return finish(reasons, details)
    delta = math.fsum(target_differences) / len(target_differences)
    low, high = bootstrap_interval(target_differences, seed=seed, resamples=resamples)
    improved = low > 0 if noise.metrics[target] == "higher" else high < 0
    if not improved:
        reasons.append(TARGET_NOT_IMPROVED)
        details.append(f"{TARGET_NOT_IMPROVED}: {target} delta={delta:+.4f} ci95=[{low:+.4f}, {high:+.4f}]")
    return finish(reasons, details, target_delta=delta, ci_low=low, ci_high=high)


def _read_report(path: Path) -> tuple[EvalReport, str]:
    raw = path.read_bytes()
    return EvalReport.model_validate_json(raw), hashlib.sha256(raw).hexdigest()


def default_out_path(now: datetime) -> Path:
    return writer.PRIVATE_DIR / SHIP_SUBDIR / f"ship-check-{file_stamp(now)}.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.ship_check", description="D-24 ship rule on the real domain test set")
    parser.add_argument("--baseline", required=True, type=Path, help="EvalReport of the current configuration")
    parser.add_argument("--candidate", required=True, type=Path, help="EvalReport of the configuration to ship")
    parser.add_argument("--target", required=True, help="metric that must improve, e.g. recall_at_5")
    parser.add_argument("--resamples", type=int, default=DEFAULT_RESAMPLES)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--noise", type=Path, default=None, help="default: eval/config/noise.json")
    parser.add_argument("--gate-population", type=Path, default=None, help="default: eval/config/gate-population.json")
    parser.add_argument("--out", type=Path, default=None, help="default: eval/golden/private/ship/ship-check-<stamp>.json")
    args = parser.parse_args(argv)

    try:
        out = assert_private_path(resolve_cli_path(args.out) if args.out else default_out_path(datetime.now(UTC)))
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE

    try:
        if args.resamples < 1:
            raise ValueError("--resamples must be at least 1")
        baseline, baseline_hash = _read_report(resolve_cli_path(args.baseline))
        candidate, candidate_hash = _read_report(resolve_cli_path(args.candidate))
        noise_path = resolve_cli_path(args.noise) if args.noise else DEFAULT_NOISE_PATH
        noise = NoiseConfig.model_validate_json(noise_path.read_text(encoding="utf-8"))
        population, _ = load_gate_population(resolve_cli_path(args.gate_population) if args.gate_population else None)
        result, details = run_ship_check(
            baseline,
            candidate,
            args.target,
            noise=noise,
            population=population,
            baseline_hash=baseline_hash,
            candidate_hash=candidate_hash,
            seed=args.seed,
            resamples=args.resamples,
        )
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INPUT

    try:
        write_text(out, result.model_dump_json(indent=2) + "\n")
    except PrivatePathError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PRIVATE

    interval = "n/a" if result.ci_low is None else f"[{result.ci_low:+.4f}, {result.ci_high:+.4f}]"
    print(f"[Ship Check] {'PASS' if result.passed else 'FAIL'} target={result.target_metric} ci95={interval} -> {out.name}")
    for reason in result.reasons:
        print(f"reason: {reason}")
    for line in details:
        print(f"  {line}")
    return EXIT_OK if result.passed else EXIT_FAIL


if __name__ == "__main__":
    raise SystemExit(main())
