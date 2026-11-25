"""Per-page escalation (plan 03.1-42): planner, kept results, needs_review outcomes (D-15, D-16, D-52)."""

from __future__ import annotations

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import QualityScoreWeights
from rag_sidecar.ingest import escalation
from rag_sidecar.ingest.escalation import EscalationUnit, PageAttempt

LADDER = ["fast", "structured", "premium"]
WEIGHTS = QualityScoreWeights(garbled=0.3, low_chars=0.3, missing_table=0.2, language=0.2)


def _snapshot(**overrides) -> JobSettingsSnapshot:
    base = {
        "routing": "tiered",
        "cloud_allowed": True,
        "escalation": True,
        "progressive": False,
        "premium_max_pages_per_doc": 200,
        "premium_page_budget": 100,
        "vlm_detect": False,
        "profile_id": "general@1",
        "profile_version": 1,
        "doc_type": "general",
        "min_tier": "fast",
        "max_tier": "premium",
        "embed_mode": "sync",
        "ocr_languages": ["en"],
        "routing_config_version": "1",
    }
    base.update(overrides)
    return JobSettingsSnapshot.model_validate(base)


def _range(start: int, end: int, *, seq: int, tier: str = "fast", preset: str = "fast", failing: dict[int, tuple[str, ...]] | None = None, reason: str = "initial"):
    failing = failing or {}
    return {
        page: [PageAttempt(seq=seq, tier=tier, preset=preset, reason=reason, failed=failing.get(page, ()), score=0.4 if page in failing else 1.0)]
        for page in range(start, end + 1)
    }


def _units(plan) -> list[tuple[int, int, str, str, str]]:
    return [(unit.start, unit.end, unit.tier, unit.preset, unit.reason) for unit in plan.units]


# ---------------------------------------------------------------------------------------------------------------------
# Units and presets
# ---------------------------------------------------------------------------------------------------------------------


def test_failing_pages_three_four_and_seven_of_a_fast_range_give_two_units_at_structured_ocr_for_low_chars():
    history = _range(1, 10, seq=1, failing={3: ("low_chars",), 4: ("low_chars",), 7: ("low_chars",)})

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(3, 4, "structured", "structured_ocr", "escalation"), (7, 7, "structured", "structured_ocr", "escalation")]
    assert all(unit.source_seq == 1 for unit in plan.units)
    assert plan.blocked == {}


def test_the_structured_preset_follows_the_failed_condition():
    history = {
        **_range(1, 1, seq=1, failing={1: ("empty_text",)}),
        **_range(2, 2, seq=2, failing={2: ("garbled",)}),
        **_range(3, 3, seq=3, failing={3: ("language_mismatch",)}),
        **_range(4, 4, seq=4, failing={4: ("missing_table",)}),
        **_range(5, 5, seq=5, failing={5: ("partial_conversion",)}),
        **_range(6, 6, seq=6, failing={6: ("table_boundary",)}),
        **_range(7, 7, seq=7, failing={7: ("missing_table", "low_chars")}),
    }

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert [(unit.start, unit.preset) for unit in plan.units] == [
        (1, "structured_ocr"),
        (2, "structured_ocr"),
        (3, "structured_ocr"),
        (4, "structured_full"),
        (5, "structured_full"),
        (6, "structured_layout"),
        (7, "structured_ocr"),
    ]


def test_a_run_of_failing_pages_does_not_cross_the_range_it_came_from():
    history = {**_range(1, 4, seq=1, failing={4: ("low_chars",)}), **_range(5, 8, seq=2, failing={5: ("low_chars",)})}

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(4, 4, "structured", "structured_ocr", "escalation"), (5, 5, "structured", "structured_ocr", "escalation")]


def test_a_failing_structured_page_steps_to_premium():
    history = _range(1, 3, seq=1, tier="structured", preset="structured_full", failing={2: ("missing_table",)})

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(2, 2, "premium", "premium", "escalation")]


def test_passing_pages_and_pages_with_a_passing_attempt_are_never_planned():
    history = _range(1, 3, seq=1, failing={2: ("low_chars",)})
    history[2] = [*history[2], PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation")]

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert plan.units == ()
    assert plan.blocked == {}


# ---------------------------------------------------------------------------------------------------------------------
# Limits and needs_review reasons
# ---------------------------------------------------------------------------------------------------------------------


def test_a_page_escalated_twice_is_not_planned_again_and_is_blocked_with_escalations_exhausted():
    history = _range(1, 2, seq=1, failing={1: ("low_chars",)})
    history[1] = [
        *history[1],
        PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation", failed=("low_chars",), score=0.5),
        PageAttempt(seq=3, tier="premium", preset="premium", reason="escalation", failed=("low_chars",), score=0.6),
    ]

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "escalations_exhausted"}


