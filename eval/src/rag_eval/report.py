import json
import math
import os
from pathlib import Path

from rag_sidecar.contracts.eval_run import RagTrace, RunManifest
from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.latency import LatencyBudgets, StageLatency
from rag_sidecar.contracts.report import (
    EvalReport,
    ItemResult,
    MetricValue,
    SliceMetrics,
)

from rag_eval.metrics import aggregate
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


def load_latency_budgets(path: Path | None = None) -> LatencyBudgets:
    source = Path(path) if path is not None else LATENCY_BUDGETS_PATH
    return LatencyBudgets.model_validate_json(source.read_text(encoding="utf-8"))


def build_report(
    manifest: RunManifest, results: list[ItemResult], golden: list[GoldenItem], traces: list[RagTrace] | None = None
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
    )


def _cell(metric: MetricValue) -> str:
    shown = "n/a" if metric.value is None else f"{round(metric.value, 3):.3f}"
    return f"{shown} (n={metric.n})"


def _table(first_column: str, rows: dict[str, SliceMetrics]) -> list[str]:
    header = "| " + " | ".join([first_column, *(label for label, _ in _METRIC_COLUMNS)]) + " |"
    divider = "|" + "|".join(["---"] * (len(_METRIC_COLUMNS) + 1)) + "|"
    lines = [header, divider]
    for name, metrics in rows.items():
        cells = [_cell(getattr(metrics, field)) for _, field in _METRIC_COLUMNS]
        lines.append("| " + " | ".join([name, *cells]) + " |")
    return lines


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
        "## By provenance",
        "",
        *_table("Provenance", report.by_provenance),
        "",
        "## By provenance and category",
        "",
        *_table("Provenance/category", report.by_provenance_category),
        "",
    ]
    if report.latency:
        lines.extend(_latency_section(report.latency, budgets if budgets is not None else load_latency_budgets()))
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
