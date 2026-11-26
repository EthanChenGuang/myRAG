"""python -m rag_eval.finetune import-mined (stub)."""
from dataclasses import dataclass

from pydantic import BaseModel

PAIRS_FILE = "pairs.mined.jsonl"
REPORT_FILE = "mined-report.json"


class MinedImportReport(BaseModel):
    input_rows: int = 0
    kept: int = 0
    dropped: dict[str, int] = {}
    by_split: dict[str, int] = {}
    held_out: int = 0
    cluster_promoted: int = 0
    judge: str = "skipped"


@dataclass
class MinedResult:
    exit_code: int
    report: MinedImportReport | None = None


def cluster_queries(rows, *, ngram=3, threshold=0.8):
    return list(range(len(rows)))


def strictest_split(splits):
    return "train"


def run_import_mined(run_dir, input_path, **kwargs):
    return MinedResult(0, MinedImportReport())


def main(argv=None):
    return 0