def test_the_two_escalation_limit_comes_from_the_routing_data():
    history = _range(1, 1, seq=1, failing={1: ("low_chars",)})
    history[1] = [*history[1], PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation", failed=("low_chars",))]

    assert escalation.plan_escalations(history, _snapshot(), LADDER, max_per_page=1).blocked == {1: "escalations_exhausted"}
    assert _units(escalation.plan_escalations(history, _snapshot(), LADDER, max_per_page=2)) == [(1, 1, "premium", "premium", "escalation")]


def test_max_tier_structured_blocks_the_step_to_premium():
    history = _range(1, 2, seq=1, tier="structured", preset="structured_full", failing={2: ("missing_table",)})

    plan = escalation.plan_escalations(history, _snapshot(max_tier="structured"), LADDER)

    assert plan.units == ()
    assert plan.blocked == {2: "max_tier"}


def test_max_tier_fast_blocks_the_first_step():
    history = _range(1, 2, seq=1, failing={1: ("low_chars",)})

    plan = escalation.plan_escalations(history, _snapshot(min_tier="fast", max_tier="fast"), LADDER)

    assert plan.blocked == {1: "max_tier"}


def test_a_failing_premium_page_has_nowhere_to_go():
    history = _range(1, 1, seq=1, tier="premium", preset="premium", failing={1: ("garbled",)})

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "max_tier"}


def test_escalation_off_blocks_every_failing_page():
    history = _range(1, 3, seq=1, failing={1: ("low_chars",), 3: ("missing_table",)})

    plan = escalation.plan_escalations(history, _snapshot(escalation=False), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "escalation_off", 3: "escalation_off"}


def test_the_cloud_switch_in_the_snapshot_blocks_a_premium_step_without_a_request():
    history = _range(1, 2, seq=1, tier="structured", preset="structured_ocr", failing={1: ("low_chars",)})

    plan = escalation.plan_escalations(history, _snapshot(cloud_allowed=False), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "cloud_not_allowed"}


def test_a_page_the_guard_already_refused_premium_is_not_asked_again():
    history = _range(1, 2, seq=2, tier="structured", preset="structured_full", failing={1: ("missing_table",)})
    for page in (1, 2):
        history[page] = [PageAttempt(seq=1, tier="premium", preset="premium", refused="budget_exhausted"), *history[page]]

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "budget_exhausted"}


def test_premium_units_over_the_page_cap_are_all_blocked():
    history = _range(1, 6, seq=1, tier="structured", preset="structured_full", failing={1: ("missing_table",), 2: ("missing_table",), 5: ("garbled",)})
    history.update(_range(7, 8, seq=2, tier="premium", preset="premium"))

    plan = escalation.plan_escalations(history, _snapshot(premium_max_pages_per_doc=4), LADDER)

    assert plan.units == ()
    assert plan.blocked == {1: "over_page_cap", 2: "over_page_cap", 5: "over_page_cap"}
    assert _units(escalation.plan_escalations(history, _snapshot(premium_max_pages_per_doc=5), LADDER)) == [
        (1, 2, "premium", "premium", "escalation"),
        (5, 5, "premium", "premium", "escalation"),
    ]


# ---------------------------------------------------------------------------------------------------------------------
# D-52: table boundary neighbours
# ---------------------------------------------------------------------------------------------------------------------


def test_a_table_boundary_neighbour_is_pulled_into_the_higher_preset_with_its_own_reason():
    history = {
        **_range(1, 2, seq=1, tier="structured", preset="structured_full"),
        **_range(3, 5, seq=2, failing={3: ("table_boundary",)}),
    }

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(3, 3, "structured", "structured_full", "table_boundary")]


def test_table_boundary_attempts_do_not_count_toward_the_two_escalations():
    history = {
        **_range(1, 2, seq=1, tier="structured", preset="structured_full"),
        **_range(3, 3, seq=2, failing={3: ("low_chars",)}),
    }
    history[3] = [
        *history[3],
        PageAttempt(seq=3, tier="structured", preset="structured_full", reason="table_boundary", failed=("low_chars",)),
        PageAttempt(seq=4, tier="structured", preset="structured_ocr", reason="escalation", failed=("low_chars",)),
    ]

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(3, 3, "premium", "premium", "escalation")]


