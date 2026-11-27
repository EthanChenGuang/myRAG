from __future__ import annotations

from rag_sidecar.contracts.baseline import Baseline, BaselineMetricStat, NoiseConfig
from rag_sidecar.contracts.profiles import (
    ActivationEvidence,
    ComparisonSliceBlock,
    EmbeddingProfileComparison,
    PreMigrationEvidence,
    PreMigrationSlice,
    ProfileComparisonEntry,
    ProfileMetricBlocks,
    ServingModeMeasurement,
)
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.gate import evaluate_gate
from rag_eval.metrics import CROSS_LINGUAL, aggregate
from rag_eval.paired import item_metrics

MULTILINGUAL_PROFILE_PREFIXES = ("voyage-", "qwen3-")
METRICS = (
    "recall_at_5",
    "recall_at_10",
    "mrr",
    "correct_refusal_rate",
    "false_refusal_rate",
)
BGE_M3_PROFILE = "bge-m3-1024"
SERVING_MODES = ("hosted", "sidecar")
NOT_MEASURED = "not measured"
WIRING_PROOF_LABEL = "wiring proof: fixture embedder; the numbers prove the comparison runs, not how the profiles rank"


WIRING_PROOF_NOTE = "wiring proof: no verdict on fixture numbers"


class FixtureEvidenceRefused(ValueError):
    """A wiring-proof comparison never becomes activation evidence."""


def serving_blocks(
    profile_id: str, measured: list[ServingModeMeasurement] | None
) -> list[ServingModeMeasurement] | None:
    """The BGE-M3 arm always carries one block per serving mode; a mode without measurements is an explicit unmeasured block."""
    if profile_id != BGE_M3_PROFILE and not measured:
        return None
    by_mode: dict[str, ServingModeMeasurement] = {}
    for block in measured or []:
        if block.mode in by_mode:
            raise ValueError(f"duplicate serving mode {block.mode} for {profile_id}")
        by_mode[block.mode] = block
    return [by_mode.get(mode) or ServingModeMeasurement(mode=mode, measured=False) for mode in SERVING_MODES]


FAKE_EMBEDDER_NOTE = (
    "Fixture embedders are not multilingual; this run proves comparison and activation wiring only, not real ranking."
)


def _report_slices(report: EvalReport) -> dict[str, SliceMetrics]:
    slices: dict[str, SliceMetrics] = {"overall": report.overall}
    for language, metrics in report.by_language.items():
        slices[f"language:{language}"] = metrics
    for category, metrics in report.by_category.items():
        slices[f"category:{category}"] = metrics
    for pair, metrics in report.by_language_pair.items():
        slices[f"pair:{pair}"] = metrics
    return slices


def _slice_block(report: EvalReport) -> ComparisonSliceBlock:
    return ComparisonSliceBlock(
        overall=report.overall,
        by_language=dict(report.by_language),
        by_category=dict(report.by_category),
        by_language_pair=dict(report.by_language_pair),
    )


def _stat(mean: float | None, spread: float = 0.0) -> BaselineMetricStat:
    return BaselineMetricStat(mean=mean, spread=spread, runs=[mean, mean, mean], n=3)


def baseline_from_report(report: EvalReport, *, tag: str) -> Baseline:
    slices: dict[str, dict[str, BaselineMetricStat]] = {}
    for slice_name, metrics in _report_slices(report).items():
        slices[slice_name] = {metric: _stat(getattr(metrics, metric).value) for metric in METRICS}
    items: dict[str, dict[str, list[float | None]]] = {}
    for item in report.items:
        bucket = items.setdefault(item.item_id, {})
        for metric, value in item_metrics(item).items():
            bucket.setdefault(metric, []).append(value)
    run_entry = {
        "run_id": tag,
        "run_config_hash": report.run_config_hash,
        "git_sha": None,
        "created_at": "1970-01-01T00:00:00Z",
    }
    return Baseline(
        spread_kind="stdev_ddof1",
        tier=report.tier,
        deployment_mode=report.deployment_mode,
        request_options=report.request_options,
        corpus_sha256=report.corpus_sha256,
        golden_sha256=report.golden_sha256,
        golden_filter=report.golden_filter,
        gate_population=report.gate_population,
        embedder_id=report.embedder_id,
        embedder_version=report.embedder_version,
        embedder_source_sha256=report.embedder_source_sha256,
        run_config_hash=report.run_config_hash,
        runs=[run_entry, run_entry, run_entry],
        slices=slices,
        items=items or None,
    )


