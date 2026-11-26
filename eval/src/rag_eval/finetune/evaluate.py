"""python -m rag_eval.finetune evaluate (stub; implemented in 06.1-13 Task 1)."""
from dataclasses import dataclass, field

from pydantic import BaseModel


class ZeroShotReport(BaseModel):
    pass


@dataclass
class EvaluateResult:
    exit_code: int
    report: object = None
    rankings: dict = field(default_factory=dict)


def ir_metrics(ranked, relevant, k=10):
    return {"recall_at_10": -1.0, "mrr_at_10": -1.0, "ndcg_at_10": -1.0}


def bootstrap_interval(differences, *, seed, resamples):
    return (1.0, -1.0)


def model_fingerprint(path):
    return ""


def run_evaluate(run_dir, **kwargs):
    return EvaluateResult(exit_code=99)


def main(argv=None, **kwargs):
    return 99
