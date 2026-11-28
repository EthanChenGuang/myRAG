"""ADM-02: cost, latency and per-language quality blocks of the release defaults record (DefaultsDecision).

Every amount follows fixed rules: a quantity a run did not record is None with reason not_measured, a measured quantity
without a unit price is None with reason not_provided, and nothing is guessed. Prices come from
config/rag/price-table.json; the basis records its sha256 and the sample sizes. The regression CLI calls
annotate_record from `annotate` and from `decide`.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.latency import LatencyBudgets
from rag_sidecar.contracts.release import (
    CostAmount,
    CostBasis,
    CostPer1000,
    CostSummary,
    DefaultsDecision,
    IngestCostParts,
    LanguageQuality,
    LatencyEntry,
    LatencySummary,
    LatencyValue,
    QueryCostParts,
    RegressionPlan,
)
from rag_sidecar.contracts.report import EvalReport

from rag_eval.paths import REPO_ROOT
from rag_eval.regression_rules import (
    JUDGE_PRIMARY,
    LATENCY_CHANNELS,
    PAIR_METRICS,
    PAIR_PRIMARY,
    RuleSettings,
    RunSummary,
    band,
)
from rag_eval.report import RETRIEVAL_TOTAL

PRICE_TABLE_PATH = REPO_ROOT / "config" / "rag" / "price-table.json"
INGEST_LEDGER_FILE = "ingest-ledger.json"
INGEST_USAGE_FILE = "ingest-usage.json"
NOT_MEASURED = "not_measured"
NOT_PROVIDED = "not_provided"
TOO_SMALL = "too_small"
INCUMBENT_BACKEND = "pgvector"
FREE_RERANKERS = frozenset({"none", "local_bm25"})
# The query group of eval/config/latency-budgets.json is report-only until live measurements ratify it (AGENTS.md).
REPORT_ONLY_STAGES = frozenset({"query_gate", "condense", "translate", "expand", "decompose", "hyde", "normalize_dates"})
PRICE_UNITS = frozenset({"usd_per_million_tokens", "usd_per_page", "usd_per_call", "usd_per_point", "usd_per_request"})


class PriceTableError(ValueError):
    pass


@dataclass(frozen=True)
class PriceTable:
    prices: Mapping[str, float | None]
    sha256: str

    def price(self, key: str) -> float | None:
        return self.prices.get(key)


def load_price_table(path: Path = PRICE_TABLE_PATH) -> PriceTable:
    raw = path.read_bytes()
    try:
        payload = json.loads(raw)
        entries = payload["entries"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise PriceTableError(f"{path} is not a price table: {exc}") from exc
    prices: dict[str, float | None] = {}
    for entry in entries:
        key = entry.get("id")
        if not isinstance(key, str) or not key or key in prices:
            raise PriceTableError(f"price entry ids must be distinct non-empty strings: {key!r}")
        if entry.get("unit") not in PRICE_UNITS:
            raise PriceTableError(f"{key}: unknown unit {entry.get('unit')!r}")
        try:
            date.fromisoformat(str(entry.get("as_of")))
        except ValueError as exc:
            raise PriceTableError(f"{key}: as_of must be an ISO date") from exc
        usd = entry.get("usd")
        if usd is not None:
            if isinstance(usd, bool) or not isinstance(usd, (int, float)) or not math.isfinite(usd) or usd < 0:
                raise PriceTableError(f"{key}: usd must be null or a finite number >= 0")
            usd = float(usd)
        prices[key] = usd
    return PriceTable(prices=prices, sha256=hashlib.sha256(raw).hexdigest())


def _check_quantity(name: str, value: float | None) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite number >= 0, got {value!r}")


def _amount(usd: float | None, reason: str | None) -> CostAmount:
    return CostAmount(usd=usd, reason=None if usd is not None else reason)


def _not_measured() -> CostAmount:
    return CostAmount(usd=None, reason=NOT_MEASURED)


def _priced(quantity: float | None, unit_price: float | None, scale: float) -> CostAmount:
    """quantity x unit_price x scale; not_measured before not_provided; a zero quantity costs zero whatever the price."""
    _check_quantity("quantity", quantity)
    if quantity is None:
        return _not_measured()
    if quantity == 0:
        return CostAmount(usd=0.0)
    if unit_price is None:
        return CostAmount(usd=None, reason=NOT_PROVIDED)
    return CostAmount(usd=quantity * unit_price * scale)


# ---------------------------------------------------------------- ingest


@dataclass(frozen=True)
class IngestDocument:
    """One ingested document: page count and tier, and the est_cost of every recorded ledger attempt (None: no ledger)."""

    pages: int | None = None
    tier: str | None = None
    attempt_costs: tuple[float, ...] | None = None


@dataclass(frozen=True)
class IngestUsage:
    embedding_tokens: int | None = None
    enrichment_tokens: int | None = None
    stored_points: int | None = None


@dataclass(frozen=True)
class IngestCost:
    row: CostPer1000
    documents: int
    estimated: bool


def _parse_cost(documents: Sequence[IngestDocument], prices: PriceTable, scale: float) -> tuple[CostAmount, bool]:
    total = 0.0
    estimated = False
    missing_price = False
    for document in documents:
        _check_quantity("pages", document.pages)
        if document.attempt_costs is not None:
            for cost in document.attempt_costs:
                _check_quantity("est_cost", cost)
            total += math.fsum(document.attempt_costs)
            continue
        if document.pages is None or document.tier is None:
            return _not_measured(), estimated
        if document.pages == 0:
            continue
        unit = prices.price(f"parse:{document.tier}")
        if unit is None:
            missing_price = True
            continue
        total += document.pages * unit
        estimated = True
    if missing_price:
        return CostAmount(usd=None, reason=NOT_PROVIDED), estimated
    return CostAmount(usd=total * scale), estimated


def ingest_cost_per_1000(
    embedding_profile: str,
    backend: str,
    documents: Sequence[IngestDocument],
    usage: IngestUsage,
    prices: PriceTable,
) -> IngestCost:
    """Cost per 1,000 documents ingested for one embedding profile and backend; the four parts stay separate."""
    count = len(documents)
    if count == 0:
        parts = IngestCostParts(
            parse=_not_measured(),
            embedding=_not_measured(),
            enrichment=_not_measured(),
            external_store=CostAmount(usd=0.0) if backend == INCUMBENT_BACKEND else _not_measured(),
        )
        return IngestCost(CostPer1000(embedding_profile=embedding_profile, backend=backend, documents=parts), 0, False)
    scale = 1000.0 / count
    parse, estimated = _parse_cost(documents, prices, scale)
    per_million = scale / 1_000_000
    store = (
        CostAmount(usd=0.0)
        if backend == INCUMBENT_BACKEND
        else _priced(usage.stored_points, prices.price(f"store_point:{backend}"), scale)
    )
    parts = IngestCostParts(
        parse=parse,
        embedding=_priced(usage.embedding_tokens, prices.price(f"embedding:{embedding_profile}"), per_million),
        enrichment=_priced(usage.enrichment_tokens, prices.price("enrichment:tokens"), per_million),
        external_store=store,
    )
    return IngestCost(CostPer1000(embedding_profile=embedding_profile, backend=backend, documents=parts), count, estimated)


# ---------------------------------------------------------------- queries


def rerank_provider(env: Mapping[str, str]) -> str:
    provider = env.get("RAG_RERANKER", "none")
    if provider == "auto":
        return "cohere" if env.get("COHERE_API_KEY") else "local_bm25"
    return provider


def _rerank_called(trace: RagTrace) -> bool:
    status = trace.stage_status.get("rerank")
    return "rerank" in trace.stage_latency_ms and status in (None, "ok", "degraded")


def query_cost_per_1000(
    config_name: str,
    env: Mapping[str, str],
    backend: str,
    traces: Sequence[RagTrace],
    prices: PriceTable,
    *,
    query_embedding_tokens: int | None = None,
    embedding_profile: str | None = None,
) -> CostPer1000:
    """Cost per 1,000 queries: the mean per-query cost of the run's traces times 1,000, four parts kept separate."""
    count = len(traces)
    if count == 0:
        parts = QueryCostParts(
            query_embedding=_not_measured(), rerank=_not_measured(), generation=_not_measured(), external_store=_not_measured()
        )
        return CostPer1000(config_name=config_name, queries=parts)
    scale = 1000.0 / count
    per_million = scale / 1_000_000
    embedding_price = prices.price(f"embedding:{embedding_profile}") if embedding_profile else None
    provider = rerank_provider(env)
    calls = sum(1 for trace in traces if _rerank_called(trace))
    rerank = CostAmount(usd=0.0) if provider in FREE_RERANKERS else _priced(calls, prices.price(f"rerank:{provider}"), scale)
    usages = [trace.usage for trace in traces if trace.usage is not None]
    if not usages:
        generation = _not_measured()
    else:
        tokens_in = sum(usage.input_tokens for usage in usages)
        tokens_out = sum(usage.output_tokens for usage in usages)
        price_in, price_out = prices.price("generation:input"), prices.price("generation:output")
        if tokens_in + tokens_out == 0:
            generation = CostAmount(usd=0.0)
        elif (tokens_in and price_in is None) or (tokens_out and price_out is None):
            generation = CostAmount(usd=None, reason=NOT_PROVIDED)
        else:
            generation = CostAmount(usd=(tokens_in * (price_in or 0.0) + tokens_out * (price_out or 0.0)) * per_million)
    if backend == INCUMBENT_BACKEND:
        store = CostAmount(usd=0.0)
    else:
        requests = sum(
            1
            for trace in traces
            if trace.retrieval_backend is not None
            and trace.retrieval_backend.backend == backend
            and trace.retrieval_backend.fallback_reason is None
        )
        store = _priced(requests, prices.price(f"store_request:{backend}"), scale)
    parts = QueryCostParts(
        query_embedding=_priced(query_embedding_tokens, embedding_price, per_million),
        rerank=rerank,
        generation=generation,
        external_store=store,
    )
    return CostPer1000(config_name=config_name, queries=parts)