def test_a_table_boundary_failure_is_pulled_only_once_then_escalates():
    history = {**_range(1, 1, seq=1, tier="structured", preset="structured_full"), **_range(2, 2, seq=2, failing={2: ("table_boundary",)})}
    history[2] = [*history[2], PageAttempt(seq=3, tier="structured", preset="structured_full", reason="table_boundary", failed=("table_boundary",))]

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(2, 2, "premium", "premium", "escalation")]


def test_a_table_boundary_page_whose_neighbour_is_not_higher_escalates_normally():
    history = {**_range(1, 1, seq=1), **_range(2, 2, seq=2, failing={2: ("table_boundary",)})}

    plan = escalation.plan_escalations(history, _snapshot(), LADDER)

    assert _units(plan) == [(2, 2, "structured", "structured_layout", "escalation")]


# ---------------------------------------------------------------------------------------------------------------------
# Kept results
# ---------------------------------------------------------------------------------------------------------------------


def test_the_kept_result_is_the_first_passing_attempt():
    history = {
        1: [
            PageAttempt(seq=1, tier="fast", preset="fast", failed=("low_chars",), score=0.7),
            PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation", score=0.9),
            PageAttempt(seq=3, tier="premium", preset="premium", reason="escalation", score=1.0),
        ]
    }

    assert escalation.choose_kept(history)[1].seq == 2


def test_without_a_passing_attempt_the_best_score_is_kept_and_ties_go_to_the_earlier_attempt():
    history = {
        1: [
            PageAttempt(seq=1, tier="fast", preset="fast", failed=("low_chars",), score=0.5),
            PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation", failed=("garbled",), score=0.8),
            PageAttempt(seq=3, tier="premium", preset="premium", reason="escalation", failed=("garbled",), score=0.6),
        ],
        2: [
            PageAttempt(seq=1, tier="fast", preset="fast", failed=("low_chars",), score=0.7),
            PageAttempt(seq=2, tier="structured", preset="structured_ocr", reason="escalation", failed=("garbled",), score=0.7),
        ],
    }

    kept = escalation.choose_kept(history)

    assert kept[1].seq == 2
    assert kept[2].seq == 1


def test_a_refused_attempt_is_never_kept():
    history = {
        1: [
            PageAttempt(seq=1, tier="premium", preset="premium", refused="budget_exhausted", score=1.0),
            PageAttempt(seq=2, tier="structured", preset="structured_full", failed=("missing_table",), score=0.8),
        ]
    }

    assert escalation.choose_kept(history)[1].seq == 2


def test_the_page_score_takes_the_routing_weights_and_caps_empty_text():
    assert escalation.page_score((), WEIGHTS) == 1.0
    assert escalation.page_score(("low_chars",), WEIGHTS) == 0.7
    assert escalation.page_score(("missing_table", "language_mismatch"), WEIGHTS) == 0.6
    assert escalation.page_score(("garbled",), WEIGHTS) == 0.7
    assert escalation.page_score(("empty_text",), WEIGHTS) == 0.7
    assert escalation.page_score(("empty_text", "low_chars"), WEIGHTS) == 0.7
    assert escalation.page_score(("partial_conversion",), WEIGHTS) < 1.0
    assert escalation.page_score(("table_boundary",), WEIGHTS) < 1.0


# ---------------------------------------------------------------------------------------------------------------------
# D-16: needs_review outcomes
# ---------------------------------------------------------------------------------------------------------------------


def test_a_premium_step_refused_for_cloud_ends_needs_review_only_when_the_check_failed():
    failing = {1: [PageAttempt(seq=1, tier="premium", preset="premium", refused="cloud_not_allowed"), PageAttempt(seq=2, tier="structured", preset="structured_full", failed=("missing_table",))]}
    plan = escalation.plan_escalations(failing, _snapshot(), LADDER)
    outcome = escalation.review(failing, plan.blocked)

    assert outcome.needs_review == {1: "cloud_not_allowed"}
    assert outcome.reason == "cloud_not_allowed"

    passing = {1: [PageAttempt(seq=1, tier="premium", preset="premium", refused="cloud_not_allowed"), PageAttempt(seq=2, tier="structured", preset="structured_full")]}
    outcome = escalation.review(passing, escalation.plan_escalations(passing, _snapshot(), LADDER).blocked)

    assert outcome.needs_review == {}
    assert outcome.reason is None
    assert outcome.routing_note == "premium_blocked:cloud_not_allowed"


