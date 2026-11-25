import json
import math
import os
from pathlib import Path

from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.judge import JudgeReport
from rag_sidecar.contracts.latency import LatencyBudgets, StageLatency
from rag_sidecar.contracts.report import (
    EvalReport,
    GroundednessLabelCounts,
    ItemResult,
    MetricValue,
    SliceMetrics,
    StrategySlice,
)

from rag_eval.metrics import (
    aggregate,
    citation_metrics,
    citation_run,
    groundedness_label_counts,
    strategy_key,
)
from rag_eval.paths import REPO_ROOT

K_VALUES = [5, 10]
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


def load_latency_budgets(path: Path | None = None) -> LatencyBudgets:
    source = Path(path) if path is not None else LATENCY_BUDGETS_PATH
    return LatencyBudgets.model_validate_json(source.read_text(encoding="utf-8"))


def build_report(
    manifest: RunManifest,
    results: list[ItemResult],
    golden: list[GoldenItem],
    traces: list[RagTrace] | None = None,
    *,
    judge: JudgeReport | None = None,
) -> EvalReport:
    notes: list[str] = []
    if any(item.language == "zh" for item in golden):
        notes.append(ZH_QUIRK_NOTE)
    embedder = manifest.embedder
    aggregated = aggregate(
        results,
        tuple(K_VALUES),
        gate_split=manifest.golden_filter.gate_split,
        approved_ids=frozenset(item.id for item in golden if item.review_status == "approved"),
    )
    if aggregated["gate_population"] == "production":
        notes.append(PRODUCTION_GATE_NOTE)
    answer_fields: dict[str, object] = {}
    if traces:
        if citation_run(traces, requested=manifest.request_options.citations):
            answer_fields.update(citation_metrics(traces, golden, requested=True))
            answer_fields["by_strategy"] = compute_strategy_slices(traces, golden, judge)
        answer_fields["groundedness_labels"] = groundedness_label_counts(traces, golden)
        answer_fields["groundedness_latency"] = compute_groundedness_latency(traces)
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
        notes=notes,
        **aggregated,
        **answer_fields,
    )


def _cell(metric: MetricValue) -> str:
    shown = "n/a" if metric.value is None else f"{round(metric.value, 3):.3f}"
    return f"{shown} (n={metric.n})"


def _bound_cell(value: float | None) -> str:
    return "n/a" if value is None else f"{round(value, 3):.3f}"


def _table(first_column: str, rows: dict[str, SliceMetrics]) -> list[str]:
    labels = [label for label, _ in _METRIC_COLUMNS] + [FALSE_REFUSAL_BOUND_LABEL]
    header = "| " + " | ".join([first_column, *labels]) + " |"
    divider = "|" + "|".join(["---"] * (len(labels) + 1)) + "|"
    lines = [header, divider]
    for name, metrics in rows.items():
        cells = [_cell(getattr(metrics, field)) for _, field in _METRIC_COLUMNS]
        cells.append(_bound_cell(metrics.false_refusal_upper_95))
        lines.append("| " + " | ".join([name, *cells]) + " |")
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
    ]
    if budgets is None and (report.latency or report.groundedness_latency):
        budgets = load_latency_budgets()
    if report.latency and budgets is not None:
        lines.extend(_latency_section(report.latency, budgets))
    lines.extend(_citations_section(report))
    lines.extend(_strategy_section(report))
    lines.extend(_groundedness_section(report, budgets))
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
