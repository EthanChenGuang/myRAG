"""D-19, D-49: duplicate-cluster threshold calibration (stub)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from rag_eval.paths import REPO_ROOT

PARAMS_PATH = REPO_ROOT / "eval/config/dup-cluster-params.json"
DEFAULT_OUT = REPO_ROOT / "eval/out/calibrate-dup-clusters"


class CalibrationError(RuntimeError):
    """Usage error: the run cannot start or must not write."""


@dataclass(frozen=True)
class DupPair:
    tenant: str
    embedding_profile_id: str
    chunk_a: str
    chunk_b: str
    hamming: int | None
    cosine: float | None
    same_template: bool


def fit_dup_threshold(pairs, bounds=(0.0, 1.0)):
    return None


def run_dup_cluster_calibration(out, **kwargs):
    return None


REPORT_NAME = "dup-cluster-calibration.md"
RESULT_NAME = "dup-cluster-calibration.json"


def load_pairs(path):
    return []
