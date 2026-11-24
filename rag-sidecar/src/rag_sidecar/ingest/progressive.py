"""Progressive mode (D-30): a provisional fast-tier version first, then the routed version."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Literal

from rag_sidecar.contracts.queue import IngestionJob, JobSettingsSnapshot
from rag_sidecar.contracts.routing import PreflightResult


_TIER_RANK = {"native": 0, "fast": 1, "structured": 2, "premium": 3}

JobKind = Literal["incremental", "backfill"]


def job_kind(job: IngestionJob) -> JobKind:
    """Only an ingest job outside a backfill batch is incremental; dry runs and batch jobs never run progressively."""
    return "incremental" if job.kind == "ingest" and job.batch_id is None else "backfill"


def eligible(preflight: PreflightResult, snapshot: JobSettingsSnapshot, kind: str) -> bool:
    """D-30: progressive on, an incremental job, some page above fast, and at least half the pages with a usable text layer."""
    if not snapshot.progressive or kind != "incremental" or not preflight.pages:
        return False
    if not any(_TIER_RANK[page.tier] > _TIER_RANK["fast"] for page in preflight.pages):
        return False
    with_text = sum(1 for page in preflight.pages if page.text_layer)
    return 2 * with_text >= len(preflight.pages)


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
