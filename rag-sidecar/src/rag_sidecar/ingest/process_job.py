"""The single per-job function used by the worker and Ray (D-06, D-10).

Under fixed routing the worker never parses: it asks the app to run the unchanged Phase 3 chain (F-9), records the
single attempt, and drives the post-parse stages with advance until the ledger row is terminal. Under tiered routing the job
goes to ``tiered.run_tiered`` (preflight, page ranges, cache, check, merge, dry runs), which ends in the same advance loop.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rag_sidecar.contracts.ingest_security import HiddenTextReport
from rag_sidecar.contracts.queue import (
    AdvanceRequest,
    AdvanceResponse,
    IngestionJob,
    ParseExternalRequest,
    ParseExternalResponse,
    TranslateCallbackRequest,
    TranslateCallbackResponse,
)
from rag_sidecar.ingest.app_client import AppAuthError, AppTransientError
from rag_sidecar.ingest.cache_keys import options_hash
from rag_sidecar.ingest.ledger_client import LeaseLost, LedgerError, Transient
from rag_sidecar.preflight.hidden_text_hook import (
    HiddenTextChecker,
    HiddenTextPreflightUnavailable,
    needs_hidden_text_check,
    run_hidden_text_preflight,
)

logger = logging.getLogger(__name__)

ADVANCE_DEADLINE_MS = 40_000
MAX_ADVANCE_CALLS = 200
MAX_PARSE_POLLS = 400
# D-29: one translate callback is bounded by the route's limit; the worker calls again while chunks remain.
TRANSLATE_DEADLINE_MS = 40_000
MAX_TRANSLATE_CALLS = 100
# The app's retry reasons; anything else is recorded as translate_failed, so the error class stays a fixed vocabulary.
_TRANSLATE_RETRY_REASONS = frozenset({"model_unavailable", "write_failed", "unavailable", "aborted", "invalid_argument", "incomplete"})

# The chain has no tier of its own; the attempt row names the delegation instead of a conversion preset.
FIXED_CHAIN_PARSER = "chain"
FIXED_CHAIN_PARSER_VERSION = "phase3-chain"

PERMANENT_PARSE_ERRORS = frozenset({"no_parser_available", "not_an_image", "image_url_invalid"})
# pending_review (D-36): processing finished and the document is held for an admin; a success for the worker (research F-15).
TERMINAL_SUCCESS = frozenset({"ready", "quarantined", "needs_review", "skipped_duplicate", "pending_review"})


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
    # Tests replace the hidden-text checker (D-33); None runs rag_sidecar.security.check_hidden_text.
    hidden_text_checker: HiddenTextChecker | None = None


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


# The stage at which the hidden-text check is the app's to repeat: past it, the app's run state already holds the report.
_SCAN_DONE_CURSORS = frozenset({"scan_injection", "chunk", "enrich", "extract", "images", "embed", "write", "publish"})
HIDDEN_TEXT_TIMEOUT_S = 60.0


async def hidden_text_preflight(deps: WorkerDeps, job: IngestionJob, path: Path) -> HiddenTextReport | None:
    """The hidden-text report of the original at ``path`` when the snapshot asks for it (D-33).

    A check that cannot run under quarantine fails the job before anything is handed to the app (D-34); under flag the
    report is left out and the app records the document as it does inline.
    """
    if needs_hidden_text_check(job) is None:
        return None
    try:
        data = path.read_bytes()
        return await asyncio.wait_for(
            asyncio.to_thread(run_hidden_text_preflight, job, data, checker=deps.hidden_text_checker),
            timeout=HIDDEN_TEXT_TIMEOUT_S,
        )
    except HiddenTextPreflightUnavailable as exc:
        raise _Stop(await _fail(deps, job, exc.error_class, retryable=exc.retryable)) from exc
    except (TimeoutError, OSError) as exc:
        logger.warning("[RAG Security] hidden-text preflight failed", extra={"error": type(exc).__name__})
        if job.settings.hidden_text_check == "quarantine":
            raise _Stop(await _fail(deps, job, HiddenTextPreflightUnavailable(retryable=True).error_class, retryable=True)) from exc
        return None


async def _resume_hidden_text(deps: WorkerDeps, job: IngestionJob) -> HiddenTextReport | None:
    """A reclaimed tiered job that has not passed scan_injection checks its original again, so the app never has to."""
    if job.settings.routing != "tiered" or needs_hidden_text_check(job) is None:
        return None
    state = job.stage_state if isinstance(job.stage_state, dict) else {}
    if state.get("cursor") in _SCAN_DONE_CURSORS:
        return None
    if deps.storage is None or job.original_ref is None:
        if job.settings.hidden_text_check == "quarantine":
            raise _Stop(await _fail(deps, job, "hidden_text_checker_unavailable", retryable=True))
        return None
    if deps.work_dir is not None:
        deps.work_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="rag-hidden-text-", dir=deps.work_dir))
    try:
        path = await deps.storage.download(job.original_ref, dest_dir=work)
        return await hidden_text_preflight(deps, job, Path(path))
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def _advance_until_done(
    deps: WorkerDeps,
    job: IngestionJob,
    cache_id: str,
    attempt_no: int,
    *,
    provisional: bool = False,
    hidden_text_report: HiddenTextReport | None = None,
) -> JobOutcome:
    """Drives advance until done. A provisional run (D-30) ends with stage ``provisional`` and the job stays open for the routed run.

    The hidden-text report, when the worker made one, travels with every call: any slice may be the one that runs scan_injection.
    """
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
                hidden_text_report=hidden_text_report,
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


async def _translate(deps: WorkerDeps, job: IngestionJob) -> JobOutcome:
    """A job of kind translate (D-29): the app translates in time-boxed slices; the worker only claims, calls back and fails retryably.

    Nothing is downloaded, parsed or cached here. A slice that ran out of time answers continue with the chunks remaining, and the
    worker calls again at once; a slice that made no progress, or too many slices, fail the job retryably under the ledger's rules.
    """
    remaining: int | None = None
    for _ in range(MAX_TRANSLATE_CALLS):
        response: TranslateCallbackResponse = await deps.app.translate(
            job.id, TranslateCallbackRequest(worker_id=deps.worker_id, deadline_ms=TRANSLATE_DEADLINE_MS)
        )
        if response.outcome == "done":
            status = response.status or "ready"
            if status in TERMINAL_SUCCESS:
                return JobOutcome(status=status)
            return JobOutcome(status=status, error_class=response.reason)
        if response.outcome == "retry":
            reason = response.reason if response.reason in _TRANSLATE_RETRY_REASONS else "failed"
            return await _fail(deps, job, f"translate_{reason}", retryable=True)
        if remaining is not None and response.remaining is not None and response.remaining >= remaining:
            return await _fail(deps, job, "translate_no_progress", retryable=True)
        remaining = response.remaining
    return await _fail(deps, job, "translate_stalled", retryable=True)


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
        if job.kind == "translate":
            return await _translate(deps, job)
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
            report = await _resume_hidden_text(deps, job)
            return await _advance_until_done(deps, job, resume_cache, attempt_no, hidden_text_report=report)
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
