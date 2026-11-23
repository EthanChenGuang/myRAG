import json
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

K_VALUES = [5, 10]

ZH_QUIRK_NOTE = (
    "Filter 1 Chinese empty-term quirk: the chat route's name/content filter derives an empty query term "
    "for Chinese queries, so every retrieved chunk passes Filter 1 and zh retrieval is not narrowed by it; "
    "zh slices can look better than en and it slices for that reason."
)
GATING_NOTE = (
    "Overall, language and category tables cover the dev split only. Categories are report-only; "
    "only overall and per-language slices gate (D-20). The held-out test split is reported under By split "
    "and never gates (D-14)."
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
    return 0.0


def compute_latency(traces: list[RagTrace]) -> dict[str, StageLatency] | None:
    return None


def load_latency_budgets(path: Path | None = None) -> LatencyBudgets:
    return LatencyBudgets(profiles={})


def build_report(
    manifest: RunManifest, results: list[ItemResult], golden: list[GoldenItem], traces: list[RagTrace] | None = None
) -> EvalReport:
    notes: list[str] = []
    if any(item.language == "zh" for item in golden):
        notes.append(ZH_QUIRK_NOTE)
    embedder = manifest.embedder
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
        notes=notes,
        **aggregate(results, tuple(K_VALUES), gate_split=manifest.golden_filter.gate_split),
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


def _render_markdown(report: EvalReport) -> str:
    lines = [
        f"# Eval report: {report.run_id}",
        "",
        f"- Tier: {report.tier}",
        f"- Deployment mode: {report.deployment_mode}",
        f"- Items: {len(report.items)}",
        f"- Run config hash: {report.run_config_hash}",
        f"- Golden sha256: {report.golden_sha256}",
        f"- Scored review statuses: {', '.join(report.golden_filter.review_statuses)}; gated split: {report.golden_filter.gate_split}",
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
    ]
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
    _atomic_write(md_path, _render_markdown(report))
    return json_path, md_path
