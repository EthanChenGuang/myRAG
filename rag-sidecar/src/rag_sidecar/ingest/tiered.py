"""Tiered routing in the worker: preflight, range parsing with cache, quality check, attempts, merge (D-12, D-15, D-53, D-56)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rag_sidecar.ingest.merge import merge  # noqa: F401

if TYPE_CHECKING:
    from rag_sidecar.contracts.queue import IngestionJob
    from rag_sidecar.ingest.process_job import JobOutcome, WorkerDeps


def range_options_hash(preset: str, start: int, end: int, ocr_languages: list[str], cfg: Any) -> str:
    return ""


async def run_tiered(job: IngestionJob, deps: WorkerDeps) -> JobOutcome:
    from rag_sidecar.ingest.process_job import JobOutcome

    del job, deps
    return JobOutcome(status="failed", error_class="tiered_not_implemented")
