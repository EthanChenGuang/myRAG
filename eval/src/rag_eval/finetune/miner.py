"""python -m rag_eval.finetune mine (stub)."""
from dataclasses import dataclass, field

QUERY_BLOCK = 1024


@dataclass
class MineResult:
    exit_code: int
    report: object = None
    pairs: list = field(default_factory=list)


def near_duplicate_clusters(texts, *, ngram, threshold):
    return list(range(len(texts)))


def mine_vectors(pairs, chunks, encoder, params, **_):
    return list(pairs)


def run_mine(run_dir, **_):
    return MineResult(0)


def main(argv=None, **_):
    return 0
