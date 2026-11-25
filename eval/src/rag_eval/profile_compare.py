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
)
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.gate import evaluate_gate
from rag_eval.metrics import CROSS_LINGUAL, aggregate
from rag_eval.paired import item_metrics

MULTILINGUAL_PROFILE_PREFIXES = ("voyage-", "qwen3-")
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")
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


def default_candidate(profile_id: str, entry: ProfileComparisonEntry, baseline_entry: ProfileComparisonEntry) -> bool | None:
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
            metrics=ProfileMetricBlocks(gated=_slice_block(gated_report), candidates=_slice_block(candidate_report)),
        )
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
        notes.append("pre_migration slice is empty; activation should refuse until documents exist before the backfill run.")

    return EmbeddingProfileComparison(
        baseline_profile=baseline_profile,
        active_profile=active_profile,
        profiles=profiles,
        pre_migration=pre_migration,
        gate_passed=gate_passed and pre_migration.passed and pre_migration.n >= 1,
        backfill_run_id=backfill_run_id,
        notes=notes,
    )


def comparison_to_activation_evidence(
    comparison: EmbeddingProfileComparison,
    *,
    target_profile: str,
    recorded_at: str,
) -> ActivationEvidence:
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