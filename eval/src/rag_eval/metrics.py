from collections.abc import Callable, Iterable
from typing import Literal

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult, MetricValue, SliceMetrics

from rag_eval.matching import chunk_matches_span

_RECALL_FIELDS = {5: "spans_hit_at_5", 10: "spans_hit_at_10"}
CROSS_LINGUAL = "cross_lingual"


def language_pair_key(language: str, evidence_language: str) -> str:
    return f"{language}->{evidence_language}"


def _pair_members(results: Iterable[ItemResult]) -> list[ItemResult]:
    return [r for r in results if r.category == CROSS_LINGUAL and r.evidence_language is not None]


def _first_rank_per_span(trace: RagTrace, item: GoldenItem, *, ranked) -> list[int | None]:
    ranks: list[int | None] = []
    for span in item.gold_evidence:
        rank = None
        for position, chunk in enumerate(ranked, start=1):
            document_name = getattr(chunk, "document_name", None) or ""
            if chunk_matches_span(document_name, chunk.content, span):
                rank = position
                break
        ranks.append(rank)
    return ranks


def score_items(traces: list[RagTrace], golden: list[GoldenItem], *, rank_field: Literal["kept", "candidates"] = "kept") -> list[ItemResult]:
    by_id: dict[str, RagTrace] = {}
    for trace in traces:
        if trace.item_id is None:
            continue
        if trace.item_id in by_id:
            raise ValueError(f"duplicate trace for item {trace.item_id!r}")
        by_id[trace.item_id] = trace

    results: list[ItemResult] = []
    for item in golden:
        trace = by_id.get(item.id)
        if trace is None:
            raise ValueError(f"no trace for golden item {item.id!r}")
        ranked = trace.kept if rank_field == "kept" else trace.candidates
        ranks = [] if trace.refused else [r for r in _first_rank_per_span(trace, item, ranked=ranked) if r is not None]
        results.append(
            ItemResult(
                item_id=item.id,
                language=item.language,
                category=item.category,
                evidence_language=item.evidence_language,
                split=item.split,
                provenance=item.provenance,
                answerable=item.answerable,
                refused=trace.refused,
                span_count=len(item.gold_evidence),
                spans_hit_at_5=sum(1 for r in ranks if r <= 5),
                spans_hit_at_10=sum(1 for r in ranks if r <= 10),
                first_hit_rank=min(ranks) if ranks else None,
            )
        )
    return results


def _mean(values: list[float]) -> MetricValue:
    return MetricValue(value=sum(values) / len(values) if values else None, n=len(values))


def _slice(results: list[ItemResult]) -> SliceMetrics:
    answerable = [r for r in results if r.answerable]
    unanswerable = [r for r in results if not r.answerable]

    def recall(k: int) -> MetricValue:
        field = _RECALL_FIELDS[k]
        return _mean([getattr(r, field) / r.span_count for r in answerable])

    return SliceMetrics(
        recall_at_5=recall(5),
        recall_at_10=recall(10),
        mrr=_mean([1 / r.first_hit_rank if r.first_hit_rank else 0.0 for r in answerable]),
        correct_refusal_rate=_mean([1.0 if r.refused else 0.0 for r in unanswerable]),
        false_refusal_rate=_mean([1.0 if r.refused else 0.0 for r in answerable]),
    )


def _group(results: Iterable[ItemResult], key: Callable[[ItemResult], str]) -> dict[str, SliceMetrics]:
    groups: dict[str, list[ItemResult]] = {}
    for result in results:
        groups.setdefault(key(result), []).append(result)
    return {name: _slice(members) for name, members in sorted(groups.items())}


def aggregate(
    results: list[ItemResult],
    k_values: tuple[int, ...] = (5, 10),
    gate_split: str = "dev",
    approved_ids: frozenset[str] | None = None,
) -> dict[str, object]:
    if tuple(k_values) != (5, 10):
        raise ValueError(f"unsupported k_values {tuple(k_values)!r}: the report contract carries recall@5 and recall@10")
    gated = [r for r in results if r.split == gate_split]
    production = [
        r for r in gated if r.provenance == "production" and (approved_ids is None or r.item_id in approved_ids)
    ]
    population = production or gated
    return {
        "overall": _slice(population),
        "by_language": _group(population, lambda r: r.language),
        "by_category": _group(population, lambda r: r.category),
        "by_language_category": _group(gated, lambda r: f"{r.language}/{r.category}"),
        "by_language_pair": _group(
            _pair_members(population), lambda r: language_pair_key(r.language, r.evidence_language or "")
        ),
        "by_split": _group(results, lambda r: r.split),
        "by_provenance": _group(gated, lambda r: r.provenance),
        "by_provenance_category": _group(gated, lambda r: f"{r.provenance}/{r.category}"),
        "gate_population": "production" if production else "all",
    }
