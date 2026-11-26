import json
import math
import os
from pathlib import Path
from typing import get_args

from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.feedback_loop import GatePopulationConfig
from rag_sidecar.contracts.golden import GoldenItem, Provenance
from rag_sidecar.contracts.golden_lifecycle import GoldenSetManifest
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.latency import CacheState, GroupBudget, LatencyBudgets, StageLatency
from rag_sidecar.contracts.report import (
    BudgetedLatency,
    BudgetStatus,
    EvalReport,
    GroundednessLabelCounts,
    InjectionConfigLabel,
    InjectionReport,
    ItemResult,
    MetricValue,
    QueryLayerReport,
    SemanticCacheReport,
    SliceMetrics,
    StrategySlice,
    TableSplitSlice,
    TransformOutcomeCounts,
)

from rag_eval.metrics import (
    POPULATION_EXCLUSIONS,
    aggregate,
    citation_metrics,
    citation_run,
    groundedness_label_counts,
    injection_metrics,
    language_pair_key,
    population_exclusions,
    select_gate_population,
    slices_by,
    strategy_key,
    table_split_report,
)
from rag_eval.native_review import MIN_GATED_ITEMS, REVIEWED_LANGUAGES, counts_in_gated_slices, review_backlog
from rag_eval.paths import REPO_ROOT

K_VALUES = [5, 10]
PINNED_EVAL_ENV_PATH = REPO_ROOT / "eval" / "config" / "rag-eval-env.json"
SUPPORTED_LANGUAGES_VAR = "RAG_SUPPORTED_LANGUAGES"
CROSS_LINGUAL_CATEGORY = "cross_lingual"
LATENCY_BUDGETS_PATH = REPO_ROOT / "eval" / "config" / "latency-budgets.json"
LATENCY_PROFILE = "chat"
RETRIEVAL_TOTAL = "retrieval_total"
GENERATION_STAGE = "generation"
LATENCY_NOTE = (
    f"Report-only: the gate ignores these numbers. Percentiles are nearest-rank over n traces, compared with the "
    f"{LATENCY_PROFILE} budgets in eval/config/latency-budgets.json; {RETRIEVAL_TOTAL} sums every stage except "
    f"{GENERATION_STAGE}. Fixture latencies are not representative of production."
)

ZH_QUIRK_NOTE = (
    "Filter 1 Chinese empty-term quirk: the chat route's name/content filter derives an empty query term "
    "for Chinese queries, so every retrieved chunk passes Filter 1 and zh retrieval is not narrowed by it; "
    "zh slices can look better than en and it slices for that reason."
)
FALSE_REFUSAL_BOUND_LABEL = "False refusal upper 95"
BOUND_NOTE = (
    "False refusal upper 95 is the exact one-sided 95% Clopper-Pearson upper bound on the false-refusal rate of "
    "the slice (answerable items only); a point estimate at or below a target says nothing until this bound does too."
)
GATING_NOTE = (
    "Overall, language, language pair and category tables cover the dev split only. Categories are report-only "
    "except cross_lingual; only overall, per-language, cross_lingual and per-language-pair slices gate "
    "(D-20, D-41). The held-out test split is reported under By split and never gates (D-14)."
)

PRODUCTION_GATE_NOTE = (
    "Gate population is production: overall, language and category tables cover the approved production items "
    "of the gated split only; every other provenance is report-only under By provenance and By provenance and category."
)