def profile_pair_gate_passed(active: EvalReport, target: EvalReport, noise: NoiseConfig) -> bool:
    baseline = baseline_from_report(active, tag="active-baseline")
    return evaluate_gate(target, baseline, noise).passed


def _is_multilingual(profile_id: str) -> bool:
    return profile_id.startswith(MULTILINGUAL_PROFILE_PREFIXES)


def default_candidate(
    profile_id: str,
    entry: ProfileComparisonEntry,
    baseline_entry: ProfileComparisonEntry,
) -> bool | None:
    if profile_id == baseline_entry.profile_id:
        return None
    if not _is_multilingual(profile_id):
        return None
    baseline_slice = baseline_entry.metrics.candidates.by_category.get(CROSS_LINGUAL)
    target_slice = entry.metrics.candidates.by_category.get(CROSS_LINGUAL)
    if baseline_slice is None or target_slice is None:
        return False
    baseline_recall = baseline_slice.recall_at_10.value
    target_recall = target_slice.recall_at_10.value
    if baseline_recall is None or target_recall is None:
        return False
    return target_recall > baseline_recall


def _pre_migration_slice(items: list[ItemResult]) -> PreMigrationSlice:
    aggregated = aggregate(items, gate_split="dev")
    overall: SliceMetrics = aggregated["overall"]
    return PreMigrationSlice(
        n=len(items),
        passed=len(items) >= 1,
        recall_at_5=overall.recall_at_5,
        recall_at_10=overall.recall_at_10,
        mrr=overall.mrr,
    )


def build_comparison(
    active_reports: tuple[EvalReport, EvalReport],
    target_reports: dict[str, tuple[EvalReport, EvalReport]],
    *,
    baseline_profile: str,
    active_profile: str,
    noise: NoiseConfig,
    pre_migration_items: list[ItemResult],
    backfill_run_id: str | None,
    serving: dict[str, list[ServingModeMeasurement]] | None = None,
    wiring_proof: bool = False,
) -> EmbeddingProfileComparison:
    active_gated, active_candidates = active_reports
    baseline_entry = ProfileComparisonEntry(
        profile_id=baseline_profile,
        metrics=ProfileMetricBlocks(gated=_slice_block(active_gated), candidates=_slice_block(active_candidates)),
    )
    profiles: list[ProfileComparisonEntry] = [baseline_entry]
    gate_passed = True

    for profile_id, (gated_report, candidate_report) in sorted(target_reports.items()):
        gate_passed = gate_passed and profile_pair_gate_passed(active_gated, gated_report, noise)
        entry = ProfileComparisonEntry(
            profile_id=profile_id,
            metrics=ProfileMetricBlocks(
                gated=_slice_block(gated_report),
                candidates=_slice_block(candidate_report),
            ),
            serving=serving_blocks(profile_id, (serving or {}).get(profile_id)),
        )
        if wiring_proof:
            profiles.append(
                entry.model_copy(
                    update={
                        "default_candidate": None,
                        "default_candidate_note": WIRING_PROOF_NOTE,
                    }
                )
            )
            continue
        verdict = default_candidate(profile_id, entry, baseline_entry)
        profiles.append(
            entry.model_copy(
                update={
                    "default_candidate": verdict,
                    "default_candidate_note": (
                        "threshold-free cross_lingual recall@10 beats baseline"
                        if verdict
                        else (
                            "not a multilingual profile candidate"
                            if verdict is None
                            else "does not beat baseline on cross_lingual"
                        )
                    ),
                }
            )
        )

    pre_migration = _pre_migration_slice(pre_migration_items)
    notes = [FAKE_EMBEDDER_NOTE]
    if pre_migration.n < 1:
        notes.append(
            "pre_migration slice is empty; activation should refuse until documents exist before the backfill run."
        )

    return EmbeddingProfileComparison(
        baseline_profile=baseline_profile,
        active_profile=active_profile,
        profiles=profiles,
        pre_migration=pre_migration,
        gate_passed=gate_passed and pre_migration.passed and pre_migration.n >= 1,
        backfill_run_id=backfill_run_id,
        notes=notes,
        wiring_proof=wiring_proof,
        label=WIRING_PROOF_LABEL if wiring_proof else None,
    )


