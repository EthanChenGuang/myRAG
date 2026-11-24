from pathlib import Path

from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.profiles import (
    ActivationEvidence,
    ComparisonSliceBlock,
    EmbeddingProfileComparison,
    ProfileComparisonEntry,
    ProfileMetricBlocks,
)
from rag_sidecar.contracts.report import EvalReport, ItemResult, SliceMetrics

from rag_eval.profile_compare import (
    build_comparison,
    comparison_to_activation_evidence,
    default_candidate,
    profile_pair_gate_passed,
)

NOISE_PATH = Path(__file__).resolve().parents[1] / "config" / "noise.json"
METRICS = ("recall_at_5", "recall_at_10", "mrr", "correct_refusal_rate", "false_refusal_rate")


def _slice_values(value: float = 0.6, **overrides: float | None) -> SliceMetrics:
    from rag_sidecar.contracts.report import MetricValue

    values = {metric: MetricValue(value=overrides.get(metric, value), n=24) for metric in METRICS}
    return SliceMetrics(**values)


def _eval_report(**fields) -> EvalReport:
    slice_metrics = _slice_values()
    data = {
        "run_id": "run-x",
        "tier": "smoke",
        "run_config_hash": "r" * 64,
        "corpus_sha256": "c" * 64,
        "golden_sha256": "g" * 64,
        "golden_filter": {"review_statuses": ["approved"], "gate_split": "dev"},
        "embedder_id": "fixture-embedder",
        "embedder_version": 3,
        "deployment_mode": "single-tenant",
        "request_options": {},
        "k_values": [5, 10],
        "overall": slice_metrics,
        "by_language": {"en": slice_metrics, "zh": slice_metrics},
        "by_category": {"general": slice_metrics, "cross_lingual": slice_metrics},
        "by_language_category": {},
        "by_language_pair": {"en->zh": slice_metrics},
        "by_split": {},
        "items": [],
    }
    data.update(fields)
    return EvalReport.model_validate(data)


def test_default_candidate_beats_on_strictly_greater_cross_lingual_recall():
    slice_metrics = _slice_values()
    high_cross = _slice_values(recall_at_10=0.8)
    low_cross = _slice_values(recall_at_10=0.5)
    block = ComparisonSliceBlock(
        overall=slice_metrics,
        by_language={"en": slice_metrics},
        by_category={"cross_lingual": high_cross},
        by_language_pair={},
    )
    baseline = ProfileComparisonEntry(
        profile_id="openai-3-small-1536",
        metrics=ProfileMetricBlocks(
            gated=block,
            candidates=block.model_copy(update={"by_category": {"cross_lingual": low_cross}}),
        ),
    )
    target = ProfileComparisonEntry(
        profile_id="voyage-4-large-2048",
        metrics=ProfileMetricBlocks(gated=block, candidates=block),
    )
    assert default_candidate("voyage-4-large-2048", target, baseline) is True


def test_default_candidate_rejects_ties():
    slice_metrics = _slice_values(recall_at_10=0.5)
    block = ComparisonSliceBlock(
        overall=slice_metrics,
        by_language={},
        by_category={"cross_lingual": slice_metrics},
        by_language_pair={},
    )
    entry = ProfileComparisonEntry(
        profile_id="voyage-4-large-2048",
        metrics=ProfileMetricBlocks(gated=block, candidates=block),
    )
    baseline = entry.model_copy(update={"profile_id": "openai-3-small-1536"})
    assert default_candidate("voyage-4-large-2048", entry, baseline) is False


def test_profile_pair_gate_passes_matching_fixture_reports():
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    active = _eval_report()
    assert profile_pair_gate_passed(active, active, noise) is True


def test_build_comparison_round_trips_contract():
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    active = _eval_report()
    comparison = build_comparison(
        (active, active),
        {"voyage-4-large-2048": (active, active)},
        baseline_profile="openai-3-small-1536",
        active_profile="openai-3-small-1536",
        noise=noise,
        pre_migration_items=[
            ItemResult(
                item_id="x",
                language="en",
                category="general",
                split="dev",
                provenance="synthetic_fixture",
                answerable=True,
                refused=False,
                span_count=1,
                spans_hit_at_5=1,
                spans_hit_at_10=1,
                first_hit_rank=1,
            )
        ],
        backfill_run_id="01234567-0123-4012-8012-0123456789ab",
    )
    parsed = EmbeddingProfileComparison.model_validate_json(comparison.model_dump_json())
    assert parsed.gate_passed is True
    assert len(parsed.profiles) == 2


def test_activation_evidence_shape():
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    active = _eval_report()
    comparison = build_comparison(
        (active, active),
        {"voyage-4-large-2048": (active, active)},
        baseline_profile="openai-3-small-1536",
        active_profile="openai-3-small-1536",
        noise=noise,
        pre_migration_items=[
            ItemResult(
                item_id="x",
                language="en",
                category="general",
                split="dev",
                provenance="synthetic_fixture",
                answerable=True,
                refused=False,
                span_count=1,
                spans_hit_at_5=1,
                spans_hit_at_10=1,
                first_hit_rank=1,
            )
        ],
        backfill_run_id="01234567-0123-4012-8012-0123456789ab",
    )
    evidence = comparison_to_activation_evidence(
        comparison,
        target_profile="voyage-4-large-2048",
        recorded_at="2026-11-24T12:00:00.000Z",
    )
    ActivationEvidence.model_validate(evidence.model_dump())