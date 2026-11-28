"""Per-page escalation planning and kept-result selection (D-15, D-16, D-52).

Pure functions over the attempts each page has seen. A page's attempts carry the failed conditions its check reported for that
page, so the planner needs no other input than the history, the job snapshot and the ladder:

- each run of consecutive failing pages from one attempt becomes one unit, re-parsed one step up the ladder;
- a page escalates at most ``max_per_page`` times, never above ``max_tier`` or the top of the ladder, never to premium when the
  snapshot forbids cloud or the document's premium pages would exceed the cap, never again after the guard refused it, and only
  when the snapshot has escalation on;
- a page failing only on ``table_boundary`` is pulled once into its neighbour's higher preset (D-52); that does not count as an
  escalation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from rag_sidecar.contracts.queue import JobSettingsSnapshot
from rag_sidecar.contracts.routing import QualityScoreWeights

ESCALATION = "escalation"
TABLE_BOUNDARY = "table_boundary"
ESCALATIONS_EXHAUSTED = "escalations_exhausted"
MAX_TIER = "max_tier"
ESCALATION_OFF = "escalation_off"
CLOUD_NOT_ALLOWED = "cloud_not_allowed"
OVER_PAGE_CAP = "over_page_cap"
QUALITY_CHECK_FAILED = "quality_check_failed"
BUDGET_REFUSALS = frozenset({"budget_exhausted", "over_page_cap", "batch_budget_exhausted"})

_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}
_PRESET_RANK = {"native": 0, "fast": 1, "structured_layout": 2, "structured_full": 3, "structured_ocr": 4, "premium": 5}
_OCR_FAILURES = frozenset({"empty_text", "low_chars", "garbled", "language_mismatch"})
_FULL_FAILURES = frozenset({"missing_table", "partial_conversion"})
_UNWEIGHTED_PENALTY = 0.1
_EMPTY_TEXT_CAP = 0.7


@dataclass(frozen=True)
class PageAttempt:
    """One attempt as seen by one page: ``failed`` holds this page's failed conditions; ``refused`` the guard's refusal."""

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
    """A page's score from its failed conditions, with the routing data's weights (D-14); used to rank failing attempts."""
    conditions = set(failed)
    score = 1.0
    if "garbled" in conditions:
        score -= weights.garbled
    if "low_chars" in conditions:
        score -= weights.low_chars
    if "missing_table" in conditions:
        score -= weights.missing_table
    if "language_mismatch" in conditions:
        score -= weights.language
    for condition in ("partial_conversion", "table_boundary"):
        if condition in conditions:
            score -= _UNWEIGHTED_PENALTY
    if "empty_text" in conditions:
        score = min(score, _EMPTY_TEXT_CAP)
    return round(max(0.0, min(1.0, score)), 6)


def structured_preset_for(failed: Sequence[str]) -> str:
    """The structured preset a failing fast page climbs to: OCR for text failures, full for table or partial ones, else layout."""
    conditions = set(failed)
    if conditions & _OCR_FAILURES:
        return "structured_ocr"
    if conditions & _FULL_FAILURES:
        return "structured_full"
    return "structured_layout"


def _results(attempts: Sequence[PageAttempt]) -> list[PageAttempt]:
    return sorted((attempt for attempt in attempts if attempt.refused is None), key=lambda attempt: attempt.seq)


def _kept(attempts: Sequence[PageAttempt]) -> PageAttempt | None:
    results = _results(attempts)
    for attempt in results:
        if attempt.passed:
            return attempt
    if not results:
        return None
    return max(results, key=lambda attempt: (attempt.score, -attempt.seq))


def choose_kept(attempts_by_page: Mapping[int, Sequence[PageAttempt]]) -> dict[int, PageAttempt]:
    """Per page: the first passing attempt, else the best-scoring one (ties go to the earlier attempt); refusals are never kept."""
    kept: dict[int, PageAttempt] = {}
    for page, attempts in attempts_by_page.items():
        choice = _kept(attempts)
        if choice is not None:
            kept[page] = choice
    return kept


def _next_tier(current: str, ladder: Sequence[str]) -> str | None:
    if current not in ladder:
        return None
    index = list(ladder).index(current)
    return ladder[index + 1] if index + 1 < len(ladder) else None


def _premium_refusal(attempts: Sequence[PageAttempt]) -> str | None:
    for attempt in sorted(attempts, key=lambda item: item.seq):
        if attempt.refused is not None and attempt.tier == "premium":
            return attempt.refused
    return None


def _step(
    current: PageAttempt,
    attempts: Sequence[PageAttempt],
    snapshot: JobSettingsSnapshot,
    ladder: Sequence[str],
    max_per_page: int,
) -> tuple[str, str] | str:
    """The (tier, preset) one step up for a failing page, or the reason it cannot climb."""
    if not snapshot.escalation:
        return ESCALATION_OFF
    used = sum(1 for attempt in attempts if attempt.reason == ESCALATION)
    if used >= max_per_page:
        return ESCALATIONS_EXHAUSTED
    tier = _next_tier(current.tier, ladder)
    if tier is None:
        return MAX_TIER
    if snapshot.max_tier is not None and _TIER_RANK[tier] > _TIER_RANK[snapshot.max_tier]:
        return MAX_TIER
    if tier == "premium":
        refusal = _premium_refusal(attempts)
        if refusal is not None:
            return refusal
        if not snapshot.cloud_allowed:
            return CLOUD_NOT_ALLOWED
        return tier, "premium"
    if tier == "structured":
        return tier, structured_preset_for(current.failed)
    return tier, tier


def _boundary_pull(page: int, current: PageAttempt, results: Sequence[PageAttempt], attempts_by_page: Mapping[int, Sequence[PageAttempt]]) -> tuple[str, str] | None:
    """D-52: a page failing only on table_boundary takes its left neighbour's higher preset, once."""
    if set(current.failed) != {TABLE_BOUNDARY} or any(attempt.reason == TABLE_BOUNDARY for attempt in results):
        return None
    neighbour = _kept(attempts_by_page.get(page - 1, ()))
    if neighbour is None or _PRESET_RANK[neighbour.preset] <= _PRESET_RANK[current.preset]:
        return None
    return neighbour.tier, neighbour.preset