def comparison_to_activation_evidence(
    comparison: EmbeddingProfileComparison,
    *,
    target_profile: str,
    recorded_at: str,
) -> ActivationEvidence:
    if comparison.wiring_proof:
        raise FixtureEvidenceRefused(
            "evidence_refused: fixture_evidence (a wiring-proof comparison is not activation evidence)"
        )
    if comparison.backfill_run_id is None:
        raise ValueError("comparison lacks backfill_run_id")
    return ActivationEvidence(
        target_profile=target_profile,
        baseline_profile=comparison.active_profile,
        gate_passed=comparison.gate_passed,
        pre_migration=PreMigrationEvidence(passed=comparison.pre_migration.passed, n=comparison.pre_migration.n),
        backfill_run_id=comparison.backfill_run_id,
        recorded_at=recorded_at,
    )


def _number(value: float | None) -> str:
    return "n/a" if value is None else f"{value:g}"


def _slice_rows(block: ComparisonSliceBlock) -> list[tuple[str, SliceMetrics]]:
    rows: list[tuple[str, SliceMetrics]] = [("overall", block.overall)]
    rows += [(f"language:{key}", value) for key, value in sorted(block.by_language.items())]
    rows += [(f"category:{key}", value) for key, value in sorted(block.by_category.items())]
    rows += [(f"pair:{key}", value) for key, value in sorted(block.by_language_pair.items())]
    return rows


def _serving_line(block: ServingModeMeasurement) -> str:
    if not block.measured:
        return f"  serving {block.mode}: {NOT_MEASURED}"
    throughput = (
        NOT_MEASURED
        if block.ingest_chunks_per_second is None
        else f"{_number(block.ingest_chunks_per_second)} chunks/s"
    )
    if block.query_embed_p50_ms is None and block.query_embed_p95_ms is None:
        latency = NOT_MEASURED
    else:
        latency = f"p50 {_number(block.query_embed_p50_ms)} ms, p95 {_number(block.query_embed_p95_ms)} ms"
    price = (
        NOT_MEASURED
        if block.usd_per_million_tokens is None
        else f"{_number(block.usd_per_million_tokens)} USD/1M tokens"
    )
    run_cost = NOT_MEASURED if block.run_cost_usd is None else f"{_number(block.run_cost_usd)} USD"
    source = f" [{block.source}]" if block.source else ""
    return (
        f"  serving {block.mode}{source}: ingest {throughput}; query embed {latency}; cost {price}, this run {run_cost}"
    )


def render_comparison(comparison: EmbeddingProfileComparison) -> str:
    """Plain-text report: every arm with every slice (pairs as query->document language), serving-mode figures for arms that have them."""
    lines: list[str] = []
    if comparison.wiring_proof and comparison.label:
        lines.append(comparison.label)
    lines.append(f"active profile: {comparison.active_profile}; gate passed: {comparison.gate_passed}")
    header = "  " + "slice".ljust(28) + "  ".join(name.rjust(10) for name in ("recall@5", "recall@10", "mrr", "n"))
    for entry in comparison.profiles:
        lines.append(f"== {entry.profile_id}")
        for block_name, block in (
            ("gated", entry.metrics.gated),
            ("candidates", entry.metrics.candidates),
        ):
            lines.append(f" {block_name}")
            lines.append(header)
            for row, metrics in _slice_rows(block):
                values = (
                    metrics.recall_at_5.value,
                    metrics.recall_at_10.value,
                    metrics.mrr.value,
                )
                cells = [_number(None if value is None else round(value, 4)).rjust(10) for value in values]
                lines.append("  " + row.ljust(28) + "  ".join([*cells, str(metrics.recall_at_10.n).rjust(10)]))
        for serving_block in entry.serving or []:
            lines.append(_serving_line(serving_block))
        if not comparison.wiring_proof and entry.profile_id != comparison.baseline_profile:
            verdict = {True: "yes", False: "no", None: "n/a"}[entry.default_candidate]
            lines.append(f"  default candidate: {verdict} ({entry.default_candidate_note or ''})")
    return "\n".join(lines) + "\n"
