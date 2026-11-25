"""The single per-job function used by the worker and Ray (D-06, D-10).

Under fixed routing the worker never parses: it asks the app to run the unchanged Phase 3 chain (F-9), records the
single attempt, and drives the post-parse stages with advance until the ledger row is terminal. Under tiered routing the job
goes to ``tiered.run_tiered`` (preflight, page ranges, cache, check, merge, dry runs), which ends in the same advance loop.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    IngestionJob,
    ParseExternalRequest,
    ParseExternalResponse,
)
from rag_sidecar.ingest.app_client import AppAuthError, AppTransientError
from rag_sidecar.ingest.cache_keys import options_hash
from rag_sidecar.ingest.ledger_client import LeaseLost, LedgerError, Transient

logger = logging.getLogger(__name__)

ADVANCE_DEADLINE_MS = 40_000
MAX_ADVANCE_CALLS = 200
MAX_PARSE_POLLS = 400

# The chain has no tier of its own; the attempt row names the delegation instead of a conversion preset.
FIXED_CHAIN_PARSER = "chain"
FIXED_CHAIN_PARSER_VERSION = "phase3-chain"

PERMANENT_PARSE_ERRORS = frozenset({"no_parser_available", "not_an_image", "image_url_invalid"})
TERMINAL_SUCCESS = frozenset({"ready", "quarantined", "needs_review", "skipped_duplicate"})


@dataclass(frozen=True)
class JobOutcome:
    status: str
    error_class: str | None = None


@dataclass(frozen=True)
class WorkerDeps:
    ledger: Any
    app: Any
    worker_id: str
    sleep: Callable[[float], Awaitable[None]] = field(default=asyncio.sleep)
    clock: Callable[[], float] = field(default=time.monotonic)
    # Tiered routing only (03.1-40); fixed routing never touches these.
    storage: Any = None
    pool: Any = None
    converter: Any = None
    converter_factory: Callable[[], Any] | None = None
    routing_cfg: Any = None
    preflight: Callable[..., Any] | None = None
    office_converter: Callable[..., Any] | None = None
    page_cap: int | None = None
    work_dir: Path | None = None
    document_timeout_s: float | None = None


class _Stop(Exception):
    def __init__(self, outcome: JobOutcome) -> None:
        super().__init__(outcome.status)
        self.outcome = outcome


def _chain_options_hash(job: IngestionJob) -> str:
    return options_hash(
        {
            "preset": "chain",
            "input_format": job.mime_type or "application/octet-stream",
            "ocr_languages": sorted(job.settings.ocr_languages),
        }
    )


async def _fail(deps: WorkerDeps, job: IngestionJob, error_class: str, *, retryable: bool) -> JobOutcome:
    try:
        row = await deps.ledger.fail(job.id, deps.worker_id, error_class=error_class, retryable=retryable)
    except LeaseLost:
        return JobOutcome(status="lease_lost")
    return JobOutcome(status=row.status, error_class=error_class)


async def _parse(deps: WorkerDeps, job: IngestionJob) -> tuple[str, int, int]:
    """Runs parse-external in chain mode until it is done; returns the cache id, the attempt number and the elapsed ms."""
    started = deps.clock()
    options = _chain_options_hash(job)
    continuation: str | None = None
    for _ in range(MAX_PARSE_POLLS):
        response: ParseExternalResponse = await deps.app.parse_external(
            job.id,
            ParseExternalRequest(
                worker_id=deps.worker_id,
                attempt_no=1,
                mode="chain",
                options_hash=options,
                continuation=continuation,
            ),
        )
        if response.status == "pending":
            continuation = response.continuation
            await deps.sleep((response.retry_after_ms or 0) / 1000)
            continue
        if response.status == "refused":
            raise _Stop(await _fail(deps, job, response.reason or "refused", retryable=False))
        if response.status == "failed":
            error_class = response.error_class or "parse_failed"
            raise _Stop(await _fail(deps, job, error_class, retryable=error_class not in PERMANENT_PARSE_ERRORS))
        assert response.cache_id is not None
        return response.cache_id, 1, int((deps.clock() - started) * 1000)
    raise _Stop(await _fail(deps, job, "parse_timeout", retryable=True))


async def _record_fixed_chain_attempt(deps: WorkerDeps, job: IngestionJob, elapsed_ms: int) -> int:
    return await deps.ledger.record_attempt(
        job.id,
        deps.worker_id,
        {
            "tier": "structured",
            "preset": "structured_layout",
            "parser": FIXED_CHAIN_PARSER,
            "parser_version": FIXED_CHAIN_PARSER_VERSION,
            "pages": {"start": 1, "end": 1},
            "reason": "fixed_chain",
            "ms": elapsed_ms,
            "est_cost_usd": 0,
            "cache_hit": False,
            "refused": False,
        },
    )


async def _advance_until_done(
    deps: WorkerDeps, job: IngestionJob, cache_id: str, attempt_no: int, *, provisional: bool = False
) -> JobOutcome:
    """Drives advance until done. A provisional run (D-30) ends with stage ``provisional`` and the job stays open for the routed run."""
    cursor: str | None = None
    for _ in range(MAX_ADVANCE_CALLS):
        response: AdvanceResponse = await deps.app.advance(
            job.id,
            AdvanceRequest(
                worker_id=deps.worker_id,
                attempt_no=attempt_no,
                phase="post_parse",
                parse_cache_id=cache_id,
                deadline_ms=ADVANCE_DEADLINE_MS,
                cursor=cursor,
                provisional=provisional,
            ),
        )
        if response.done:
            status = response.status or response.stage
            if status in TERMINAL_SUCCESS:
                return JobOutcome(status=status)
            return JobOutcome(status=status, error_class=response.reason)
        cursor = response.stage
        if response.wait_ms:
            await deps.sleep(response.wait_ms / 1000)
    return await _fail(deps, job, "advance_stalled", retryable=True)


def _needs_begin(job: IngestionJob) -> bool:
    """A backfill ingest job is enqueued without a document row; it gets one at its first claim (D-31). Dry runs never do."""
    return job.kind == "ingest" and job.batch_id is not None and job.document_id is None


async def _begin(deps: WorkerDeps, job: IngestionJob) -> JobOutcome | None:
    """Asks the app to begin the job's document version; returns the outcome when begin already ended the job."""
    attempt_no = job.attempts[-1].attempt_no if job.attempts else 1
    response: AdvanceResponse = await deps.app.advance(
        job.id,
        AdvanceRequest(worker_id=deps.worker_id, attempt_no=attempt_no, phase="begin", deadline_ms=ADVANCE_DEADLINE_MS),
    )
    if not response.done:
        return None
    status = response.status or response.stage
    if status in TERMINAL_SUCCESS:
        return JobOutcome(status=status)
    return JobOutcome(status=status, error_class=response.reason)