def plan_escalations(
    attempts_by_page: Mapping[int, Sequence[PageAttempt]],
    snapshot: JobSettingsSnapshot,
    ladder: Sequence[str],
    *,
    max_per_page: int = 2,
) -> EscalationPlan:
    """Units to re-parse next and the failing pages that cannot climb, with their needs_review reason (D-15, D-16, D-52)."""
    candidates: list[tuple[int, str, str, str, int]] = []
    blocked: dict[int, str] = {}
    for page in sorted(attempts_by_page):
        attempts = attempts_by_page[page]
        results = _results(attempts)
        if not results or any(attempt.passed for attempt in results):
            continue
        current = results[-1]
        pull = _boundary_pull(page, current, results, attempts_by_page)
        if pull is not None:
            candidates.append((page, TABLE_BOUNDARY, pull[0], pull[1], current.seq))
            continue
        step = _step(current, attempts, snapshot, ladder, max_per_page)
        if isinstance(step, str):
            blocked[page] = step
            continue
        candidates.append((page, ESCALATION, step[0], step[1], current.seq))

    units: list[EscalationUnit] = []
    for page, reason, tier, preset, source in candidates:
        last = units[-1] if units else None
        if last is not None and last.end + 1 == page and (last.reason, last.tier, last.preset, last.source_seq) == (reason, tier, preset, source):
            units[-1] = EscalationUnit(last.start, page, tier, preset, reason, source)
        else:
            units.append(EscalationUnit(page, page, tier, preset, reason, source))

    premium_units = [unit for unit in units if unit.tier == "premium"]
    if premium_units:
        planned = {page for unit in premium_units for page in range(unit.start, unit.end + 1)}
        already = {
            page
            for page, attempts in attempts_by_page.items()
            if page not in planned and (results := _results(attempts)) and results[-1].tier == "premium"
        }
        if len(planned) + len(already) > snapshot.premium_max_pages_per_doc:
            for page in planned:
                blocked[page] = OVER_PAGE_CAP
            units = [unit for unit in units if unit.tier != "premium"]

    return EscalationPlan(units=tuple(units), blocked=dict(sorted(blocked.items())))


def review(attempts_by_page: Mapping[int, Sequence[PageAttempt]], blocked: Mapping[int, str]) -> ReviewOutcome:
    """D-16: the pages that need review and why, the job's reason (a budget block first, as a retry may do better) and the note."""
    needs_review: dict[int, str] = {}
    cloud_kept = False
    for page in sorted(attempts_by_page):
        attempts = attempts_by_page[page]
        if page in blocked:
            needs_review[page] = blocked[page]
            continue
        refusal = _premium_refusal(attempts)
        if refusal in BUDGET_REFUSALS:
            needs_review[page] = refusal
            continue
        kept = _kept(attempts)
        if kept is not None and not kept.passed:
            needs_review[page] = QUALITY_CHECK_FAILED
            continue
        if refusal is not None:
            cloud_kept = True
    reasons = list(needs_review.values())
    budget = [reason for reason in reasons if reason in BUDGET_REFUSALS]
    reason = budget[0] if budget else (reasons[0] if reasons else None)
    note = f"premium_blocked:{CLOUD_NOT_ALLOWED}" if cloud_kept else None
    return ReviewOutcome(needs_review=needs_review, reason=reason, routing_note=note)
