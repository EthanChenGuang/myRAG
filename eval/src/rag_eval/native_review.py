"""Native-speaker review gating of golden items (D-45, XLG-02 delta).

Approval is only ever read here: no code path sets native_review.status to approved.
"""

from rag_sidecar.contracts.golden import GoldenItem
from rag_sidecar.contracts.report import ItemResult, NativeReviewBacklogEntry

REVIEWED_LANGUAGES = frozenset({"zh", "it"})
DRAFTED_ORIGINS = frozenset({"machine_translated", "llm_drafted"})
REPORT_ONLY_REASON = "native_review_pending"
EXISTING_PROVENANCE = "synthetic_fixture"
# The gate's existing minimum: a slice with fewer counting items has no value and is skipped, never divided by zero.
MIN_GATED_ITEMS = 1


def _reviewed_sides(item: GoldenItem) -> list[str]:
    sides = [item.language]
    if item.evidence_language is not None and item.evidence_language != item.language:
        sides.append(item.evidence_language)
    return [language for language in sides if language in REVIEWED_LANGUAGES]


def counts_in_gated_slices(item: GoldenItem | ItemResult) -> bool:
    """Whether an item may enter a gated mean, a paired difference or a denominator.

    A scored ItemResult carries the decision made from its golden item as report_only_reason."""
    if isinstance(item, ItemResult):
        return item.report_only_reason is None
    review = item.native_review
    if review is None or review.origin not in DRAFTED_ORIGINS:
        return True
    if not _reviewed_sides(item):
        return True
    return review.status == "approved"


def report_only_reason(item: GoldenItem) -> str | None:
    return None if counts_in_gated_slices(item) else REPORT_ONLY_REASON


def review_backlog(items: list[GoldenItem]) -> list[NativeReviewBacklogEntry]:
    """Items a native speaker still has to read, sorted by language then id (informational, D-45).

    pending items are report-only until approved; existing synthetic_fixture zh/it items without a review keep counting."""
    entries: list[NativeReviewBacklogEntry] = []
    for item in items:
        sides = _reviewed_sides(item)
        if not sides:
            continue
        if not counts_in_gated_slices(item):
            state = "pending"
        elif item.native_review is None and item.provenance == EXISTING_PROVENANCE:
            state = "existing_unreviewed"
        else:
            continue
        entries.append(NativeReviewBacklogEntry(item_id=item.id, language=sides[0], state=state))
    return sorted(entries, key=lambda entry: (entry.language, entry.item_id))