# ---------------------------------------------------------------- latency


def _within(p50: float | None, p95: float | None, b50: float | None, b95: float | None) -> bool | None:
    checks = [observed <= budget for observed, budget in ((p50, b50), (p95, b95)) if observed is not None and budget is not None]
    return all(checks) if checks else None


def _value(stage: str, p50: float | None, p95: float | None, b50: float | None, b95: float | None) -> LatencyValue:
    return LatencyValue(
        stage=stage,
        p50_ms=p50,
        p95_ms=p95,
        budget_p50_ms=b50,
        budget_p95_ms=b95,
        within_budget=_within(p50, p95, b50, b95),
        report_only=stage in REPORT_ONLY_STAGES,
    )


def _channel_entry(config_name: str, channel: str, report: EvalReport, budgets: LatencyBudgets) -> LatencyEntry:
    profile = budgets.profiles.get(channel)
    pre_budget = (budgets.pre_generation or {}).get(channel)
    total_b95 = pre_budget.p95_ms if pre_budget is not None else (profile.total_p95_ms if profile else None)
    total_b50 = profile.total_p50_ms if profile else None
    pre = (report.pre_generation or {}).get(channel)
    stages = dict(report.latency or {}) if channel == "chat" else {}
    total = pre if pre is not None else (stages.get(RETRIEVAL_TOTAL) if channel == "chat" else None)
    values = [_value("total", total.p50_ms if total else None, total.p95_ms if total else None, total_b50, total_b95)]
    for stage in sorted(stages):
        if stage == RETRIEVAL_TOTAL:
            continue
        observed = stages[stage]
        budget = profile.stages.get(stage) if profile else None
        values.append(_value(stage, observed.p50_ms, observed.p95_ms, None, budget))
    return LatencyEntry(config_name=config_name, channel=channel, values=values)  # type: ignore[arg-type]


