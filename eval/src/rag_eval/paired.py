import argparse
from pathlib import Path

from rag_sidecar.contracts.baseline import Baseline, NoiseConfig, PairedReport
from rag_sidecar.contracts.report import EvalReport, ItemResult

SEED = 20261123
RESAMPLES = 10000


def item_metrics(item: ItemResult) -> dict[str, float | None]:
    return {name: None for name in ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")}


def paired_report(report: EvalReport, baseline: Baseline, noise: NoiseConfig) -> PairedReport | None:
    return PairedReport(seed=0, resamples=1, all_zero=False, slices={})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_eval.paired")
    for flag in ("--report", "--baseline", "--noise", "--out"):
        parser.add_argument(flag, required=True, type=Path)
    parser.parse_args(argv)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
