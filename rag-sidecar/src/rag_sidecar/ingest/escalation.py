"""Per-page escalation planning and kept-result selection (D-15, D-16, D-52)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import QualityScoreWeights

ESCALATIONS_EXHAUSTED = "escalations_exhausted"
MAX_TIER = "max_tier"
ESCALATION_OFF = "escalation_off"
CLOUD_NOT_ALLOWED = "cloud_not_allowed"
OVER_PAGE_CAP = "over_page_cap"
QUALITY_CHECK_FAILED = "quality_check_failed"
BUDGET_REFUSALS = frozenset({"budget_exhausted", "over_page_cap", "batch_budget_exhausted"})


@dataclass(frozen=True)
class PageAttempt:
    seq: int
    tier: str
    preset: str
    reason: str = "initial"
    failed: tuple[str, ...] = ()
    score: float = 1.0
    refused: str | None = None

    @property
    def passed(self) -> bool:
        return self.refused is None and not self.failed


@dataclass(frozen=True)
class EscalationUnit:
    start: int
    end: int
    tier: str
    preset: str
    reason: str
    source_seq: int


@dataclass(frozen=True)
class EscalationPlan:
    units: tuple[EscalationUnit, ...]
    blocked: Mapping[int, str]


@dataclass(frozen=True)
class ReviewOutcome:
    needs_review: Mapping[int, str]
    reason: str | None
    routing_note: str | None


def page_score(failed: Sequence[str], weights: QualityScoreWeights) -> float:
    return 1.0


def plan_escalations(
    attempts_by_page: Mapping[int, Sequence[PageAttempt]],
    snapshot: JobSettingsSnapshot,
    ladder: Sequence[str],
    *,
    max_per_page: int = 2,
) -> EscalationPlan:
    return EscalationPlan(units=(), blocked={})


def choose_kept(attempts_by_page: Mapping[int, Sequence[PageAttempt]]) -> dict[int, PageAttempt]:
    return {page: attempts[0] for page, attempts in attempts_by_page.items() if attempts}


def review(attempts_by_page: Mapping[int, Sequence[PageAttempt]], blocked: Mapping[int, str]) -> ReviewOutcome:
    return ReviewOutcome(needs_review={}, reason=None, routing_note=None)