def latency_summary(reports: Mapping[str, EvalReport], budgets: LatencyBudgets, budgets_sha256: str) -> LatencySummary:
    """p50 and p95 of the total and of each stage, chat and voice, per configuration, next to the budgets."""
    entries = [
        _channel_entry(name, channel, report, budgets) for name, report in sorted(reports.items()) for channel in LATENCY_CHANNELS
    ]
    return LatencySummary(budgets_sha256=budgets_sha256, entries=entries)


# ---------------------------------------------------------------- per-language quality


def _language_items(summary: RunSummary, language: str) -> set[str]:
    return {item for item, slices in summary.slices.items() if f"language:{language}" in slices}


def _mean_metric(summary: RunSummary, metric: str, items: set[str]) -> float | None:
    values = [summary.metrics[item][metric] for item in sorted(items) if summary.metrics[item].get(metric) is not None]
    return math.fsum(values) / len(values) if values else None  # type: ignore[arg-type]


def _primary_value(summary: RunSummary, metrics: Sequence[str], items: set[str]) -> float | None:
    parts = [_mean_metric(summary, metric, items) for metric in metrics]
    present = [value for value in parts if value is not None]
    return math.fsum(present) / len(present) if present else None


def primary_parts(adopted: RunSummary, incumbent: RunSummary) -> tuple[str, tuple[str, ...]]:
    def has_judge(summary: RunSummary) -> bool:
        return any(row.get(JUDGE_PRIMARY) is not None for row in summary.metrics.values())

    if has_judge(adopted) and has_judge(incumbent):
        return JUDGE_PRIMARY, (JUDGE_PRIMARY,)
    return PAIR_PRIMARY, PAIR_METRICS


