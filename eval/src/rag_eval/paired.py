import argparse
import math
import random
import sys
from pathlib import Path

from pydantic import ValidationError
from rag_sidecar.contracts.baseline import Baseline, NoiseConfig, PairedReport, PairedStat
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from rag_sidecar.contracts.report import EvalReport, ItemResult

from rag_eval.metrics import CROSS_LINGUAL, language_pair_key
from rag_eval.paths import resolve_cli_path

SEED = 20261123
RESAMPLES = 10000
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
EXIT_OK = 0
EXIT_INVALID = 2


def item_metrics(item: ItemResult) -> dict[str, float | None]:
    if item.answerable:
        return {
            "recall_at_5": item.spans_hit_at_5 / item.span_count,
            "recall_at_10": item.spans_hit_at_10 / item.span_count,
            "mrr": 1 / item.first_hit_rank if item.first_hit_rank else 0.0,
            "correct_refusal_rate": None,
            "false_refusal_rate": 1.0 if item.refused else 0.0,
        }
    return {
        "recall_at_5": None,
        "recall_at_10": None,
        "mrr": None,
        "correct_refusal_rate": 1.0 if item.refused else 0.0,
        "false_refusal_rate": None,
    }


def is_gated_slice(slice_name: str, noise: NoiseConfig) -> bool:
    return any(
        slice_name == prefix if not prefix.endswith(":") else slice_name.startswith(prefix)
        for prefix in noise.gated_slice_prefixes
    )


def _baseline_value(runs: list[float | None] | None) -> float | None:
    present = [value for value in runs or [] if value is not None]
    if not present:
        return None
    if all(value == present[0] for value in present):
        return present[0]
    return math.fsum(present) / len(present)


def _bootstrap_interval(differences: list[float]) -> tuple[float, float]:
    if all(d == 0 for d in differences):
        return 0.0, 0.0
    rng = random.Random(SEED)
    n = len(differences)
    means = sorted(math.fsum(differences[i] for i in rng.choices(range(n), k=n)) / n for _ in range(RESAMPLES))
    return means[math.ceil(RESAMPLES * 0.025) - 1], means[math.ceil(RESAMPLES * 0.975) - 1]


def _stat(differences: list[float]) -> PairedStat:
    if not differences:
        return PairedStat(n=0, n_nonzero=0, mean_d=None, ci_low=None, ci_high=None)
    low, high = _bootstrap_interval(differences)
    return PairedStat(
        n=len(differences),
        n_nonzero=sum(1 for d in differences if d != 0),
        mean_d=math.fsum(differences) / len(differences),
        ci_low=low,
        ci_high=high,
    )


def _slice_members(items: list[ItemResult]) -> dict[str, list[ItemResult]]:
    members: dict[str, list[ItemResult]] = {"overall": list(items)}
    for item in items:
        members.setdefault(f"language:{item.language}", []).append(item)
        members.setdefault(f"category:{item.category}", []).append(item)
        if item.category == CROSS_LINGUAL and item.evidence_language is not None:
            pair = language_pair_key(item.language, item.evidence_language)
            members.setdefault(f"pair:{pair}", []).append(item)
    return members


def paired_report(
    report: EvalReport, baseline: Baseline, noise: NoiseConfig, population: GatePopulationConfig | None = None
) -> PairedReport | None:
    if baseline.items is None:
        return None
    gated_items = [item for item in report.items if item.split == report.golden_filter.gate_split]
    if report.gate_population == "production":
        gated_items = [item for item in gated_items if item.provenance == "production"]
    slices: dict[str, dict[str, PairedStat]] = {}
    for slice_name, members in sorted(_slice_members(gated_items).items()):
        if not is_gated_slice(slice_name, noise):
            continue
        stats: dict[str, PairedStat] = {}
        for metric in METRICS:
            differences: list[float] = []
            for item in members:
                observed = item_metrics(item)[metric]
                recorded = _baseline_value(baseline.items.get(item.item_id, {}).get(metric))
                if observed is None or recorded is None:
                    continue
                differences.append(observed - recorded)
            stats[metric] = _stat(differences)
        slices[slice_name] = stats
    cells = [stat for stats in slices.values() for stat in stats.values()]
    all_zero = any(stat.n for stat in cells) and all(stat.n_nonzero == 0 for stat in cells)
    return PairedReport(seed=SEED, resamples=RESAMPLES, all_zero=all_zero, slices=slices)


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.paired", description="myRAG eval paired-difference report")
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--noise", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        report = EvalReport.model_validate_json(resolve_cli_path(args.report).read_text(encoding="utf-8"))
        baseline = Baseline.model_validate_json(resolve_cli_path(args.baseline).read_text(encoding="utf-8"))
        noise = NoiseConfig.model_validate_json(resolve_cli_path(args.noise).read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID

    paired = paired_report(report, baseline, noise)
    if paired is None:
        print("error: the baseline has no per-item rows; re-record it: npm run eval:baseline", file=sys.stderr)
        return EXIT_INVALID
    _write_text(resolve_cli_path(args.out), paired.model_dump_json(indent=2) + "\n")
    print(f"paired: {'ALL ZERO' if paired.all_zero else 'DIFFERENCES PRESENT'} (seed {paired.seed}, {paired.resamples} resamples)")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
