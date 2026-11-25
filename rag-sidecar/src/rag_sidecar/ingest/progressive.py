"""Progressive mode (D-30): a provisional fast-tier version first, then the routed version.

An eligible job parses the whole document with the fast preset, merges and chunks it once and hands it to advance as a provisional
run: the app publishes it as a normal version flagged provisional and keeps the job open. The tiered flow then parses the routed
ranges and hands the merged result to advance again, which publishes the next version through the Phase 3 swap, or clears the
flags in place when the routed text equals the provisional one (A-9). Every post-parse stage runs twice, so it is off by default.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from rag_sidecar.contracts.queue import IngestionJob, JobSettingsSnapshot
from rag_sidecar.contracts.routing import PageRange, PreflightResult

if TYPE_CHECKING:
    from rag_sidecar.ingest.process_job import JobOutcome
    from rag_sidecar.ingest.tiered import _Run

PROVISIONAL_STAGE = "provisional"
PROGRESSIVE_REASON = "progressive_fast"


_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}

JobKind = Literal["incremental", "backfill"]


def job_kind(job: IngestionJob) -> JobKind:
    """Only an ingest job outside a backfill batch is incremental; dry runs and batch jobs never run progressively."""
    return (
        "incremental" if job.kind == "ingest" and job.batch_id is None else "backfill"
    )


def eligible(
    preflight: PreflightResult, snapshot: JobSettingsSnapshot, kind: str
) -> bool:
    """D-30: progressive on, an incremental job, some page above fast, and at least half the pages with a usable text layer."""
    if not snapshot.progressive or kind != "incremental" or not preflight.pages:
        return False
    if not any(_TIER_RANK[page.tier] > _TIER_RANK["fast"] for page in preflight.pages):
        return False
    with_text = sum(1 for page in preflight.pages if page.text_layer)
    return 2 * with_text >= len(preflight.pages)


class ProgressiveEnded(Exception):
    """The provisional run ended the job (for example quarantined or failed); the routed run does not start."""

    def __init__(self, outcome: JobOutcome) -> None:
        super().__init__(outcome.status)
        self.outcome = outcome


async def publish_provisional(run: _Run, result: PreflightResult) -> None:
    """Parses pages 1..N with the fast preset (attempt reason progressive_fast) and publishes it as the provisional version."""
    from rag_sidecar.ingest import tiered
    from rag_sidecar.ingest.process_job import _advance_until_done

    whole = PageRange(
        start=1,
        end=result.page_count,
        tier="fast",
        preset="fast",
        parser=tiered.DOCLING_PARSER,
        layer="L1",
        signals=[],
        status="pending",
    )
    outcome = await tiered._parse_docling_range(
        run, result, whole, tiered._table_before(None, 1), reason=PROGRESSIVE_REASON
    )
    cache_id = await tiered._merged_entry(
        run,
        [tiered._Part(outcome, 1, result.page_count)],
        tiered.load_profile(run.job.settings.profile_id),
        page_count=result.page_count,
        text_layer_share=tiered.text_layer_share(result),
        input_format="pdf",
    )
    attempt_no = run.last_attempt_no or (
        run.job.attempts[-1].attempt_no if run.job.attempts else 1
    )
    ended = await _advance_until_done(
        run.deps, run.job, cache_id, attempt_no, provisional=True
    )
    if ended.status != PROVISIONAL_STAGE:
        raise ProgressiveEnded(ended)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.ingest.progressive")
    parser.add_argument("--cases", required=True, type=Path)
    args = parser.parse_args(argv)
    cases = json.loads(args.cases.read_text(encoding="utf-8"))
    results = [
        eligible(
            PreflightResult.model_validate(case["preflight"]),
            JobSettingsSnapshot.model_validate(case["settings"]),
            str(case["kind"]),
        )
        for case in cases
    ]
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
