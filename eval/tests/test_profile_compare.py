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
METRICS = (
    "recall_at_5",
    "recall_at_10",
    "mrr",
    "correct_refusal_rate",
    "false_refusal_rate",
)


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


# Phase 3.2.1 (D-27): the BGE-M3 arm, its serving-mode figures and the wiring-proof label.

import json
import re

import pytest
from pydantic import ValidationError
from rag_sidecar.contracts.profiles import ServingModeMeasurement

from rag_eval import profile_compare_cli
from rag_eval.profile_compare import (
    BGE_M3_PROFILE,
    NOT_MEASURED,
    WIRING_PROOF_LABEL,
    FixtureEvidenceRefused,
    render_comparison,
)

PAIRS = ("en->zh", "zh->en", "en->en")


def _pre_item() -> ItemResult:
    return ItemResult(
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


def _pair_report(value: float = 0.6) -> EvalReport:
    metrics = _slice_values(value)
    return _eval_report(
        overall=metrics,
        by_language={"en": metrics, "zh": metrics},
        by_category={"general": metrics, "cross_lingual": metrics},
        by_language_pair={pair: metrics for pair in PAIRS},
    )


HOSTED = ServingModeMeasurement(
    mode="hosted",
    measured=True,
    source="fixture embedder",
    ingest_chunks_per_second=125.5,
    query_embed_p50_ms=1.25,
    query_embed_p95_ms=3.5,
    usd_per_million_tokens=0.01,
    run_tokens=4000,
    run_cost_usd=0.00004,
)


def _three_arms(*, wiring_proof: bool = False, serving=None):
    noise = NoiseConfig.model_validate_json(NOISE_PATH.read_text(encoding="utf-8"))
    report = _pair_report()
    return build_comparison(
        (report, report),
        {"voyage-4-large-2048": (report, report), BGE_M3_PROFILE: (report, report)},
        baseline_profile="openai-3-small-1536",
        active_profile="openai-3-small-1536",
        noise=noise,
        pre_migration_items=[_pre_item()],
        backfill_run_id="01234567-0123-4012-8012-0123456789ab",
        serving={BGE_M3_PROFILE: [HOSTED]} if serving is None else serving,
        wiring_proof=wiring_proof,
    )


def _entry(comparison, profile_id):
    return next(entry for entry in comparison.profiles if entry.profile_id == profile_id)


def test_bge_arm_sits_beside_the_existing_arms_with_every_slice():
    comparison = _three_arms()
    assert [entry.profile_id for entry in comparison.profiles] == [
        "openai-3-small-1536",
        BGE_M3_PROFILE,
        "voyage-4-large-2048",
    ]
    bge = _entry(comparison, BGE_M3_PROFILE)
    for block in (bge.metrics.gated, bge.metrics.candidates):
        assert set(block.by_language) == {"en", "zh"}
        assert set(block.by_category) == {"general", "cross_lingual"}
        assert set(block.by_language_pair) == set(PAIRS)


def test_bge_arm_carries_a_hosted_and_a_sidecar_block_and_other_arms_none():
    comparison = _three_arms()
    bge = _entry(comparison, BGE_M3_PROFILE)
    assert bge.serving is not None
    assert [block.mode for block in bge.serving] == ["hosted", "sidecar"]
    hosted, sidecar = bge.serving
    assert hosted == HOSTED
    assert sidecar.measured is False
    assert sidecar.ingest_chunks_per_second is None
    assert sidecar.query_embed_p50_ms is None and sidecar.query_embed_p95_ms is None
    assert sidecar.usd_per_million_tokens is None and sidecar.run_cost_usd is None
    assert _entry(comparison, "voyage-4-large-2048").serving is None
    assert _entry(comparison, "openai-3-small-1536").serving is None


def test_bge_arm_without_measurements_shows_both_modes_unmeasured():
    comparison = _three_arms(serving={})
    bge = _entry(comparison, BGE_M3_PROFILE)
    assert [(block.mode, block.measured) for block in bge.serving] == [
        ("hosted", False),
        ("sidecar", False),
    ]


def test_report_lists_every_slice_and_pair_row_per_arm():
    text = render_comparison(_three_arms())
    for profile_id in ("openai-3-small-1536", BGE_M3_PROFILE, "voyage-4-large-2048"):
        assert f"== {profile_id}" in text, profile_id
        section = text.split(f"== {profile_id}", 1)[1].split("\n== ", 1)[0]
        for row in (
            "overall",
            "language:en",
            "language:zh",
            "category:cross_lingual",
            *[f"pair:{pair}" for pair in PAIRS],
        ):
            assert re.search(rf"^\s*{re.escape(row)}\s", section, re.MULTILINE), (
                profile_id,
                row,
            )


def test_report_prints_serving_figures_and_not_measured_without_a_number():
    text = render_comparison(_three_arms())
    hosted = next(line for line in text.splitlines() if line.strip().startswith("serving hosted"))
    sidecar = next(line for line in text.splitlines() if line.strip().startswith("serving sidecar"))
    assert "125.5 chunks/s" in hosted
    assert "p50 1.25 ms" in hosted and "p95 3.5 ms" in hosted
    assert "0.01 USD/1M tokens" in hosted
    assert NOT_MEASURED in sidecar
    assert not re.search(r"\d", sidecar)


def test_wiring_proof_run_is_labelled_and_carries_no_recommendation():
    comparison = _three_arms(wiring_proof=True)
    assert comparison.wiring_proof is True
    assert comparison.label == WIRING_PROOF_LABEL
    assert all(entry.default_candidate is None for entry in comparison.profiles)
    text = render_comparison(comparison)
    assert WIRING_PROOF_LABEL in text
    assert not re.search(r"recommend|winner|default candidate", text, re.IGNORECASE)


def test_non_fixture_run_names_default_candidates():
    text = render_comparison(_three_arms())
    assert "default candidate" in text


@pytest.mark.parametrize("target", ["voyage-4-large-2048", BGE_M3_PROFILE])
def test_wiring_proof_evidence_is_refused_for_every_arm(target):
    with pytest.raises(FixtureEvidenceRefused):
        comparison_to_activation_evidence(
            _three_arms(wiring_proof=True),
            target_profile=target,
            recorded_at="2026-11-24T12:00:00.000Z",
        )


def test_unmeasured_mode_cannot_carry_a_number():
    with pytest.raises(ValidationError):
        ServingModeMeasurement(mode="sidecar", measured=False, ingest_chunks_per_second=0.0)
    with pytest.raises(ValidationError):
        ServingModeMeasurement(mode="hosted", measured=True)


def test_cli_compares_several_arms_with_serving_and_wiring_proof(tmp_path):
    report = _pair_report()
    paths = {}
    for name in (
        "active_gated",
        "active_candidate",
        "voyage_gated",
        "voyage_candidate",
        "bge_gated",
        "bge_candidate",
    ):
        paths[name] = tmp_path / f"{name}.json"
        paths[name].write_text(report.model_dump_json(), encoding="utf-8")
    meta = tmp_path / "pre.json"
    meta.write_text(json.dumps({"corpus_documents_before_run": 0}), encoding="utf-8")
    serving = tmp_path / "serving.json"
    serving.write_text(json.dumps({BGE_M3_PROFILE: [HOSTED.model_dump(mode="json")]}), encoding="utf-8")
    out = tmp_path / "comparison.json"
    text_out = tmp_path / "comparison.txt"
    code = profile_compare_cli.main(
        [
            "--active-gated",
            str(paths["active_gated"]),
            "--active-candidate",
            str(paths["active_candidate"]),
            "--arm",
            "voyage-4-large-2048",
            str(paths["voyage_gated"]),
            str(paths["voyage_candidate"]),
            "--arm",
            BGE_M3_PROFILE,
            str(paths["bge_gated"]),
            str(paths["bge_candidate"]),
            "--serving",
            str(serving),
            "--wiring-proof",
            "--noise",
            str(NOISE_PATH),
            "--pre-migration-meta",
            str(meta),
            "--backfill-run-id",
            "01234567-0123-4012-8012-0123456789ab",
            "--out",
            str(out),
            "--text-out",
            str(text_out),
        ]
    )
    assert code == 0
    parsed = EmbeddingProfileComparison.model_validate_json(out.read_text(encoding="utf-8"))
    assert parsed.wiring_proof is True
    assert {entry.profile_id for entry in parsed.profiles} == {
        "openai-3-small-1536",
        "voyage-4-large-2048",
        BGE_M3_PROFILE,
    }
    assert [block.mode for block in _entry(parsed, BGE_M3_PROFILE).serving] == [
        "hosted",
        "sidecar",
    ]
    assert NOT_MEASURED in text_out.read_text(encoding="utf-8")
