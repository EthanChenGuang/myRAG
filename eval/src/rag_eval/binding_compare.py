"""Per-doc-type embedding binding comparison and its decision rule (D-22, D-23).

Languages and cross-lingual pairs are read from the items of the reports, never from a fixed list (LANG-01).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import (
    BindingArm,
    BindingCandidateResult,
    BindingComparison,
    BindingComparisonHashes,
)
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.metrics import GENERAL_DOC_TYPE, aggregate

BindingMetricName = Literal["recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate"]
DELTA_METRICS: tuple[BindingMetricName, ...] = (
    "recall_at_5",
    "recall_at_10",
    "mrr",
    "correct_refusal_rate",
    "false_refusal_rate",
)
WIN_METRICS: tuple[BindingMetricName, ...] = ("recall_at_10", "mrr")
RETRIEVAL_METRICS: tuple[BindingMetricName, ...] = ("recall_at_5", "recall_at_10", "mrr")
REFUSAL_METRICS: tuple[BindingMetricName, ...] = ("correct_refusal_rate", "false_refusal_rate")
REAL_PROVENANCES = frozenset({"production", "human"})
DOC_TYPE_TAG_PREFIX = "doc_type:"
INLINE_REPORT = "<inline>"
BINDING_FIXTURE_NOTE = (
    "Fixture evidence: the run used fixture embedders or the doc-type slice has no production or human items; "
    "it proves the comparison wiring and decision rule only and cannot activate a binding (D-11)."
)
CONTROL_NOTE = "gain explained by filtered leg (control)"


@dataclass(frozen=True)
class CandidateCatalog:
    model: str
    usd_per_million_tokens: float
    supported_languages: tuple[str, ...]


@dataclass(frozen=True)
class _ArmSlices:
    doc_type_slice: SliceMetrics
    doc_by_language: dict[str, SliceMetrics]
    doc_by_pair: dict[str, SliceMetrics]
    overall: SliceMetrics
    by_language: dict[str, SliceMetrics]
    by_language_pair: dict[str, SliceMetrics]
    by_doc_type: dict[str, SliceMetrics]


def golden_doc_types_from_tags(items: list[object]) -> dict[str, str]:
    """Item id → doc type from `doc_type:<type>` tags; no-answer items have no evidence document to take it from."""
    mapping: dict[str, str] = {}
    for item in items:
        for tag in getattr(item, "tags", []) or []:
            if tag.startswith(DOC_TYPE_TAG_PREFIX):
                mapping[item.id] = tag[len(DOC_TYPE_TAG_PREFIX) :]  # type: ignore[attr-defined]
                break
    return mapping


def _retag(items: list[ItemResult], golden_doc_types: Mapping[str, str]) -> list[ItemResult]:
    retagged: list[ItemResult] = []
    for item in items:
        doc_type = golden_doc_types.get(item.item_id) or item.doc_type or GENERAL_DOC_TYPE
        retagged.append(item if doc_type == item.doc_type else item.model_copy(update={"doc_type": doc_type}))
    return retagged


def _slices(report: EvalReport, doc_type: str, golden_doc_types: Mapping[str, str]) -> _ArmSlices:
    gate_split = report.golden_filter.gate_split
    items = _retag(list(report.items), golden_doc_types)
    whole = aggregate(items, gate_split=gate_split)
    members = [item for item in items if item.doc_type == doc_type]
    sub = aggregate(members, gate_split=gate_split)
    return _ArmSlices(
        doc_type_slice=sub["overall"],  # type: ignore[arg-type]
        doc_by_language=dict(sub["by_language"]),  # type: ignore[arg-type]
        doc_by_pair=dict(sub["by_language_pair"]),  # type: ignore[arg-type]
        overall=whole["overall"],  # type: ignore[arg-type]
        by_language=dict(whole["by_language"]),  # type: ignore[arg-type]
        by_language_pair=dict(whole["by_language_pair"]),  # type: ignore[arg-type]
        by_doc_type=dict(whole["by_doc_type"]),  # type: ignore[arg-type]
    )


def _latency(report: EvalReport) -> dict[str, float | None]:
    if not report.latency:
        return {}
    return {stage: stat.p50_ms for stage, stat in sorted(report.latency.items())}


def _band(noise: NoiseConfig) -> float:
    # Single runs per arm: the spread is zero, so the band is the floor (same rule as gate.py with spread 0).
    return max(noise.k * 0.0, noise.floor)


def _value(metrics: SliceMetrics | None, metric: str) -> float | None:
    if metrics is None:
        return None
    return getattr(metrics, metric).value


def _delta(reference: SliceMetrics, target: SliceMetrics, metric: str) -> float | None:
    ref, tgt = _value(reference, metric), _value(target, metric)
    if ref is None or tgt is None:
        return None
    return round(tgt - ref, 6)


def _direction(noise: NoiseConfig, metric: str) -> str:
    return noise.metrics.get(metric, "higher")


def _gain(reference: SliceMetrics, target: SliceMetrics, metric: str, noise: NoiseConfig) -> bool:
    delta = _delta(reference, target, metric)
    if delta is None:
        return False
    signed = delta if _direction(noise, metric) == "higher" else -delta
    return signed > _band(noise)


def _drops(reference: SliceMetrics | None, target: SliceMetrics | None, metrics: tuple[str, ...], noise: NoiseConfig) -> bool:
    if reference is None or target is None:
        return False
    for metric in metrics:
        delta = _delta(reference, target, metric)
        if delta is None:
            continue
        signed = delta if _direction(noise, metric) == "higher" else -delta
        if signed < -_band(noise):
            return True
    return False


def _beats(reference: SliceMetrics, target: SliceMetrics, noise: NoiseConfig) -> bool:
    return all(_gain(reference, target, metric, noise) for metric in WIN_METRICS)


def _deltas(reference: SliceMetrics, target: SliceMetrics) -> dict[BindingMetricName, float | None]:
    return {metric: _delta(reference, target, metric) for metric in DELTA_METRICS}


def _keyed_regressions(
    reference: Mapping[str, SliceMetrics], target: Mapping[str, SliceMetrics], noise: NoiseConfig, prefix: str = ""
) -> list[str]:
    return [
        f"{prefix}{key}"
        for key in sorted(reference)
        if _drops(reference[key], target.get(key), RETRIEVAL_METRICS, noise)
    ]


def _arm(profile_id: str, report_path: str, slices: _ArmSlices, report: EvalReport) -> BindingArm:
    return BindingArm(
        profile_id=profile_id,
        report_path=report_path,
        doc_type_slice=slices.doc_type_slice,
        by_language=slices.by_language,
        by_language_pair=slices.by_language_pair,
        by_doc_type=slices.by_doc_type,
        latency_ms=_latency(report),
    )


def _provenance_counts(report: EvalReport, doc_type: str, golden_doc_types: Mapping[str, str]) -> dict[str, int]:
    counts = Counter(item.provenance for item in _retag(list(report.items), golden_doc_types) if item.doc_type == doc_type)
    return dict(sorted(counts.items()))


def compare(
    baseline: EvalReport,
    control: EvalReport,
    candidates: Mapping[str, EvalReport],
    noise: NoiseConfig,
    doc_type: str,
    *,
    baseline_profile: str,
    catalog: Mapping[str, CandidateCatalog],
    hashes: BindingComparisonHashes,
    reembed_run_ids: Mapping[str, str],
    fixture_embedder: bool,
    golden_doc_types: Mapping[str, str] | None = None,
    report_paths: Mapping[str, str] | None = None,
) -> BindingComparison:
    if not candidates:
        raise ValueError("at least one candidate arm is required")
    tags = dict(golden_doc_types or {})
    paths = dict(report_paths or {})
    missing_runs = sorted(set(candidates) - set(reembed_run_ids))
    if missing_runs:
        raise ValueError(f"no re-embed run id for candidate(s): {', '.join(missing_runs)}")
    missing_catalog = sorted(set(candidates) - set(catalog))
    if missing_catalog:
        raise ValueError(f"no catalog entry for candidate(s): {', '.join(missing_catalog)}")

    base = _slices(baseline, doc_type, tags)
    ctrl = _slices(control, doc_type, tags)
    notes: list[str] = []
    results: list[BindingCandidateResult] = []
    qualified: list[tuple[float, float, float, str]] = []

    for profile_id in sorted(candidates):
        report = candidates[profile_id]
        cand = _slices(report, doc_type, tags)
        entry = catalog[profile_id]
        beats_baseline = _beats(base.doc_type_slice, cand.doc_type_slice, noise)
        beats_control = _beats(ctrl.doc_type_slice, cand.doc_type_slice, noise)
        language_regressions = _keyed_regressions(base.doc_by_language, cand.doc_by_language, noise)
        pair_regressions = _keyed_regressions(base.doc_by_pair, cand.doc_by_pair, noise)
        other = []
        if _drops(base.overall, cand.overall, RETRIEVAL_METRICS, noise):
            other.append("overall")
        other += _keyed_regressions(
            {key: value for key, value in base.by_doc_type.items() if key != doc_type}, cand.by_doc_type, noise, "doc_type:"
        )
        other += _keyed_regressions(base.by_language, cand.by_language, noise, "language:")
        other += _keyed_regressions(base.by_language_pair, cand.by_language_pair, noise, "pair:")
        refusal = sorted(
            {
                metric
                for reference, target in ((base.overall, cand.overall), (base.doc_type_slice, cand.doc_type_slice))
                for metric in REFUSAL_METRICS
                if _drops(reference, target, (metric,), noise)
            }
        )
        present = sorted(set(cand.doc_by_language) | set(cand.by_language))
        supported = list(entry.supported_languages)
        undeclared = [language for language in present if language not in supported]
        if undeclared:
            notes.append(f"{profile_id}: language slice(s) {', '.join(undeclared)} undeclared in the catalog")
        if beats_baseline and not beats_control:
            notes.append(f"{profile_id}: {CONTROL_NOTE}")
        eligible = (
            beats_baseline and beats_control and not language_regressions and not pair_regressions and not other and not refusal
        )
        deltas_vs_baseline = _deltas(base.doc_type_slice, cand.doc_type_slice)
        if eligible:
            qualified.append(
                (
                    -(deltas_vs_baseline["recall_at_10"] or 0.0),
                    -(deltas_vs_baseline["mrr"] or 0.0),
                    entry.usd_per_million_tokens,
                    profile_id,
                )
            )
        results.append(
            BindingCandidateResult(
                profile_id=profile_id,
                model=entry.model,
                report_path=paths.get(profile_id, INLINE_REPORT),
                doc_type_slice=cand.doc_type_slice,
                by_language=cand.doc_by_language,
                deltas_vs_baseline=deltas_vs_baseline,
                deltas_vs_control=_deltas(ctrl.doc_type_slice, cand.doc_type_slice),
                beats_baseline=beats_baseline,
                beats_control=beats_control,
                language_regressions=language_regressions,
                pair_regressions=pair_regressions,
                other_slice_regressions=other,
                refusal_regressions=refusal,
                latency_ms=_latency(report),
                supported_languages=supported,
                undeclared_languages=undeclared,
                recommended=False,
            )
        )

    recommended: str | None = None
    if qualified:
        qualified.sort()
        recommended = qualified[0][3]
        for _, _, _, profile_id in qualified[1:]:
            notes.append(f"{profile_id}: qualified but not chosen (larger gain, then lower price, then lower id wins)")
        results = [
            result.model_copy(update={"recommended": True}) if result.profile_id == recommended else result for result in results
        ]

    provenance_counts = _provenance_counts(baseline, doc_type, tags)
    real_n = sum(count for provenance, count in provenance_counts.items() if provenance in REAL_PROVENANCES)
    if fixture_embedder or real_n == 0:
        notes.append(BINDING_FIXTURE_NOTE)

    return BindingComparison.model_validate(
        {
            "doc_type": doc_type,
            "baseline": _arm(baseline_profile, paths.get("baseline", INLINE_REPORT), base, baseline),
            "control": _arm(baseline_profile, paths.get("control", INLINE_REPORT), ctrl, control),
            "candidates": results,
            "provenance_counts": provenance_counts,
            "hashes": hashes,
            "reembed_run_ids": {profile_id: reembed_run_ids[profile_id] for profile_id in sorted(candidates)},
            "fixture_embedder": fixture_embedder,
            "gate_passed": recommended is not None,
            "recommended_profile": recommended,
            "notes": notes,
        }
    )
