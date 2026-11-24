from collections.abc import Callable, Iterable, Mapping
from typing import Literal

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult, MetricValue, QuestionKind, SliceMetrics

from rag_eval.bounds import upper_bound
from rag_eval.matching import chunk_matches_span

_RECALL_FIELDS = {5: "spans_hit_at_5", 10: "spans_hit_at_10"}
CROSS_LINGUAL = "cross_lingual"
GENERAL_DOC_TYPE = "general"
LEXICAL_LEG = "lexical"
LEXICAL_TOP_N = 10
RERANK_STAGE = "rerank"
RERANK_NOT_ATTEMPTED = "disabled"
RERANK_SKIPPED = frozenset({"skipped", "timeout"})
CLAUSE_TAG = "clause"
_FACT_LOOKUP_CATEGORIES = frozenset({"exact_term", "general", "table"})
_CONTEXT_HEAVY_CATEGORIES = frozenset({"compound", "multi_turn"})


def question_kind(category: str, tags: Iterable[str]) -> QuestionKind:
    if CLAUSE_TAG in tags or category in _CONTEXT_HEAVY_CATEGORIES:
        return "context_heavy"
    if category in _FACT_LOOKUP_CATEGORIES:
        return "fact_lookup"
    return "other"


def _doc_type(item: GoldenItem, doc_types: Mapping[str, str] | None) -> str:
    if not doc_types or not item.gold_evidence:
        return GENERAL_DOC_TYPE
    return doc_types.get(item.gold_evidence[0].document.casefold()) or GENERAL_DOC_TYPE


def _lexical_leg_ran(trace: RagTrace) -> bool:
    if LEXICAL_LEG in trace.stage_counts.get("search", {}):
        return True
    return any(LEXICAL_LEG in candidate.legs for candidate in trace.candidates)


def _lexical_hit(trace: RagTrace, item: GoldenItem, *, leg_ran: bool) -> bool | None:
    if not item.answerable or not leg_ran:
        return None
    for candidate in trace.candidates:
        rank = candidate.legs.get(LEXICAL_LEG)
        if rank is None or rank > LEXICAL_TOP_N:
            continue
        name = candidate.document_name or ""
        if any(chunk_matches_span(name, candidate.content, span) for span in item.gold_evidence):
            return True
    return False


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


def score_items(
    traces: list[RagTrace],
    golden: list[GoldenItem],
    *,
    rank_field: Literal["kept", "candidates"] = "kept",
    doc_types: Mapping[str, str] | None = None,
) -> list[ItemResult]:
    by_id: dict[str, RagTrace] = {}
    for trace in traces:
        if trace.item_id is None:
            continue
        if trace.item_id in by_id:
            raise ValueError(f"duplicate trace for item {trace.item_id!r}")
        by_id[trace.item_id] = trace

    folded_doc_types = {name.casefold(): kind for name, kind in doc_types.items()} if doc_types else None
    leg_ran = any(_lexical_leg_ran(trace) for trace in by_id.values())

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
                doc_type=_doc_type(item, folded_doc_types),
                question_kind=question_kind(item.category, item.tags),
                rerank_status=trace.stage_status.get(RERANK_STAGE),
                lexical_hit_at_10=_lexical_hit(trace, item, leg_ran=leg_ran),
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
        false_refusal_upper_95=upper_bound(sum(1 for r in answerable if r.refused), len(answerable)),
    )


def _group(results: Iterable[ItemResult], key: Callable[[ItemResult], str]) -> dict[str, SliceMetrics]:
    groups: dict[str, list[ItemResult]] = {}
    for result in results:
        groups.setdefault(key(result), []).append(result)
    return {name: _slice(members) for name, members in sorted(groups.items())}


def _rerank_skipped_rate(results: list[ItemResult]) -> MetricValue:
    attempted = [r for r in results if r.rerank_status not in (None, RERANK_NOT_ATTEMPTED)]
    return _mean([1.0 if r.rerank_status in RERANK_SKIPPED else 0.0 for r in attempted])


def _lexical_leg_hit_rate(results: list[ItemResult]) -> MetricValue:
    return _mean([1.0 if r.lexical_hit_at_10 else 0.0 for r in results if r.lexical_hit_at_10 is not None])


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
        "by_doc_type": _group(population, lambda r: r.doc_type or GENERAL_DOC_TYPE),
        "by_question_kind": _group(population, lambda r: r.question_kind or question_kind(r.category, [])),
        "rerank_skipped_rate": _rerank_skipped_rate(population),
        "lexical_leg_hit_rate_at_10": _lexical_leg_hit_rate(population),
        "by_split": _group(results, lambda r: r.split),
        "by_provenance": _group(gated, lambda r: r.provenance),
        "by_provenance_category": _group(gated, lambda r: f"{r.provenance}/{r.category}"),
        "gate_population": "production" if production else "all",
    }