def test_a_premium_tier_page_blocked_by_the_budget_ends_needs_review_even_when_the_lower_tier_passed():
    history = {
        page: [PageAttempt(seq=1, tier="premium", preset="premium", refused="budget_exhausted"), PageAttempt(seq=2, tier="structured", preset="structured_full")]
        for page in (7, 8)
    }
    history.update(_range(1, 6, seq=3))

    outcome = escalation.review(history, escalation.plan_escalations(history, _snapshot(), LADDER).blocked)

    assert outcome.needs_review == {7: "budget_exhausted", 8: "budget_exhausted"}
    assert outcome.reason == "budget_exhausted"
    assert outcome.routing_note is None


def test_an_over_cap_premium_page_ends_needs_review_with_over_page_cap():
    history = {1: [PageAttempt(seq=1, tier="premium", preset="premium", refused="over_page_cap"), PageAttempt(seq=2, tier="structured", preset="structured_full")]}

    outcome = escalation.review(history, {})

    assert outcome.needs_review == {1: "over_page_cap"}
    assert outcome.reason == "over_page_cap"


def test_a_budget_reason_wins_over_a_quality_reason_because_a_retry_may_do_better():
    history = {
        1: [PageAttempt(seq=1, tier="fast", preset="fast", failed=("low_chars",))],
        5: [PageAttempt(seq=2, tier="premium", preset="premium", refused="budget_exhausted"), PageAttempt(seq=3, tier="structured", preset="structured_full")],
    }

    outcome = escalation.review(history, {1: "escalation_off"})

    assert outcome.needs_review == {1: "escalation_off", 5: "budget_exhausted"}
    assert outcome.reason == "budget_exhausted"


def test_every_blocked_page_is_marked_with_its_reason_and_the_first_page_names_the_job_reason():
    history = _range(1, 4, seq=1, failing={2: ("low_chars",), 4: ("low_chars",)})

    outcome = escalation.review(history, {2: "max_tier", 4: "escalations_exhausted"})

    assert outcome.needs_review == {2: "max_tier", 4: "escalations_exhausted"}
    assert outcome.reason == "max_tier"


def test_a_clean_document_needs_no_review():
    history = _range(1, 3, seq=1)

    outcome = escalation.review(history, escalation.plan_escalations(history, _snapshot(), LADDER).blocked)

    assert outcome == escalation.ReviewOutcome(needs_review={}, reason=None, routing_note=None)


def test_a_failing_page_left_without_a_plan_still_needs_review():
    history = _range(1, 2, seq=1, failing={2: ("garbled",)})

    outcome = escalation.review(history, {})

    assert outcome.needs_review == {2: "quality_check_failed"}


def test_units_are_value_objects():
    assert EscalationUnit(1, 2, "structured", "structured_ocr", "escalation", 1) == EscalationUnit(1, 2, "structured", "structured_ocr", "escalation", 1)


# =====================================================================================================================
# Task 2: the escalation loop in the tiered flow
# =====================================================================================================================

import asyncio
import importlib
from pathlib import Path
from typing import Any

import pytest


def _available(*modules: str) -> bool:
    try:
        for module in modules:
            importlib.import_module(module)
    except ImportError:
        return False
    return True


_FLOW = _available("docling_core.transforms.chunker.hybrid_chunker", "tiktoken", "pypdfium2", "pdfplumber")
flow = pytest.mark.skipif(not _FLOW, reason="the tiered flow needs the chunking and preflight extras")

if _FLOW:
    from docling_core.types.doc import DoclingDocument
    from ingest_fakes import AppScript
    from test_ingest_tiered import (
        _PAGE,
        _WORKER,
        PDF,
        RECORDED,
        SHA,
        Env,
        SyntheticConverter,
        _job,
        _merged_entries,
        _object,
        _premium_calls,
        _synthetic_preflight,
    )

    from rag_sidecar.contracts.ingest import ParseResult
    from rag_sidecar.contracts.routing import PageRange
    from rag_sidecar.ingest import converters, quality, tiered
    from rag_sidecar.ingest.merge import join_page_parts, premium_part
    from rag_sidecar.ingest.process_job import JobOutcome
    from rag_sidecar.parse import docling_adapter
    from rag_sidecar.preflight.config import load_routing_config
    from rag_sidecar.preflight.run import PreflightOutput, run_preflight