def run_languages(incumbent: RunSummary, env: Mapping[str, str] | None = None) -> list[str]:
    """The enabled languages: RAG_SUPPORTED_LANGUAGES of the run when set, else every language the run scored."""
    configured = (env or {}).get("RAG_SUPPORTED_LANGUAGES", "")
    codes = [code.strip() for code in configured.split(",") if code.strip()]
    if codes:
        return sorted(set(codes))
    return sorted({name.split(":", 1)[1] for slices in incumbent.slices.values() for name in slices if name.startswith("language:")})


def language_quality(
    adopted: RunSummary, incumbent: RunSummary, languages: Sequence[str], settings: RuleSettings
) -> list[LanguageQuality]:
    """ADM-02: per enabled language, the adopted run's primary metric against the incumbent's on the paired items."""
    metric, parts = primary_parts(adopted, incumbent)
    limit = max(band(settings, incumbent.spread.get(part, 0.0)) for part in parts)
    rows: list[LanguageQuality] = []
    for language in languages:
        items = _language_items(incumbent, language) & set(adopted.metrics) & set(incumbent.metrics)
        value = _primary_value(adopted, parts, items)
        baseline = _primary_value(incumbent, parts, items)
        difference = value - baseline if value is not None and baseline is not None else None
        if difference is None:
            below, reason = None, NOT_MEASURED
        elif len(items) < settings.min_gate_n:
            below, reason = None, TOO_SMALL
        else:
            below, reason = difference < -limit, None
        rows.append(
            LanguageQuality(
                language=language,
                metric=metric,
                n=len(items),
                value=value,
                baseline=baseline,
                difference=difference,
                band=limit,
                below_baseline=below,
                reason=reason,
            )
        )
    return rows


def languages_below_baseline(rows: Sequence[LanguageQuality]) -> list[str]:
    return [row.language for row in rows if row.below_baseline is True]


# ---------------------------------------------------------------- run inputs and the record


@dataclass(frozen=True)
class RunInputs:
    """What the cost and latency blocks read from one executed config."""

    name: str
    env: Mapping[str, str]
    backend: str
    embedding_profile: str
    report: EvalReport
    traces: Sequence[RagTrace]
    summary: RunSummary
    ingest_documents: Sequence[IngestDocument] | None = None
    ingest_usage: IngestUsage = field(default_factory=IngestUsage)


