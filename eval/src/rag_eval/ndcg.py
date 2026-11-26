from __future__ import annotations

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem


def ndcg_at_context_k(first_hit_positions: list[int | None], k: int) -> float:
    return 0.0


def gold_unit_first_hits(trace: RagTrace, item: GoldenItem) -> list[int | None]:
    return []