class BlankPages:
    """Delegates to a converter but returns an empty page (or the given plain text) for chosen (preset, page) pairs."""

    def __init__(self, inner, blank: set[tuple[str, int]], texts: dict[tuple[str, int], str] | None = None) -> None:
        self.inner = inner
        self.texts = {key: "" for key in blank} | (texts or {})
        self.calls: list[tuple[str, int, int]] = []

    def convert(self, path, file_sha256, preset, start, end, priority):
        self.calls.append((preset, start, end))
        parts = []
        for page in range(start, end + 1):
            if (preset, page) in self.texts:
                converters._increment_conversion_counter()
                parts.append(premium_part([(page, self.texts[(preset, page)])], {page: _PAGE}))
            else:
                parts.append(self.inner.convert(path, file_sha256, preset, page, page, priority)[0])
        return join_page_parts(parts), {"preset": preset, "start": start, "end": end}


def _forced_preflight(fixture: str, ranges: list[tuple[int, int, str]], rows: dict[int, dict[str, Any]] | None = None):
    """The real probe of a fixture (its page signals), with the ranges forced so a test can put a page on the wrong preset."""
    cfg = load_routing_config()
    probed = run_preflight(PDF[fixture], None, cfg, converters.RecordedRangeConverter(RECORDED), file_sha=SHA[fixture]).result
    tier_of = {"fast": "fast", "premium": "premium"}
    rows = rows or {}
    forced = probed.model_copy(
        update={
            "pages": [row.model_copy(update=rows.get(row.page, {})) for row in probed.pages],
            "ranges": [
                PageRange(
                    start=start, end=end, tier=tier_of.get(preset, "structured"), preset=preset,
                    parser="llamaparse" if preset == "premium" else "docling", layer="L1", signals=[], status="pending",
                )
                for start, end, preset in ranges
            ]
        }
    )

    def run(path, settings, cfg, converter, file_sha=None):
        return PreflightOutput(result=forced, reusable_fast={})

    return run


def _fixture_job_env(tmp_path: Path, fixture: str, converter, preflight, **settings) -> Env:
    job = _job(sha=SHA[fixture], **settings)
    return Env(tmp_path, job, PDF[fixture].read_bytes(), converter=converter, preflight=preflight)


def _attempts(env: Env) -> list[tuple[str, str, int, int]]:
    return [(a.reason, a.preset, a.pages.start, a.pages.end) for a in env.job.attempts]


def _ranges(env: Env) -> list[tuple[int, int, str, str]]:
    return [(r.start, r.end, r.preset, r.status) for r in env.job.page_ranges]


def _merged_doc(env: Env) -> DoclingDocument:
    merged = _merged_entries(env)[0]
    payload = __import__("json").loads(_object(env, merged.object_prefix, "docling.json"))
    payload.pop(docling_adapter.SIDECAR_METADATA_KEY, None)
    return DoclingDocument.model_validate(payload)


def _recorded_text(fixture: str, preset: str, page: int) -> str:
    doc, _meta = converters.RecordedRangeConverter(RECORDED).convert(PDF[fixture], SHA[fixture], preset, page, page, 100)
    return quality.page_text(doc, page)


def _scanned_page_in_a_fast_range(tmp_path: Path, **settings) -> Env:
    converter = BlankPages(converters.RecordedRangeConverter(RECORDED), {("fast", 9)})
    preflight = _forced_preflight("mixed-routing", [(1, 6, "fast"), (7, 8, "structured_full"), (9, 10, "fast")])
    env = _fixture_job_env(tmp_path, "mixed-routing", converter, preflight, **settings)
    env.blank = converter  # type: ignore[attr-defined]
    return env