def _int_or_none(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def read_ingest_outputs(out_dir: Path) -> tuple[list[IngestDocument] | None, IngestUsage]:
    """The Phase 3.1 ingestion ledger (ingest-ledger.json, jobs with attempts) and recorded ingest counts, when a run kept them."""
    documents: list[IngestDocument] | None = None
    ledger_path = out_dir / INGEST_LEDGER_FILE
    if ledger_path.is_file():
        jobs = json.loads(ledger_path.read_text(encoding="utf-8")).get("jobs", [])
        documents = []
        for job in jobs:
            attempts = job.get("attempts") or []
            costs = [attempt.get("est_cost") for attempt in attempts if isinstance(attempt, Mapping)]
            recorded = tuple(float(cost) for cost in costs if isinstance(cost, (int, float)) and not isinstance(cost, bool))
            documents.append(
                IngestDocument(
                    pages=_int_or_none(job.get("pages")),
                    tier=job.get("tier") if isinstance(job.get("tier"), str) else None,
                    attempt_costs=recorded if attempts and len(recorded) == len(attempts) else None,
                )
            )
    usage = IngestUsage()
    usage_path = out_dir / INGEST_USAGE_FILE
    if usage_path.is_file():
        raw = json.loads(usage_path.read_text(encoding="utf-8"))
        usage = IngestUsage(
            embedding_tokens=_int_or_none(raw.get("embedding_tokens")),
            enrichment_tokens=_int_or_none(raw.get("enrichment_tokens")),
            stored_points=_int_or_none(raw.get("stored_points")),
        )
    return documents, usage


def cost_summary(runs: Mapping[str, RunInputs], decided: Sequence[str], prices: PriceTable) -> CostSummary:
    groups: dict[tuple[str, str], list[RunInputs]] = {}
    for name in sorted(runs):
        run = runs[name]
        groups.setdefault((run.embedding_profile, run.backend), []).append(run)
    ingest_rows: list[CostPer1000] = []
    document_sample = 0
    estimated = False
    for (profile, backend), members in sorted(groups.items()):
        source = next((run for run in members if run.ingest_documents is not None), members[0])
        cost = ingest_cost_per_1000(profile, backend, source.ingest_documents or (), source.ingest_usage, prices)
        ingest_rows.append(cost.row)
        document_sample = max(document_sample, cost.documents)
        estimated = estimated or cost.estimated
    query_rows = [
        query_cost_per_1000(
            name, runs[name].env, runs[name].backend, runs[name].traces, prices, embedding_profile=runs[name].embedding_profile
        )
        for name in decided
    ]
    query_sample = max((len(runs[name].traces) for name in decided), default=0)
    basis = CostBasis(
        price_table_sha256=prices.sha256,
        document_sample=document_sample,
        query_sample=query_sample,
        kind="estimated" if estimated else "measured",
    )
    return CostSummary(per_1000_documents=ingest_rows, per_1000_queries=query_rows, basis=basis)


def annotate_blocks(
    record: DefaultsDecision,
    runs: Mapping[str, RunInputs],
    *,
    incumbent_name: str,
    adopted_name: str,
    prices: PriceTable,
    budgets: LatencyBudgets,
    budgets_sha256: str,
    settings: RuleSettings,
) -> DefaultsDecision:
    """The record with its cost, latency and per_language blocks; validated again as a DefaultsDecision."""
    if incumbent_name not in runs or adopted_name not in runs:
        raise ValueError(f"annotation needs the runs {incumbent_name} and {adopted_name}")
    decided = list(dict.fromkeys([incumbent_name, adopted_name]))
    incumbent = runs[incumbent_name]
    per_language = language_quality(
        runs[adopted_name].summary, incumbent.summary, run_languages(incumbent.summary, incumbent.env), settings
    )
    update = {
        "cost": cost_summary(runs, decided, prices).model_dump(mode="json"),
        "latency": latency_summary({name: runs[name].report for name in decided}, budgets, budgets_sha256).model_dump(mode="json"),
        "per_language": [row.model_dump(mode="json") for row in per_language],
    }
    return DefaultsDecision.model_validate({**record.model_dump(mode="json"), **update})


def annotate_record(
    record: DefaultsDecision,
    plan: RegressionPlan,
    runs_dir: Path,
    price_table: PriceTable,
    budgets_path: Path,
    noise_path: Path,
) -> DefaultsDecision:
    """Read the stage-B run outputs named by the plan's run index and return the record with the three ADM-02 blocks."""
    from rag_eval import regression

    plan_sha = plan.canonical_sha256()
    index = regression.read_index(runs_dir, plan_sha)
    settings = regression._settings_for(plan, noise_path, budgets_path)
    budgets_raw = budgets_path.read_bytes()
    budgets = LatencyBudgets.model_validate_json(budgets_raw)
    runs = regression.load_run_inputs(index)
    return annotate_blocks(
        record,
        runs,
        incumbent_name=regression.INCUMBENT_CONFIG,
        adopted_name=regression.adopted_config_name(record, runs),
        prices=price_table,
        budgets=budgets,
        budgets_sha256=hashlib.sha256(budgets_raw).hexdigest(),
        settings=settings,
    )