def _join(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def real_gate_note(members: list[ItemResult], gate_split: str, population: GatePopulationConfig) -> str:
    """D-23: which items gated a real run; the provenances come from the loaded config only (D-29)."""
    per_language: dict[str, int] = {}
    for item in members:
        per_language[item.language] = per_language.get(item.language, 0) + 1
    counts = ", ".join(f"{code} {count}" for code, count in sorted(per_language.items()))
    report_only = [name for name in get_args(Provenance) if name not in population.provenances]
    tail = (
        f"; {_join(report_only)} items are report-only under By provenance and By provenance and category."
        if report_only
        else "."
    )
    return (
        f"Gate population is real: overall, language, language pair, category, document type and question kind "
        f"tables cover the {len(members)} approved item(s) of the {gate_split} split with provenances "
        f"{', '.join(population.provenances)} (per language: {counts}; min_items {population.min_items}){tail}"
    )


def gate_population_config_note(population: GatePopulationConfig, sha256: str) -> str:
    return (
        f"Gate population config: mode {population.mode}, provenances {', '.join(population.provenances)}, "
        f"min_items {population.min_items}, sha256 {sha256}."
    )


_METRIC_COLUMNS = (
    ("Recall@5", "recall_at_5"),
    ("Recall@10", "recall_at_10"),
    ("MRR", "mrr"),
    ("Correct refusal", "correct_refusal_rate"),
    ("False refusal", "false_refusal_rate"),
)


def _embedder_version(version: str | None) -> int | None:
    if version is None:
        return None
    try:
        return int(version)
    except ValueError:
        return None


def nearest_rank(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    rank = max(1, math.ceil(quantile * len(ordered)))
    return ordered[rank - 1]


def compute_latency(traces: list[RagTrace]) -> dict[str, StageLatency] | None:
    by_stage: dict[str, list[float]] = {}
    totals: list[float] = []
    for trace in traces:
        retrieval = 0.0
        has_retrieval_stage = False
        for stage, value in trace.stage_latency_ms.items():
            if not math.isfinite(value) or value < 0:
                continue
            by_stage.setdefault(stage, []).append(value)
            if stage != GENERATION_STAGE:
                retrieval += value
                has_retrieval_stage = True
        if has_retrieval_stage:
            totals.append(retrieval)
    if not by_stage:
        return None
    if totals:
        by_stage[RETRIEVAL_TOTAL] = totals
    return {
        stage: StageLatency(
            p50_ms=nearest_rank(values, 0.5), p95_ms=nearest_rank(values, 0.95), n=len(values)
        )
        for stage, values in sorted(by_stage.items())
    }


CACHE_STATES: tuple[CacheState, ...] = get_args(CacheState)
PRE_GENERATION_ROW = "pre-generation"
TTFT_NOTE = (
    "Report-only (D-25, D-27): TTFT is the server-side time to the first answer text delta, grouped by semantic cache "
    f"state; pre-generation is the time until the generator call starts. Percentiles are nearest-rank, compared with "
    f"the {LATENCY_PROFILE} ttft and pre_generation budgets in eval/config/latency-budgets.json. Traces without a cache "
    "state are left out of the TTFT rows."
)


def _finite(value: float | None) -> bool:
    return value is not None and math.isfinite(value) and value >= 0


def compute_ttft(traces: list[RagTrace]) -> dict[CacheState, StageLatency] | None:
    by_state: dict[str, list[float]] = {}
    seen = False
    for trace in traces:
        if not _finite(trace.ttft_ms):
            continue
        seen = True
        if trace.cache is not None:
            by_state.setdefault(trace.cache, []).append(float(trace.ttft_ms))
    if not seen:
        return None
    return {state: stat for state in CACHE_STATES if (stat := _latency_stat(by_state.get(state, [])))}


def compute_pre_generation(traces: list[RagTrace]) -> dict[str, StageLatency] | None:
    values = [float(trace.pre_generation_ms) for trace in traces if _finite(trace.pre_generation_ms)]
    stat = _latency_stat(values)
    return None if stat is None else {LATENCY_PROFILE: stat}


SCORING_SCORERS = ("hhem_2_1_open", "hhem_2_3_vectara")
FAITHFULNESS_METRIC = "faithfulness"
FAITHFULNESS_SKIPPED = "skipped"
FAITHFULNESS_SKIPPED_NOTE = (
    "Faithfulness per strategy: skipped, judge key not configured (the nightly judge tier writes judge.json; "
    "pass it with --judge)."
)
CITATIONS_NOTE = (
    "Report-only: computed over every scored item. invalid_citation_rate is the share of citation records whose "
    "alias does not label a block of that trace or whose chunk ids were not kept (must be 0); citation_coverage is "
    "the share of answered items with at least one valid citation; cited_gold_hit is the share of answered items "
    "with gold spans where a valid cited quote contains a gold span (D-13 match). Dropped markers are the raw "
    "invalid markers removed before display and do not count toward the invalid rate."
)
GROUNDEDNESS_NOTE = (
    "Report-only: groundedness runs after the stream, so its latency sits outside the pre-first-token total and "
    "never gates. Budgets come from the groundedness section of eval/config/latency-budgets.json."
)
STRATEGY_NOTE = (
    "Report-only: one row per citation strategy (none = no strategy, e.g. refused or ineligible items). "
    "Generation latency is the generation stage; Faithfulness is the mean per-item judge score over both libraries."
)


def _latency_stat(values: list[float]) -> StageLatency | None:
    if not values:
        return None
    return StageLatency(p50_ms=nearest_rank(values, 0.5), p95_ms=nearest_rank(values, 0.95), n=len(values))


def compute_groundedness_latency(traces: list[RagTrace]) -> dict[str, StageLatency]:
    by_scorer: dict[str, list[float]] = {}
    for trace in traces:
        result = trace.groundedness
        if result is None or result.scorer not in SCORING_SCORERS or result.latencyMs is None:
            continue
        by_scorer.setdefault(result.scorer, []).append(float(result.latencyMs))
    return {scorer: stat for scorer, values in sorted(by_scorer.items()) if (stat := _latency_stat(values))}


def _faithfulness_by_item(judge: JudgeReport) -> dict[str, float]:
    scores: dict[str, list[float]] = {}
    for score in judge.items:
        if score.metric == FAITHFULNESS_METRIC and score.score is not None:
            scores.setdefault(score.item_id, []).append(score.score)
    return {item_id: math.fsum(values) / len(values) for item_id, values in scores.items()}


def _generation_values(traces: list[RagTrace]) -> list[float]:
    values: list[float] = []
    for trace in traces:
        value = trace.stage_latency_ms.get(GENERATION_STAGE)
        if value is not None and math.isfinite(value) and value >= 0:
            values.append(value)
    return values


def compute_strategy_slices(
    traces: list[RagTrace], golden: list[GoldenItem], judge: JudgeReport | None = None
) -> dict[str, StrategySlice]:
    faithfulness = _faithfulness_by_item(judge) if judge is not None else None
    groups: dict[str, list[RagTrace]] = {}
    for trace in traces:
        groups.setdefault(strategy_key(trace), []).append(trace)
    slices: dict[str, StrategySlice] = {}
    for key, members in sorted(groups.items()):
        metrics = citation_metrics(members, golden, requested=True)
        faith: MetricValue | None = None
        if faithfulness is not None:
            values = [faithfulness[t.item_id] for t in members if t.item_id is not None and t.item_id in faithfulness]
            faith = MetricValue(value=math.fsum(values) / len(values) if values else None, n=len(values))
        slices[key] = StrategySlice(
            items=len(members),
            generation_latency=_latency_stat(_generation_values(members)),
            faithfulness=faith,
            **metrics,
        )
    return slices


SEC_SWITCH_DEFAULTS = {
    "RAG_CONTEXT_TAGGING": "false",
    "RAG_INJECTION_CHECK": "off",
    "RAG_INJECTION_PROMPT_GUARD": "false",
    "RAG_INJECTION_LAKERA": "false",
    "RAG_TOOL_RESULT_GUARD": "off",
    "NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST": "false",
}
RECOMMENDED_LABEL = "recommended"
INJECTION_NOTE = (
    "exposure_rate is the share of injection items whose injected quote reaches the generator context; "
    "attack_success_rate adds a canary or forbidden claim in the answer (NFKC and case-folded literals). "
    "The configuration label comes from the traces' own rag_env. Only the recommended configuration is gated, "
    "at exactly 0 on category:injection with zero rules false positives and at least 12 injection items "
    "(4 per language); injection_evasive and every other configuration are report-only (D-14, A-13)."
)


def _sec_value(env: dict[str, str], name: str) -> str:
    return env.get(name, SEC_SWITCH_DEFAULTS[name]).strip().casefold() or SEC_SWITCH_DEFAULTS[name]


def _label_for_env(env: dict[str, str]) -> InjectionConfigLabel:
    values = {name: _sec_value(env, name) for name in SEC_SWITCH_DEFAULTS}
    if values == SEC_SWITCH_DEFAULTS:
        return "all_off"
    tagging = values["RAG_CONTEXT_TAGGING"] == "true"
    check = values["RAG_INJECTION_CHECK"]
    ml_off = values["RAG_INJECTION_PROMPT_GUARD"] != "true" and values["RAG_INJECTION_LAKERA"] != "true"
    if tagging and check == "drop" and ml_off:
        return "recommended"
    if tagging and check == "off" and ml_off:
        return "tagging_only"
    return "other"


def injection_config_label(traces: list[RagTrace]) -> InjectionConfigLabel:
    """D-14, A-13: the label is derived from the traces' effective rag_env, never from a flag."""
    labels = {_label_for_env(trace.effective_config.rag_env) for trace in traces}
    if len(labels) != 1:
        raise ValueError(f"traces disagree on the SEC configuration: {sorted(labels)!r}")
    return labels.pop()


def build_injection_report(golden: list[GoldenItem], traces: list[RagTrace]) -> InjectionReport | None:
    metrics = injection_metrics(golden, traces)
    if metrics is None:
        return None
    label = injection_config_label(traces)
    return InjectionReport(
        config_label=label,
        gate="absolute_zero" if label == RECOMMENDED_LABEL else "report_only",
        **metrics,
    )


QUERY_GROUP = "query"
QUERY_SEQUENTIAL_STAGES = ("query_gate", "condense", "semantic_cache")
QUERY_PARALLEL_STAGES = ("normalize_dates", "expand", "hyde", "decompose", "translate")
LLM_TRANSFORMS = frozenset({"condense", "expand", "hyde", "decompose", "translate"})
TRANSFORM_RAN = frozenset({"ok", "degraded"})
TRANSFORM_SKIPPED = frozenset({"skipped", "error", "timeout", "aborted"})
PROTECTED_TOKEN_LOST = "protected_token_lost"
CACHE_STAGE = "semantic_cache"
CACHE_HIT_COUNT = "hit"
CACHE_BYPASS_PREFIX = "bypass_"
NEAR_MISS_CATEGORY = "cache_near_miss"
QUERY_LAYER_NOTE = (
    "Report-only (D-29, D-38): counts over traces with a query plan. A transform ran when its status is ok or "
    "degraded; skipped, timeout, error and aborted count as skipped with the plan or stage reason. The LLM-transform "
    "share is the share of planned items where condense, expand, HyDE, decompose or translate ran. Query-stage "
    "latency is query_gate + condense + semantic_cache plus the slowest parallel transform (normalize_dates, expand, "
    "hyde, decompose, translate), compared with the query group of the chat budgets in "
    "eval/config/latency-budgets.json."
)
SEMANTIC_CACHE_NOTE = (
    "Report-only (D-42 e, spec rule 8): read from the semantic_cache stage of each trace. A check is a hit or a miss; "
    "a failed or timed-out check is a miss (D-36) and also counted under failures; bypassed turns are never checked. "
    "Hit and miss latency is the retrieval total. A near-miss wrong hit is a cache_near_miss item whose check hit."
)


def _latency_value(trace: RagTrace, stage: str) -> float | None:
    value = trace.stage_latency_ms.get(stage)
    if value is None or not math.isfinite(value) or value < 0:
        return None
    return value


def query_stage_latency(trace: RagTrace) -> float | None:
    """D-05 order: gate, condense, the parallel transform group (its slowest member), then the cache check."""
    sequential = [v for stage in QUERY_SEQUENTIAL_STAGES if (v := _latency_value(trace, stage)) is not None]
    parallel = [v for stage in QUERY_PARALLEL_STAGES if (v := _latency_value(trace, stage)) is not None]
    if not sequential and not parallel:
        return None
    return math.fsum(sequential) + (max(parallel) if parallel else 0.0)


def _budget_status(stat: StageLatency, budget: GroupBudget | None) -> BudgetStatus:
    if budget is None:
        return "no_budget"
    over = stat.p95_ms > budget.p95_ms or (budget.p50_ms is not None and stat.p50_ms > budget.p50_ms)
    return "over" if over else "within"


def _budgeted(values: list[float], budget: GroupBudget | None) -> BudgetedLatency | None:
    stat = _latency_stat(values)
    return None if stat is None else BudgetedLatency(latency=stat, status=_budget_status(stat, budget))


def _transform_statuses(trace: RagTrace) -> dict[str, tuple[str, str | None]]:
    """One status per transform and trace: a transform that produced several variants is listed once."""
    statuses: dict[str, tuple[str, str | None]] = {}
    for entry in trace.query_transforms:
        if entry.transform is None or entry.status is None:
            continue
        current = statuses.get(entry.transform)
        if current is None or (entry.status in TRANSFORM_RAN and current[0] not in TRANSFORM_RAN):
            statuses[entry.transform] = (entry.status, entry.reason)
    return statuses


def build_query_layer_report(
    traces: list[RagTrace], results: list[ItemResult], budgets: LatencyBudgets | None
) -> QueryLayerReport:
    by_item = {result.item_id: result for result in results}
    planned = [trace for trace in traces if trace.query_plan is not None]
    rules: dict[str, int] = {}
    ran: dict[str, int] = {}
    disabled: dict[str, int] = {}
    skipped: dict[str, int] = {}
    skip_reasons: dict[str, dict[str, int]] = {}
    llm_items = 0
    losses = 0
    overall: list[float] = []
    by_language: dict[str, list[float]] = {}
    by_category: dict[str, list[float]] = {}
    for trace in planned:
        plan = trace.query_plan
        assert plan is not None
        for rule in plan.gate.reasons:
            rules[rule] = rules.get(rule, 0) + 1
        losses += sum(1 for entry in plan.skipped if entry.reason == PROTECTED_TOKEN_LOST)
        statuses = _transform_statuses(trace)
        for name, (status, reason) in statuses.items():
            target = ran if status in TRANSFORM_RAN else disabled if status == "disabled" else None
            if target is None and status in TRANSFORM_SKIPPED:
                target = skipped
                reasons = skip_reasons.setdefault(name, {})
                reasons[reason or status] = reasons.get(reason or status, 0) + 1
            if target is not None:
                target[name] = target.get(name, 0) + 1
        if any(name in LLM_TRANSFORMS and status in TRANSFORM_RAN for name, (status, _) in statuses.items()):
            llm_items += 1
        latency = query_stage_latency(trace)
        if latency is None:
            continue
        overall.append(latency)
        result = by_item.get(trace.item_id) if trace.item_id is not None else None
        if result is not None:
            by_language.setdefault(result.language, []).append(latency)
            by_category.setdefault(result.category, []).append(latency)
    profile = budgets.profiles.get(LATENCY_PROFILE) if budgets is not None else None
    budget = profile.groups.get(QUERY_GROUP) if profile is not None else None
    return QueryLayerReport(
        items=len(traces),
        items_with_plan=len(planned),
        gate_rules=dict(sorted(rules.items())),
        transforms={
            name: TransformOutcomeCounts(
                run=ran.get(name, 0),
                disabled=disabled.get(name, 0),
                skipped=skipped.get(name, 0),
                skip_reasons=dict(sorted(skip_reasons.get(name, {}).items())),
            )
            for name in sorted(set(ran) | set(disabled) | set(skipped))
        },
        llm_transform_share=MetricValue(value=llm_items / len(planned) if planned else None, n=len(planned)),
        protected_token_losses=losses,
        budget_profile=LATENCY_PROFILE,
        query_budget=budget,
        query_latency=_budgeted(overall, budget),
        query_latency_by_language={
            key: stat for key, values in sorted(by_language.items()) if (stat := _budgeted(values, budget))
        },
        query_latency_by_category={
            key: stat for key, values in sorted(by_category.items()) if (stat := _budgeted(values, budget))
        },
    )


def cache_outcome(trace: RagTrace) -> tuple[str, str | None] | None:
    """The semantic_cache stage outcome: (hit | miss | failure | bypass, bypass reason), or None when not checked.

    The stage records hit (1 or 0) and distance in its counts, or bypass_<reason> = 1 for a bypassed turn; a failed
    check (skipped, timeout, error, aborted) is a fail-open miss (D-36)."""
    status = trace.stage_status.get(CACHE_STAGE)
    counts = trace.stage_counts.get(CACHE_STAGE, {})
    if status is None and not counts:
        return None
    bypassed = sorted(
        key[len(CACHE_BYPASS_PREFIX) :]
        for key, value in counts.items()
        if key.startswith(CACHE_BYPASS_PREFIX) and value > 0
    )
    if bypassed:
        return ("bypass", bypassed[0])
    if status == "disabled":
        return None
    if status == "ok":
        return ("hit", None) if counts.get(CACHE_HIT_COUNT, 0) > 0 else ("miss", None)
    return ("failure", None)


def _retrieval_total(trace: RagTrace) -> float | None:
    values = [
        value
        for stage, value in trace.stage_latency_ms.items()
        if stage != GENERATION_STAGE and math.isfinite(value) and value >= 0
    ]
    return math.fsum(values) if values else None


def build_semantic_cache_report(traces: list[RagTrace], results: list[ItemResult]) -> SemanticCacheReport:
    categories = {result.item_id: result.category for result in results}
    hits = misses = failures = near_checks = near_wrong = 0
    bypasses: dict[str, int] = {}
    hit_latency: list[float] = []
    miss_latency: list[float] = []
    for trace in traces:
        outcome = cache_outcome(trace)
        if outcome is None:
            continue
        kind, reason = outcome
        if kind == "bypass":
            assert reason is not None
            bypasses[reason] = bypasses.get(reason, 0) + 1
            continue
        near_miss = trace.item_id is not None and categories.get(trace.item_id) == NEAR_MISS_CATEGORY
        if near_miss:
            near_checks += 1
        total = _retrieval_total(trace)
        if kind == "hit":
            hits += 1
            near_wrong += 1 if near_miss else 0
            if total is not None:
                hit_latency.append(total)
            continue
        misses += 1
        failures += 1 if kind == "failure" else 0
        if total is not None:
            miss_latency.append(total)
    checks = hits + misses
    return SemanticCacheReport(
        checks=checks,
        hits=hits,
        misses=misses,
        failures=failures,
        bypasses=dict(sorted(bypasses.items())),
        hit_rate=MetricValue(value=hits / checks if checks else None, n=checks),
        hit_latency=_latency_stat(hit_latency),
        miss_latency=_latency_stat(miss_latency),
        near_miss_checks=near_checks,
        near_miss_wrong_hits=near_wrong,
        near_miss_wrong_hit_rate=MetricValue(value=near_wrong / near_checks, n=near_checks) if near_checks else None,
    )


def load_latency_budgets(path: Path | None = None) -> LatencyBudgets:
    source = Path(path) if path is not None else LATENCY_BUDGETS_PATH
    return LatencyBudgets.model_validate_json(source.read_text(encoding="utf-8"))


def _parse_languages(raw: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(code.strip().lower() for code in raw.split(",") if code.strip()))


def run_supported_languages(manifest: RunManifest, pinned_path: Path = PINNED_EVAL_ENV_PATH) -> tuple[str, ...]:
    """The run's RAG_SUPPORTED_LANGUAGES: the run config's env when it sets it, else the eval env pin."""
    if manifest.run_config is not None and SUPPORTED_LANGUAGES_VAR in manifest.run_config.env:
        return _parse_languages(manifest.run_config.env[SUPPORTED_LANGUAGES_VAR])
    try:
        pinned = json.loads(pinned_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ()
    value = pinned.get(SUPPORTED_LANGUAGES_VAR, "") if isinstance(pinned, dict) else ""
    return _parse_languages(value if isinstance(value, str) else "")


def skip_monolingual_slices(aggregated: dict[str, object], languages: tuple[str, ...]) -> str | None:
    """D-03: with one supported language, drop the cross-lingual, language-pair and other-language slices in place."""
    if len(languages) != 1:
        return None
    (language,) = languages
    by_language = aggregated["by_language"]
    by_category = aggregated["by_category"]
    by_language_category = aggregated["by_language_category"]
    by_language_pair = aggregated["by_language_pair"]
    assert isinstance(by_language, dict) and isinstance(by_category, dict)
    assert isinstance(by_language_category, dict) and isinstance(by_language_pair, dict)
    skipped_languages = sorted(code for code in by_language if code != language)
    aggregated["by_language"] = {code: value for code, value in by_language.items() if code == language}
    aggregated["by_category"] = {name: value for name, value in by_category.items() if name != CROSS_LINGUAL_CATEGORY}
    aggregated["by_language_category"] = {
        key: value
        for key, value in by_language_category.items()
        if key.split("/", 1)[0] == language and key.split("/", 1)[-1] != CROSS_LINGUAL_CATEGORY
    }
    aggregated["by_language_pair"] = {}
    others = f", and the language slices of {', '.join(skipped_languages)}" if skipped_languages else ""
    return (
        f"Monolingual run ({SUPPORTED_LANGUAGES_VAR}={language}, D-03): skipped the {CROSS_LINGUAL_CATEGORY} "
        f"category slices, the language-pair slices{others}, because only {language} is enabled."
    )


def build_report(
    manifest: RunManifest,
    results: list[ItemResult],
    golden: list[GoldenItem],
    traces: list[RagTrace] | None = None,
    *,
    judge: JudgeReport | None = None,
    supported_languages: tuple[str, ...] | None = None,
    gate_population_config: tuple[GatePopulationConfig, str] | None = None,
    budgets: LatencyBudgets | None = None,
    golden_manifest: GoldenSetManifest | None = None,
) -> EvalReport:
    notes: list[str] = []
    if any(item.language == "zh" for item in golden):
        notes.append(ZH_QUIRK_NOTE)
    embedder = manifest.embedder
    population = gate_population_config[0] if gate_population_config is not None else None
    approved_ids = frozenset(item.id for item in golden if item.review_status == "approved")
    aggregated = aggregate(
        results,
        tuple(K_VALUES),
        gate_split=manifest.golden_filter.gate_split,
        approved_ids=approved_ids,
        population=population,
        statuses={entry.id: entry.status for entry in golden_manifest.items} if golden_manifest is not None else None,
    )
    exclusions = aggregated.pop(POPULATION_EXCLUSIONS)
    if aggregated["gate_population"] == "production":
        notes.append(PRODUCTION_GATE_NOTE)
    elif aggregated["gate_population"] == "real" and population is not None:
        eligible, _ = population_exclusions([r for r in results if r.split == manifest.golden_filter.gate_split])
        gated = [r for r in eligible if counts_in_gated_slices(r)]
        members, _ = select_gate_population(gated, approved_ids, population)
        notes.append(real_gate_note(members, manifest.golden_filter.gate_split, population))
    if gate_population_config is not None:
        notes.append(gate_population_config_note(*gate_population_config))
    languages = run_supported_languages(manifest) if supported_languages is None else supported_languages
    skipped_note = skip_monolingual_slices(aggregated, languages)
    if skipped_note is not None:
        notes.append(skipped_note)
    answer_fields: dict[str, object] = {}
    if traces:
        if citation_run(traces, requested=manifest.request_options.citations):
            answer_fields.update(citation_metrics(traces, golden, requested=True))
            answer_fields["by_strategy"] = compute_strategy_slices(traces, golden, judge)
        answer_fields["groundedness_labels"] = groundedness_label_counts(traces, golden)
        answer_fields["groundedness_latency"] = compute_groundedness_latency(traces)
        answer_fields["injection"] = build_injection_report(golden, traces)
        if budgets is None and any(trace.query_plan is not None for trace in traces):
            budgets = load_latency_budgets()
        answer_fields["query_layer"] = build_query_layer_report(traces, results, budgets)
        answer_fields["semantic_cache"] = build_semantic_cache_report(traces, results)
        answer_fields["table_split"] = table_split_report(traces, golden, gate_split=manifest.golden_filter.gate_split)
    return EvalReport(
        run_id=manifest.run_id,
        tier=manifest.tier,
        run_config_hash=manifest.run_config_hash,
        corpus_sha256=manifest.corpus_sha256,
        golden_sha256=manifest.golden_sha256,
        golden_filter=manifest.golden_filter,
        embedder_id=embedder.id if embedder else None,
        embedder_version=_embedder_version(embedder.version) if embedder else None,
        embedder_source_sha256=embedder.source_sha256 if embedder else None,
        deployment_mode=manifest.deployment_mode,
        request_options=manifest.request_options,
        k_values=list(K_VALUES),
        items=list(results),
        latency=compute_latency(traces) if traces else None,
        ttft=compute_ttft(traces) if traces else None,
        pre_generation=compute_pre_generation(traces) if traces else None,
        notes=notes,
        native_review_backlog=review_backlog(golden),
        stale_count=exclusions["stale_count"],
        stale_share=exclusions["stale_share"],
        rag_mode=manifest.rag_mode,
        golden_set_version=golden_manifest.version if golden_manifest is not None else None,
        golden_manifest_sha256=golden_manifest.manifest_sha256 if golden_manifest is not None else None,
        **aggregated,
        **answer_fields,
    )


def _cell(metric: MetricValue) -> str:
    shown = "n/a" if metric.value is None else f"{round(metric.value, 3):.3f}"
    return f"{shown} (n={metric.n})"


def _bound_cell(value: float | None) -> str:
    return "n/a" if value is None else f"{round(value, 3):.3f}"


NDCG_LABEL = "nDCG@k"
K_ZERO_LABEL = "k = 0"


def _k_zero_cell(metric: MetricValue | None) -> str:
    return "-" if metric is None or metric.value is None else str(int(metric.value))


def _table(first_column: str, rows: dict[str, SliceMetrics]) -> list[str]:
    labels = [label for label, _ in _METRIC_COLUMNS] + [FALSE_REFUSAL_BOUND_LABEL]
    with_ndcg = any(metrics.ndcg_at_context_k is not None for metrics in rows.values())
    if with_ndcg:
        labels += [NDCG_LABEL, K_ZERO_LABEL]
    header = "| " + " | ".join([first_column, *labels]) + " |"
    divider = "|" + "|".join(["---"] * (len(labels) + 1)) + "|"
    lines = [header, divider]
    for name, metrics in rows.items():
        cells = [_cell(getattr(metrics, field)) for _, field in _METRIC_COLUMNS]
        cells.append(_bound_cell(metrics.false_refusal_upper_95))
        if with_ndcg:
            cells.append(_optional_cell(metrics.ndcg_at_context_k))
            cells.append(_k_zero_cell(metrics.k_zero))
        lines.append("| " + " | ".join([name, *cells]) + " |")
    return lines


DUPLICATE_FLOOD_CATEGORY = "duplicate_flood"
NDCG_NOTE = (
    "nDCG@k is report-only (D-07): k is the number of chunks sent to the model for each item, relevance is binary "
    "by gold-span match, and the ideal DCG uses the gold unit count capped at k. k = 0 counts answerable items "
    "whose context was empty or refused; they score 0."
)
DUPLICATE_FLOOD_NOTE = (
    "Report-only (D-22): top-k redundancy is the largest share of kept chunks in one duplicate cluster (a chunk "
    "without a cluster id is its own cluster); intent coverage is the share of items whose kept chunks hold gold "
    "evidence of every intent (evidence group)."
)


def _per_language_rows(items: list[ItemResult]) -> dict[str, SliceMetrics]:
    return {"overall": slices_by(items, lambda _r: "overall")["overall"], **slices_by(items, lambda r: r.language)}


def _duplicate_flood_section(report: EvalReport) -> list[str]:
    items = [item for item in report.items if item.category == DUPLICATE_FLOOD_CATEGORY]
    if not items:
        return []
    lines = [
        "## Duplicate flood (report-only)",
        "",
        DUPLICATE_FLOOD_NOTE,
        "",
        "| Slice | Top-k redundancy | Intent coverage |",
        "|---|---|---|",
    ]
    for name, metrics in _per_language_rows(items).items():
        lines.append(f"| {name} | {_optional_cell(metrics.topk_redundancy)} | {_optional_cell(metrics.intent_coverage)} |")
    lines.append("")
    return lines


def _optional_slices_section(title: str, first_column: str, rows: dict[str, SliceMetrics]) -> list[str]:
    if not rows:
        return []
    return [f"## {title}", "", *_table(first_column, rows), ""]


def _metric_line(label: str, metric: MetricValue | None) -> str:
    return f"- {label}: {_cell(metric) if metric is not None else 'n/a (n=0)'}"


def _language_pair_section(report: EvalReport) -> list[str]:
    if not report.by_language_pair:
        return []
    return ["## By language pair", "", *_table("Question->evidence", report.by_language_pair), ""]


def _ms(value: float | None) -> str:
    return "-" if value is None else f"{value:.1f}"


def _latency_section(latency: dict[str, StageLatency], budgets: LatencyBudgets) -> list[str]:
    profile = budgets.profiles.get(LATENCY_PROFILE)
    header = "| Stage | p50 (ms) | p95 (ms) | n | Budget p50 (ms) | Budget p95 (ms) | Status |"
    lines = ["## Latency (report-only)", "", LATENCY_NOTE, "", header, "|" + "|".join(["---"] * 7) + "|"]
    stages = [name for name in latency if name != RETRIEVAL_TOTAL]
    if RETRIEVAL_TOTAL in latency:
        stages.append(RETRIEVAL_TOTAL)
    for name in stages:
        stat = latency[name]
        budget_p50: float | None = None
        budget_p95: float | None = None
        if profile is not None:
            if name == RETRIEVAL_TOTAL:
                budget_p50, budget_p95 = profile.total_p50_ms, profile.total_p95_ms
            else:
                budget_p95 = profile.stages.get(name)
        if budget_p50 is None and budget_p95 is None:
            status = "-"
        else:
            over = (budget_p50 is not None and stat.p50_ms > budget_p50) or (
                budget_p95 is not None and stat.p95_ms > budget_p95
            )
            status = "over" if over else "within"
        lines.append(
            f"| {name} | {_ms(stat.p50_ms)} | {_ms(stat.p95_ms)} | {stat.n} | "
            f"{_ms(budget_p50)} | {_ms(budget_p95)} | {status} |"
        )
    lines.append("")
    return lines


def _status(stat: StageLatency | None, budget_p50: float | None, budget_p95: float | None) -> str:
    if stat is None or (budget_p50 is None and budget_p95 is None):
        return "-"
    over = (budget_p50 is not None and stat.p50_ms > budget_p50) or (budget_p95 is not None and stat.p95_ms > budget_p95)
    return "over" if over else "within"


def _ttft_row(name: str, stat: StageLatency | None, budget_p50: float | None, budget_p95: float | None) -> str:
    p50, p95, n = (stat.p50_ms, stat.p95_ms, stat.n) if stat is not None else (None, None, 0)
    return (
        f"| {name} | {_ms(p50)} | {_ms(p95)} | {n} | {_ms(budget_p50)} | {_ms(budget_p95)} | "
        f"{_status(stat, budget_p50, budget_p95)} |"
    )


def _ttft_section(report: EvalReport, budgets: LatencyBudgets | None) -> list[str]:
    if report.ttft is None and report.pre_generation is None:
        return []
    ttft_budgets = (budgets.ttft or {}).get(LATENCY_PROFILE, {}) if budgets is not None else {}
    pre_budget = (budgets.pre_generation or {}).get(LATENCY_PROFILE) if budgets is not None else None
    lines = [
        "## Time to first token (report-only)",
        "",
        TTFT_NOTE,
        "",
        "| Row | p50 (ms) | p95 (ms) | n | Budget p50 (ms) | Budget p95 (ms) | Status |",
        "|" + "|".join(["---"] * 7) + "|",
    ]
    ttft = report.ttft or {}
    for state in CACHE_STATES:
        budget = ttft_budgets.get(state)
        lines.append(
            _ttft_row(state, ttft.get(state), budget.p50_ms if budget else None, budget.p95_ms if budget else None)
        )
    pre = (report.pre_generation or {}).get(LATENCY_PROFILE)
    lines.append(_ttft_row(PRE_GENERATION_ROW, pre, None, pre_budget.p95_ms if pre_budget else None))
    lines.append("")
    return lines


IDENTIFIER_CATEGORY = "identifier_near_miss"
IDENTIFIER_NOTE = (
    "Report-only (D-32): identifier precision is the share of identifier items (identifier_near_miss, and no_answer "
    "items tagged asked_identifier) whose context is about the "
    "asked identifier only (answerable: no near-miss chunk, a kept chunk and every cited chunk carry the asked "
    "identifier; no-answer: refused with no near-miss chunk); near-miss leakage is the share of items with a kept "
    "chunk that carries a near-miss of the asked identifier and not the asked one. Traces without identifiers_norm "
    "are not counted."
)


def _identifier_section(report: EvalReport) -> list[str]:
    items = [
        item
        for item in report.items
        if item.category == IDENTIFIER_CATEGORY or item.identifier_precise is not None or item.near_miss_leak is not None
    ]
    if not items:
        return []
    lines = [
        "## Identifier near-miss (report-only)",
        "",
        IDENTIFIER_NOTE,
        "",
        "| Slice | Identifier precision | Near-miss leakage |",
        "|---|---|---|",
    ]
    for name, metrics in _per_language_rows(items).items():
        lines.append(
            f"| {name} | {_optional_cell(metrics.identifier_precision)} | {_optional_cell(metrics.near_miss_leakage)} |"
        )
    lines.append("")
    return lines


def _optional_cell(metric: MetricValue | None) -> str:
    return _cell(metric) if metric is not None else "n/a (n=0)"


def _citations_section(report: EvalReport) -> list[str]:
    if report.citation_coverage is None and report.invalid_citation_rate is None:
        return []
    return [
        "## Citations (report-only)",
        "",
        CITATIONS_NOTE,
        "",
        _metric_line("Invalid citation rate", report.invalid_citation_rate),
        _metric_line("Citation coverage", report.citation_coverage),
        _metric_line("Cited gold hit", report.cited_gold_hit),
        f"- Dropped markers: {report.raw_invalid_markers if report.raw_invalid_markers is not None else 'n/a'}",
        "",
    ]


def _strategy_section(report: EvalReport) -> list[str]:
    if not report.by_strategy:
        return []
    header = (
        "| Strategy | Items | Invalid citation rate | Citation coverage | Cited gold hit | Dropped markers | "
        "Generation p50 (ms) | Generation p95 (ms) | Faithfulness |"
    )
    lines = ["## By citation strategy (report-only)", "", STRATEGY_NOTE, "", header, "|" + "|".join(["---"] * 9) + "|"]
    judged = any(row.faithfulness is not None for row in report.by_strategy.values())
    for name, row in report.by_strategy.items():
        latency = row.generation_latency
        faith = _optional_cell(row.faithfulness) if judged else FAITHFULNESS_SKIPPED
        cells = [
            str(row.items),
            _optional_cell(row.invalid_citation_rate),
            _optional_cell(row.citation_coverage),
            _optional_cell(row.cited_gold_hit),
            str(row.raw_invalid_markers) if row.raw_invalid_markers is not None else "-",
            _ms(latency.p50_ms if latency else None),
            _ms(latency.p95_ms if latency else None),
            faith,
        ]
        lines.append("| " + " | ".join([name, *cells]) + " |")
    lines.append("")
    if not judged:
        lines.extend([FAITHFULNESS_SKIPPED_NOTE, ""])
    return lines


def _label_counts_rows(labels: dict[str, dict[str, GroundednessLabelCounts]]) -> list[str]:
    rows: list[str] = []
    for scorer, by_language in labels.items():
        for language, counts in by_language.items():
            rows.append(
                f"| {scorer} | {language} | {counts.verified} | {counts.possibly_unreliable} | {counts.not_checked} |"
            )
    return rows


def _groundedness_section(report: EvalReport, budgets: LatencyBudgets | None) -> list[str]:
    if not report.groundedness_labels and not report.groundedness_latency:
        return []
    lines = ["## Groundedness (report-only)", "", GROUNDEDNESS_NOTE, ""]
    if report.groundedness_labels:
        lines.extend(
            [
                "| Scorer | Language | verified | possibly_unreliable | not_checked |",
                "|---|---|---|---|---|",
                *_label_counts_rows(report.groundedness_labels),
                "",
            ]
        )
    if report.groundedness_latency:
        section = budgets.groundedness if budgets is not None else None
        lines.extend(
            [
                "| Scorer | p50 (ms) | p95 (ms) | n | Budget p50 (ms) | Budget p95 (ms) | Status |",
                "|" + "|".join(["---"] * 7) + "|",
            ]
        )
        for scorer, stat in report.groundedness_latency.items():
            budget = getattr(section, scorer, None) if section is not None else None
            if budget is None:
                status, budget_p50, budget_p95 = "-", None, None
            else:
                budget_p50, budget_p95 = budget.p50_ms, budget.p95_ms
                status = "over" if stat.p50_ms > budget_p50 or stat.p95_ms > budget_p95 else "within"
            lines.append(
                f"| {scorer} | {_ms(stat.p50_ms)} | {_ms(stat.p95_ms)} | {stat.n} | "
                f"{_ms(budget_p50)} | {_ms(budget_p95)} | {status} |"
            )
        lines.append("")
    return lines


def _injection_section(report: EvalReport) -> list[str]:
    block = report.injection
    if block is None:
        return []
    lines = [
        "## Injection",
        "",
        INJECTION_NOTE,
        "",
        f"- Configuration: {block.config_label}",
        f"- Gate: {block.gate}",
        f"- Injection items: {block.items}",
        f"- Rules false positives: {block.rules_false_positive_count}",
        "",
        "| Slice | exposure_rate | attack_success_rate |",
        "|---|---|---|",
    ]
    for key in sorted(set(block.exposure_rate) | set(block.attack_success_rate)):
        exposure = block.exposure_rate.get(key)
        success = block.attack_success_rate.get(key)
        lines.append(f"| {key} | {_optional_cell(exposure)} | {_optional_cell(success)} |")
    lines.append("")
    if block.false_positive_rate:
        lines.extend(["| Detector:language | False-positive rate |", "|---|---|"])
        lines.extend(f"| {key} | {_cell(value)} |" for key, value in block.false_positive_rate.items())
        lines.append("")
    return lines


TABLE_SPLIT_TITLE = "Table split"
TABLE_SPLIT_NOTE = (
    "D-46, EVAL-18: row Recall@k counts an item when the chunk holding its gold row is within the top k; "
    "header_in_context_rate is the share of retrieved row chunks that also hold the table header (items whose row chunk "
    "was not retrieved are left out, see its n); answer_correct_rate is the deterministic value check (the gold value "
    "present, no distractor value; ambiguous counts as not correct) and is not run without answers. The CI gate is "
    "category:table_split on the noise-band metrics over counting dev items; zh and it stay report-only until a native "
    "speaker approves their items. Rates are exact fractions shown with 4 decimals."
)
TABLE_SPLIT_STATUS = {"gated": "gated", "report_only": "report-only"}


def _rate_cell(metric: MetricValue | None) -> str:
    if metric is None:
        return "not run"
    shown = "n/a" if metric.value is None else f"{metric.value:.4f}"
    return f"{shown} (n={metric.n})"


def _table_split_row(name: str, block: TableSplitSlice) -> str:
    cells = [
        name,
        TABLE_SPLIT_STATUS[block.status],
        str(block.items),
        str(block.counting_items),
        _rate_cell(block.row_recall_at_5),
        _rate_cell(block.row_recall_at_10),
        _rate_cell(block.header_in_context_rate),
        _rate_cell(block.answer_correct_rate),
    ]
    return "| " + " | ".join(cells) + " |"


def _table_split_section(report: EvalReport) -> list[str]:
    block = report.table_split
    if block is None:
        return []
    lines = [
        f"## {TABLE_SPLIT_TITLE}",
        "",
        TABLE_SPLIT_NOTE,
        "",
        f"- Answer mode: {'yes' if block.answer_mode else 'no (answer_correct_rate not run)'}",
        "",
        "| Slice | Status | Items | Counting | Row Recall@5 | Row Recall@10 | header_in_context_rate | answer_correct_rate |",
        "|---|---|---|---|---|---|---|---|",
        _table_split_row("overall", block.overall),
        *(_table_split_row(language, metrics) for language, metrics in block.by_language.items()),
        "",
        "| Item | Language | Split | Counts in gate | Row rank | Header in context | Answer |",
        "|---|---|---|---|---|---|---|",
    ]
    for row in block.items:
        header = "n/a" if row.header_in_context is None else ("yes" if row.header_in_context else "no")
        lines.append(
            f"| {row.item_id} | {row.language} | {row.split} | {'yes' if row.counts_in_gate else 'no'} | "
            f"{row.row_rank if row.row_rank is not None else '-'} | {header} | {row.answer_verdict or 'not run'} |"
        )
    lines.append("")
    return lines


def _budgeted_row(name: str, row: BudgetedLatency) -> str:
    stat = row.latency
    return f"| {name} | {_ms(stat.p50_ms)} | {_ms(stat.p95_ms)} | {stat.n} | {row.status} |"


def _query_layer_section(report: EvalReport) -> list[str]:
    block = report.query_layer
    if block is None or block.items_with_plan == 0:
        return []
    budget = block.query_budget
    budget_text = (
        f"p50 {_ms(budget.p50_ms)} / p95 {_ms(budget.p95_ms)} ms ({block.budget_profile})" if budget else "none"
    )
    lines = [
        "## Query layer (report-only)",
        "",
        QUERY_LAYER_NOTE,
        "",
        f"- Items with a query plan: {block.items_with_plan} of {block.items}",
        f"- LLM-transform share: {_cell(block.llm_transform_share)}",
        f"- Protected-token losses: {block.protected_token_losses}",
        f"- Query-stage budget: {budget_text}",
        "",
        "| Gate rule | Fired |",
        "|---|---|",
        *(f"| {rule} | {count} |" for rule, count in block.gate_rules.items()),
        "",
    ]
    if block.transforms:
        lines.extend(["| Transform | Ran | Disabled | Skipped | Skip reasons |", "|---|---|---|---|---|"])
        for name, counts in block.transforms.items():
            reasons = ", ".join(f"{reason} {count}" for reason, count in sorted(counts.skip_reasons.items())) or "-"
            lines.append(f"| {name} | {counts.run} | {counts.disabled} | {counts.skipped} | {reasons} |")
        lines.append("")
    if block.query_latency is not None:
        lines.extend(["| Query stage | p50 (ms) | p95 (ms) | n | Status |", "|---|---|---|---|---|"])
        lines.append(_budgeted_row("overall", block.query_latency))
        lines.extend(_budgeted_row(f"language:{key}", row) for key, row in block.query_latency_by_language.items())
        lines.extend(_budgeted_row(f"category:{key}", row) for key, row in block.query_latency_by_category.items())
        lines.append("")
    return lines


def _semantic_cache_section(report: EvalReport) -> list[str]:
    block = report.semantic_cache
    if block is None or (block.checks == 0 and not block.bypasses):
        return []
    hit, miss = block.hit_latency, block.miss_latency
    lines = [
        "## Semantic cache (report-only)",
        "",
        SEMANTIC_CACHE_NOTE,
        "",
        f"- Checks: {block.checks} (hits {block.hits}, misses {block.misses}, failures {block.failures})",
        f"- Hit rate: {_cell(block.hit_rate)}",
        (
            f"- Near-miss wrong hits: {block.near_miss_wrong_hits} of {block.near_miss_checks} checked near-miss "
            f"item(s); rate {_cell(block.near_miss_wrong_hit_rate) if block.near_miss_wrong_hit_rate else 'n/a'}"
        ),
        "",
        "| Outcome | p50 (ms) | p95 (ms) | n |",
        "|---|---|---|---|",
        f"| hit | {_ms(hit.p50_ms if hit else None)} | {_ms(hit.p95_ms if hit else None)} | {hit.n if hit else 0} |",
        f"| miss | {_ms(miss.p50_ms if miss else None)} | {_ms(miss.p95_ms if miss else None)} | {miss.n if miss else 0} |",
        "",
    ]
    if block.bypasses:
        lines.extend(["| Bypass reason | Turns |", "|---|---|"])
        lines.extend(f"| {reason} | {count} |" for reason, count in block.bypasses.items())
        lines.append("")
    return lines


REPORT_ONLY_TITLE = "Report-only items (native review pending)"
REPORT_ONLY_NOTE = (
    "zh and it items that were machine-translated or LLM-drafted count in gated slices only after a native speaker "
    "approved them (D-45). Until then they are scored here and never enter a gated mean, a paired difference or a "
    f"denominator. A gated slice with fewer than {MIN_GATED_ITEMS} counting item(s) has no value and is report-only."
)


def _gated_slice_keys(item: ItemResult) -> list[str]:
    keys = ["overall", f"language:{item.language}"]
    if item.category == CROSS_LINGUAL_CATEGORY and item.evidence_language is not None:
        keys.append(f"category:{CROSS_LINGUAL_CATEGORY}")
        keys.append(f"pair:{language_pair_key(item.language, item.evidence_language)}")
    return keys


def _report_only_section(report: EvalReport) -> list[str]:
    gated = [item for item in report.items if item.split == report.golden_filter.gate_split]
    held = [item for item in gated if not counts_in_gated_slices(item)]
    if not held:
        return []
    counting: dict[str, int] = {}
    pending: dict[str, int] = {}
    for item in gated:
        target = counting if counts_in_gated_slices(item) else pending
        for key in _gated_slice_keys(item):
            target[key] = target.get(key, 0) + 1
    lines = [
        f"## {REPORT_ONLY_TITLE}",
        "",
        REPORT_ONLY_NOTE,
        "",
        "| Gated slice | Counting items | Report-only items | Status |",
        "|---|---|---|---|",
    ]
    for key in sorted(pending):
        n = counting.get(key, 0)
        status = "gated" if n >= MIN_GATED_ITEMS else f"report-only (n below {MIN_GATED_ITEMS})"
        lines.append(f"| {key} | {n} | {pending[key]} | {status} |")
    lines.extend(["", *_table("Language", slices_by(held, lambda r: r.language)), ""])
    lines.extend(["| Item | Language | Evidence language | Category |", "|---|---|---|---|"])
    for item in sorted(held, key=lambda r: (r.language, r.item_id)):
        lines.append(f"| {item.item_id} | {item.language} | {item.evidence_language or '-'} | {item.category} |")
    lines.append("")
    return lines


BACKLOG_TITLE = "Native review backlog"
BACKLOG_NOTE = (
    "Informational for the owner (D-45): zh and it items no native speaker has approved yet. Pending items are "
    "machine-translated or LLM-drafted and report-only until a named reviewer approves them; existing "
    "synthetic_fixture items keep counting so no baseline moves. Only a human reviewer records an approval."
)
BACKLOG_LABELS = {
    "pending": "pending, report-only until approved",
    "existing_unreviewed": "existing, not yet reviewed, still counting",
}


def _backlog_section(report: EvalReport) -> list[str]:
    backlog = report.native_review_backlog
    if backlog is None:
        return []
    lines = [
        f"## {BACKLOG_TITLE}",
        "",
        BACKLOG_NOTE,
        "",
        f"- Items: {len(backlog)}",
        "",
        "| Language | Pending (report-only) | Existing (still counting) | Total |",
        "|---|---|---|---|",
    ]
    for language in sorted(REVIEWED_LANGUAGES | {entry.language for entry in backlog}):
        pending = sum(1 for entry in backlog if entry.language == language and entry.state == "pending")
        existing = sum(1 for entry in backlog if entry.language == language and entry.state == "existing_unreviewed")
        lines.append(f"| {language} | {pending} | {existing} | {pending + existing} |")
    lines.append("")
    if backlog:
        lines.extend(["| Item | Language | State |", "|---|---|---|"])
        lines.extend(f"| {entry.item_id} | {entry.language} | {BACKLOG_LABELS[entry.state]} |" for entry in backlog)
        lines.append("")
    return lines


def _false_answer(metrics: SliceMetrics) -> MetricValue:
    if metrics.false_answer_rate is not None:
        return metrics.false_answer_rate
    correct = metrics.correct_refusal_rate
    return MetricValue(value=None if correct.value is None else 1 - correct.value, n=correct.n)


def _lifecycle_lines(report: EvalReport) -> list[str]:
    """D-07, D-46: RAG mode, golden-set version and manifest hash, stale share, false-answer next to correct-refusal rate."""
    version = report.golden_set_version if report.golden_set_version is not None else "n/a"
    manifest = report.golden_manifest_sha256[:12] if report.golden_manifest_sha256 else "n/a"
    return [
        f"- RAG mode: {report.rag_mode}",
        f"- Golden set: version {version}, manifest {manifest}",
        f"- Stale items: {report.stale_count} (share {round(report.stale_share, 3):.3f})",
        f"- Refusals (overall): correct refusal {_cell(report.overall.correct_refusal_rate)}, "
        f"false answer {_cell(_false_answer(report.overall))}",
    ]


def _render_markdown(report: EvalReport, budgets: LatencyBudgets | None = None) -> str:
    lines = [
        f"# Eval report: {report.run_id}",
        "",
        f"- Tier: {report.tier}",
        f"- Deployment mode: {report.deployment_mode}",
        f"- Items: {len(report.items)}",
        f"- Run config hash: {report.run_config_hash}",
        f"- Golden sha256: {report.golden_sha256}",
        f"- Scored review statuses: {', '.join(report.golden_filter.review_statuses)}; gated split: {report.golden_filter.gate_split}",
        f"- Gate population: {report.gate_population}",
        f"- Corpus sha256: {report.corpus_sha256 or 'n/a'}",
        f"- Embedder: {report.embedder_id or 'n/a'} (version {report.embedder_version if report.embedder_version is not None else 'n/a'})",
        *_lifecycle_lines(report),
        "",
        ("Rates are rounded to 3 decimals for display; report.json holds the unrounded values. "
         "n is the number of items behind each rate."),
        "",
        GATING_NOTE,
        "",
        "## Overall",
        "",
        *_table("Slice", {"overall": report.overall}),
        "",
        "## By split",
        "",
        *_table("Split", report.by_split),
        "",
        "## By language",
        "",
        *_table("Language", report.by_language),
        "",
        "## By category",
        "",
        *_table("Category", report.by_category),
        "",
        "## By language and category",
        "",
        *_table("Language/category", report.by_language_category),
        "",
        *_language_pair_section(report),
        *_optional_slices_section("By document type", "Document type", report.by_doc_type),
        *_optional_slices_section("By question kind", "Question kind", report.by_question_kind),
        "## By provenance",
        "",
        *_table("Provenance", report.by_provenance),
        "",
        "## By provenance and category",
        "",
        *_table("Provenance/category", report.by_provenance_category),
        "",
        "## Retrieval stage metrics",
        "",
        _metric_line("Rerank skipped rate", report.rerank_skipped_rate),
        _metric_line("Lexical leg hit rate@10", report.lexical_leg_hit_rate_at_10),
        "",
        BOUND_NOTE,
        "",
        *([NDCG_NOTE, ""] if report.overall.ndcg_at_context_k is not None else []),
        *_report_only_section(report),
    ]
    if budgets is None and (report.latency or report.groundedness_latency or report.ttft or report.pre_generation):
        budgets = load_latency_budgets()
    if report.latency and budgets is not None:
        lines.extend(_latency_section(report.latency, budgets))
    lines.extend(_ttft_section(report, budgets))
    lines.extend(_citations_section(report))
    lines.extend(_strategy_section(report))
    lines.extend(_groundedness_section(report, budgets))
    lines.extend(_injection_section(report))
    lines.extend(_table_split_section(report))
    lines.extend(_duplicate_flood_section(report))
    lines.extend(_identifier_section(report))
    lines.extend(_query_layer_section(report))
    lines.extend(_semantic_cache_section(report))
    lines.extend(_backlog_section(report))
    if report.notes:
        lines.extend(["## Notes", ""])
        lines.extend(f"- {note}" for note in report.notes)
        lines.append("")
    return "\n".join(lines)


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(text.encode("utf-8"))
    os.replace(tmp, path)


def write_report(report: EvalReport, out_dir: Path, budgets: LatencyBudgets | None = None) -> tuple[Path, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "report.json"
    md_path = out_dir / "report.md"
    payload = json.dumps(report.model_dump(mode="json"), sort_keys=True, ensure_ascii=False, indent=2) + "\n"
    _atomic_write(json_path, payload)
    _atomic_write(md_path, _render_markdown(report, budgets))
    return json_path, md_path