@flow
def test_a_scanned_page_in_a_fast_range_is_re_parsed_at_structured_ocr_and_only_that_page_is_converted_again(tmp_path):
    env = _scanned_page_in_a_fast_range(tmp_path)
    converters.reset_conversion_counter()

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _attempts(env) == [
        ("initial", "fast", 1, 6),
        ("initial", "structured_full", 7, 8),
        ("initial", "fast", 9, 10),
        ("escalation", "structured_ocr", 9, 9),
    ]
    initial = env.job.attempts[2]
    assert initial.check is not None and not initial.check.passed
    assert {p.page: p.failed for p in initial.check.pages}[9][:1] == ["empty_text"]
    assert env.job.attempts[3].check is not None and env.job.attempts[3].check.passed
    assert env.job.attempts[3].tier == "structured" and env.job.attempts[3].cache_hit is False
    assert env.job.escalations == 1
    assert converters.conversion_counter == 11, "ten pages once, plus page 9 again"
    assert env.blank.calls[-1] == ("structured_ocr", 9, 9)  # type: ignore[attr-defined]
    assert _ranges(env) == [(1, 6, "fast", "ok"), (7, 8, "structured_full", "ok"), (9, 9, "structured_ocr", "escalated"), (10, 10, "fast", "ok")]
    assert env.job.needs_review_reason is None

    merged = _merged_doc(env)
    assert sorted(merged.pages) == list(range(1, 11))
    assert quality.page_text(merged, 9) == _recorded_text("mixed-routing", "structured_ocr", 9)
    assert quality.page_text(merged, 9).strip()
    assert quality.page_text(merged, 10) == _recorded_text("mixed-routing", "fast", 10)
    assert quality.page_text(merged, 3) == _recorded_text("mixed-routing", "fast", 3)
    advance = [call[2] for call in env.app.calls if call[0] == "advance"]
    assert advance[0]["parse_cache_id"] == _merged_entries(env)[0].id


@flow
def test_an_escalation_is_its_own_cache_entry_and_the_passing_ranges_are_not_written_again(tmp_path):
    env = _scanned_page_in_a_fast_range(tmp_path)

    env.run()

    docling = [entry for entry in env.ledger.cache.values() if entry.parser == "docling"]
    hashes = {entry.options_hash for entry in docling}
    cfg = env.cfg
    assert tiered.range_options_hash("structured_ocr", 9, 9, ["en"], cfg) in hashes
    assert tiered.range_options_hash("fast", 9, 10, ["en"], cfg) in hashes
    assert len(docling) == 4


@flow
def test_a_finished_escalated_job_run_again_converts_nothing_and_records_no_attempt_twice(tmp_path):
    env = _scanned_page_in_a_fast_range(tmp_path)
    env.run()
    before = converters.conversion_counter
    merged_id = _merged_entries(env)[0].id

    env.claim()
    again = env.run()

    assert again == JobOutcome(status="ready")
    assert converters.conversion_counter == before
    assert len(env.job.attempts) == 4
    assert env.job.escalations == 1
    assert [call[2]["parse_cache_id"] for call in env.app.calls if call[0] == "advance"] == [merged_id, merged_id]


@flow
def test_escalation_off_leaves_the_failing_page_on_its_tier_and_marks_it_for_review(tmp_path):
    env = _scanned_page_in_a_fast_range(tmp_path, escalation=False)

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert [a.reason for a in env.job.attempts] == ["initial", "initial", "initial"]
    assert env.job.escalations == 0
    assert env.job.needs_review_reason == "escalation_off"
    assert _ranges(env) == [(1, 6, "fast", "ok"), (7, 8, "structured_full", "ok"), (9, 9, "fast", "needs_review"), (10, 10, "fast", "ok")]


@flow
def test_a_page_that_fails_twice_stops_at_max_tier_and_keeps_its_best_result(tmp_path):
    converter = BlankPages(converters.RecordedRangeConverter(RECORDED), {("fast", 9), ("structured_ocr", 9)})
    preflight = _forced_preflight("mixed-routing", [(1, 6, "fast"), (7, 8, "structured_full"), (9, 10, "fast")])
    env = _fixture_job_env(tmp_path, "mixed-routing", converter, preflight, max_tier="structured")

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _attempts(env)[-1] == ("escalation", "structured_ocr", 9, 9)
    assert len(env.job.attempts) == 4
    assert env.job.needs_review_reason == "max_tier"
    assert (9, 9, "fast", "needs_review") in _ranges(env), "equal scores keep the earlier attempt"
    assert _premium_calls(env) == []


_PLAIN_ROWS = "Margin 13 14 15 Notes steady up up"


def _boundary_env(tmp_path: Path, rows: dict[int, dict[str, Any]], texts: dict[tuple[str, int], str], **settings) -> Env:
    """cross-boundary with the table range cut after page 4: page 5 starts a fast range with numeric rows and no table."""
    converter = BlankPages(converters.RecordedRangeConverter(RECORDED), set(), texts)
    preflight = _forced_preflight("cross-boundary", [(1, 3, "fast"), (4, 4, "structured_full"), (5, 6, "fast")], rows)
    return _fixture_job_env(tmp_path, "cross-boundary", converter, preflight, **settings)