def _resume_parse_cache(job: IngestionJob) -> str | None:
    """When a reclaimed job still holds the parse cache pointer, skip parsing and resume advance."""
    state = job.stage_state if isinstance(job.stage_state, dict) else {}
    cache_id = state.get("parse_cache_id")
    if not isinstance(cache_id, str) or not cache_id:
        return None
    past_parse_stages = {"chunking", "embedding"}
    if job.status in past_parse_stages or (job.stage or "") in past_parse_stages:
        return cache_id
    return None


async def process_job(job: IngestionJob, deps: WorkerDeps) -> JobOutcome:
    """Runs one claimed job. The returned outcome says how it ended; nothing document-related is logged."""
    try:
        if job.settings.routing not in ("fixed", "tiered"):
            return await _fail(deps, job, "routing_not_supported", retryable=False)
        if job.kind == "dry_run" and job.settings.routing != "tiered":
            # A dry run ends after checking and has no document row for the chain and advance to write to (D-33).
            return await _fail(deps, job, "dry_run_requires_tiered", retryable=False)
        if _needs_begin(job):
            begun = await _begin(deps, job)
            if begun is not None:
                return begun
        resume_cache = _resume_parse_cache(job)
        if resume_cache:
            attempt_no = job.attempts[-1].attempt_no if job.attempts else 1
            return await _advance_until_done(deps, job, resume_cache, attempt_no)
        if job.settings.routing == "tiered":
            from rag_sidecar.ingest.tiered import run_tiered

            return await run_tiered(job, deps)
        cache_id, attempt_no, elapsed_ms = await _parse(deps, job)
        attempt_no = await _record_fixed_chain_attempt(deps, job, elapsed_ms) or attempt_no
        return await _advance_until_done(deps, job, cache_id, attempt_no)
    except _Stop as stop:
        return stop.outcome
    except LeaseLost:
        logger.warning("[RAG Ingest] lease lost", extra={"job_id": job.id})
        return JobOutcome(status="lease_lost")
    except AppAuthError:
        return await _fail(deps, job, "callback_unauthorized", retryable=False)
    except (AppTransientError, Transient):
        return await _fail(deps, job, "callback_transient", retryable=True)
    except LedgerError:
        return await _fail(deps, job, "ledger_error", retryable=True)
