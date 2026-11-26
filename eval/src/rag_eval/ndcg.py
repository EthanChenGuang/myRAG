from __future__ import annotations

import math

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem

from rag_eval.matching import chunk_matches_span


def ndcg_at_context_k(first_hit_positions: list[int | None], k: int) -> float:
    """Binary-relevance nDCG over the k chunks sent to the model (D-07).

    `first_hit_positions` holds one entry per gold unit: the 1-based position in the kept list
    (rank order) of the first chunk that matches it, or None. Each unit earns one credit.
    """
    if k <= 0 or not first_hit_positions:
        return 0.0
    dcg = sum(1 / math.log2(pos + 1) for pos in first_hit_positions if pos is not None and pos <= k)
    ideal = sum(1 / math.log2(i + 1) for i in range(1, min(len(first_hit_positions), k) + 1))
    return dcg / ideal


def gold_unit_first_hits(trace: RagTrace, item: GoldenItem) -> list[int | None]:
    """First kept position per gold unit: a span, or an evidence group when the item has groups (D-50)."""
    ranked = sorted(trace.kept, key=lambda chunk: chunk.rank)
    span_hits: list[int | None] = []
    for span in item.gold_evidence:
        found = None
        for position, chunk in enumerate(ranked, start=1):
            if chunk_matches_span(chunk.document_name or "", chunk.content, span):
                found = position
                break
        span_hits.append(found)
    if item.evidence_groups is None:
        return span_hits
    return [
        min((span_hits[index] for index in group if span_hits[index] is not None), default=None)
        for group in item.evidence_groups
    ]