@flow
def test_a_table_cut_by_a_range_boundary_pulls_the_next_page_into_the_table_preset_without_an_escalation(tmp_path):
    env = _boundary_env(tmp_path, {5: {"ruled_tables": 0, "signals": [], "aligned_number_rows": 2}}, {("fast", 5): _PLAIN_ROWS})

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _attempts(env) == [
        ("initial", "fast", 1, 3),
        ("initial", "structured_full", 4, 4),
        ("initial", "fast", 5, 6),
        ("table_boundary", "structured_full", 5, 5),
    ]
    assert env.job.escalations == 0
    initial = env.job.attempts[2]
    assert initial.check is not None and {p.page: p.failed for p in initial.check.pages}[5] == ["table_boundary"]
    pulled = env.job.attempts[3]
    assert pulled.tier == "structured" and pulled.check is not None and pulled.check.passed
    assert _ranges(env) == [(1, 3, "fast", "ok"), (4, 4, "structured_full", "ok"), (5, 5, "structured_full", "escalated"), (6, 6, "fast", "ok")]
    assert env.job.needs_review_reason is None
    merged = _merged_doc(env)
    assert quality.page_has_table(merged, 5)


@flow
def test_the_boundary_rule_repeats_while_the_next_page_has_numeric_rows_and_no_table(tmp_path):
    rows = {
        5: {"ruled_tables": 0, "signals": [], "aligned_number_rows": 2},
        6: {"aligned_number_rows": 2},
    }
    env = _boundary_env(tmp_path, rows, {("fast", 5): _PLAIN_ROWS}, max_tier="structured")

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _attempts(env)[3:] == [("table_boundary", "structured_full", 5, 5), ("table_boundary", "structured_full", 6, 6)]
    assert env.job.escalations == 0
    assert env.job.needs_review_reason == "max_tier", "page 6 still has no table and may not climb above structured"
    assert _ranges(env)[-1] == (6, 6, "fast", "needs_review")


# ---------------------------------------------------------------------------------------------------------------------
# Premium steps and blocks
# ---------------------------------------------------------------------------------------------------------------------

_TABLE_MD = "| Lane | Value |\n| --- | --- |\n| A | 1 |"


def _structured_table_env(tmp_path: Path, **settings) -> Env:
    """Pages 1-2 structured_full whose preflight says page 2 has a table the synthetic converter never produces."""
    converter = SyntheticConverter()
    preflight = _synthetic_preflight(3, [(1, 2, "structured_full"), (3, 3, "fast")])
    base = preflight(None, None, None, None).result
    rows = [row.model_copy(update={"ruled_tables": 1}) if row.page == 2 else row for row in base.pages]
    forced = base.model_copy(update={"pages": rows})
    env = Env(
        tmp_path,
        _job(sha="d" * 64, **settings),
        PDF["mixed-routing"].read_bytes(),
        converter=converter,
        preflight=lambda path, s, cfg, conv, file_sha=None: PreflightOutput(result=forced, reusable_fast={}),
    )
    env.synthetic = converter  # type: ignore[attr-defined]
    return env


def _premium_page_two() -> dict:
    return {"worker_id": _WORKER, "status": "done", "cache_id": "00000000-0000-4000-8000-0000000000c1", "pages": [{"page": 2, "text": _TABLE_MD, "has_table": True}]}


@flow
def test_a_failing_structured_page_climbs_to_premium_through_parse_external(tmp_path):
    env = _structured_table_env(tmp_path)
    env.app.script("parse_external", [AppScript(response=_premium_page_two())])

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    (call,) = _premium_calls(env)
    assert call["mode"] == "premium" and call["pages"] == {"start": 2, "end": 2}
    assert __import__("json").loads(call["cursor"]) == {"original_pages": [2], "reserve_pages": 1}
    assert call["attempt_no"] == 3
    assert _attempts(env) == [("initial", "structured_full", 1, 2), ("initial", "fast", 3, 3), ("escalation", "premium", 2, 2)]
    premium = env.job.attempts[2]
    assert (premium.tier, premium.parser, premium.refused) == ("premium", "llamaparse", False)
    assert premium.est_cost_usd == pytest.approx(env.cfg.costs.tier.premium.usd_per_page)
    assert env.job.escalations == 1
    assert [(r.start, r.end, r.tier, r.parser, r.status) for r in env.job.page_ranges] == [
        (1, 1, "structured", "docling", "ok"),
        (2, 2, "premium", "llamaparse", "escalated"),
        (3, 3, "fast", "docling", "ok"),
    ]
    assert env.job.tier == "premium"
    result = ParseResult.model_validate_json(_object(env, _merged_entries(env)[0].object_prefix, "result.json"))
    assert result.markdown.index("Synthetic page 1 text.") < result.markdown.index("Lane") < result.markdown.index("Synthetic page 3 text.")


