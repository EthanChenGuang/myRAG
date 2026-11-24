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
