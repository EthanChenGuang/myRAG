"""D-21, D-48: MMR lambda sweep (stub)."""

from __future__ import annotations

from typing import Any

LAMBDA_GRID = (0.5, 0.6, 0.7, 0.8, 0.9)
CHOICE_RULE = ""


def choose_lambda(cells, reference, noise):
    return None


def run_diversity_sweep(*args: Any, **kwargs: Any):
    return None


def register(commands: Any) -> None:
    return None


PARAMS_PATH = None
REPORT_NAME = "diversity-sweep.md"
RESULT_NAME = "diversity-sweep.json"


def cell_from_report(mmr_lambda, report, out_dir):
    return None