@flow
def test_a_premium_escalation_refused_by_the_budget_is_recorded_and_marks_the_page_for_review(tmp_path):
    env = _structured_table_env(tmp_path)
    env.app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "refused", "reason": "budget_exhausted"})])

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert len(_premium_calls(env)) == 1, "a refused page is not asked again"
    assert [(a.reason, a.preset, a.refused) for a in env.job.attempts][-1] == ("escalation", "premium", True)
    assert env.job.escalations == 1
    assert env.job.needs_review_reason == "budget_exhausted"
    assert [(r.start, r.end, r.status) for r in env.job.page_ranges] == [(1, 1, "ok"), (2, 2, "needs_review"), (3, 3, "ok")]


@flow
def test_with_the_cloud_off_in_the_snapshot_no_premium_step_is_requested(tmp_path):
    env = _structured_table_env(tmp_path, cloud_allowed=False)

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _premium_calls(env) == []
    assert env.job.escalations == 0
    assert env.job.needs_review_reason == "cloud_not_allowed"


@flow
def test_an_initial_premium_range_is_not_requested_when_the_snapshot_forbids_the_cloud(tmp_path):
    converter = SyntheticConverter()
    env = Env(
        tmp_path, _job(sha="b" * 64, cloud_allowed=False), PDF["mixed-routing"].read_bytes(), converter=converter,
        preflight=_synthetic_preflight(10, [(1, 6, "fast"), (7, 8, "premium"), (9, 10, "fast")]),
    )
    env.app.script("parse_external", [AppScript(response={"worker_id": _WORKER, "status": "refused", "reason": "cloud_not_allowed"})])

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _premium_calls(env) == []
    assert [(a.tier, a.preset, a.refused) for a in env.job.attempts][1:3] == [("premium", "premium", True), ("structured", "structured_full", False)]
    assert env.job.needs_review_reason is None
    assert env.job.routing_note == "premium_blocked:cloud_not_allowed"


@flow
def test_premium_pages_over_the_page_cap_are_not_requested_and_end_needs_review(tmp_path):
    converter = SyntheticConverter()
    env = Env(
        tmp_path, _job(sha="b" * 64, premium_max_pages_per_doc=3), PDF["mixed-routing"].read_bytes(), converter=converter,
        preflight=_synthetic_preflight(10, [(1, 2, "premium"), (3, 6, "fast"), (7, 8, "premium"), (9, 10, "fast")]),
    )
    refused = AppScript(response={"worker_id": _WORKER, "status": "refused", "reason": "over_page_cap"})
    env.app.script("parse_external", [refused, refused])

    outcome = env.run()

    assert outcome == JobOutcome(status="ready")
    assert _premium_calls(env) == [], "four premium pages over a cap of three: none of them goes to premium"
    assert env.job.needs_review_reason == "over_page_cap"
    assert [(r.start, r.end, r.status) for r in env.job.page_ranges] == [(1, 2, "needs_review"), (3, 6, "ok"), (7, 8, "needs_review"), (9, 10, "ok")]


@flow
def test_the_escalation_counter_of_the_fake_ledger_follows_the_sql_function():
    from ingest_fakes import FakeLedger

    ledger = FakeLedger()
    from datetime import timedelta

    job = _job(sha="e" * 64)
    ledger.seed(job.model_copy(update={"lease_until": ledger.clock.now() + timedelta(hours=1)}))
    attempt = {
        "tier": "structured", "preset": "structured_ocr", "parser": "docling", "parser_version": "v", "pages": {"start": 1, "end": 1},
        "ms": 1, "est_cost_usd": 0.0, "cache_hit": False, "refused": False,
    }
    for reason in ("initial", "escalation", "table_boundary", "escalation"):
        asyncio.run(ledger.record_attempt(job.id, _WORKER, {**attempt, "reason": reason}))

    assert ledger.jobs[job.id].escalations == 2
