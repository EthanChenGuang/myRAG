"""Optional Ray Data runner for one backfill batch (D-34, D-37, SC5).

``uv run --project rag-sidecar --extra ray python -m rag_sidecar.ingest.ray_runner --batch <id>`` connects to ``RAY_ADDRESS``
when it is set, or starts a local Ray instance. In rounds, it lists the batch's open jobs through ``rag_list_batch_jobs`` and
maps the claimable ones with Ray Data ``map_batches`` over an actor pool (``ActorPoolStrategy``). Each actor claims its job
with ``rag_claim_ingestion_job`` (runner ``ray``), skips it when the claim returns nothing, and runs the same ``process_job``
as the worker, with the Docling stages inside the actor. Batch concurrency, budget, priority and resume rules stay in the
ledger, so a batch can switch between this runner and the worker mid-run. Calls to the app pass one token bucket shared
through a Ray actor (Pitfall 15).

Ray is imported only inside the functions that need it: the default image has no ray (plan 03.1-04), and importing this
module never loads it. Actors read the worker environment from their own process; on a local instance they inherit the
runner's environment, and on a remote cluster the nodes must carry it. Secrets are never sent through Ray.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import math
import os
import re
import signal
import sys
import threading
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, TypeVar

from pydantic import SecretStr

from rag_sidecar.contracts.queue import IngestionJob
from rag_sidecar.ingest.app_client import AppClient, TokenBucket
from rag_sidecar.ingest.ledger_client import BatchJobRef, LeaseLost, LedgerClient
from rag_sidecar.ingest.process_job import TERMINAL_SUCCESS, JobOutcome, WorkerDeps, process_job
from rag_sidecar.ingest.storage_client import StorageClient
from rag_sidecar.ingest.worker import _PERMANENT, classify_ingest_error
from rag_sidecar.ingest.worker_env import WorkerEnv

logger = logging.getLogger(__name__)

RUNNER = "ray"
DEFAULT_MIN_ACTORS = 1
DEFAULT_MAX_ACTORS = 2
DEFAULT_CPUS_PER_ACTOR = 2.0
APP_RATE_PER_SECOND = 10.0
HEARTBEAT_SECONDS = 40.0
IDLE_SECONDS = 2.0

EXIT_DONE = 0
EXIT_FAILED = 1
EXIT_BAD_ENV = 3
EXIT_TERMINATED = 143

CLAIMABLE_KINDS = frozenset({"ingest", "dry_run"})
TERMINAL = frozenset({"ready", "failed", "quarantined", "needs_review", "skipped_duplicate"})
WORKING = frozenset({"preflight", "parsing", "checking", "chunking", "embedding"})
EMBED_DEFERRED_STAGE = "embed_deferred"

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

T = TypeVar("T")


# --- arguments ---------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RunnerOptions:
    batch_id: str
    min_actors: int = DEFAULT_MIN_ACTORS
    max_actors: int = DEFAULT_MAX_ACTORS
    cpus_per_actor: float = DEFAULT_CPUS_PER_ACTOR


def _batch_id(raw: str) -> str:
    value = raw.strip().lower()
    if not _UUID.match(value):
        raise argparse.ArgumentTypeError("the batch id must be a UUID")
    return value


def _positive_int(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a whole number") from exc
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def _positive_float(raw: str) -> float:
    try:
        value = float(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number") from exc
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return value


def parse_args(argv: list[str] | None = None) -> RunnerOptions:
    parser = argparse.ArgumentParser(prog="rag_sidecar.ingest.ray_runner")
    parser.add_argument("--batch", required=True, type=_batch_id, help="id of the ingestion batch to run")
    parser.add_argument(
        "--max-actors", type=_positive_int, default=DEFAULT_MAX_ACTORS, help="largest size of the actor pool (default 2)"
    )
    parser.add_argument(
        "--cpus", type=_positive_float, default=DEFAULT_CPUS_PER_ACTOR, help="CPUs reserved per actor (default 2)"
    )
    args = parser.parse_args(argv)
    return RunnerOptions(
        batch_id=args.batch,
        min_actors=min(DEFAULT_MIN_ACTORS, args.max_actors),
        max_actors=args.max_actors,
        cpus_per_actor=args.cpus,
    )


# --- which jobs a pass offers ------------------------------------------------------------------------------------------


JobRef = BatchJobRef | IngestionJob


def _parked(job: JobRef) -> bool:
    """A Batch API backfill job parked at embed_deferred (03.1-49): the rag:backfill process embeds and publishes it, not a runner."""
    return job.status == "embedding" and job.stage == EMBED_DEFERRED_STAGE and job.lease_until is None


def open_jobs(jobs: Iterable[JobRef]) -> list[JobRef]:
    """Jobs a runner can still finish: claimable kinds that are not terminal and not parked for deferred embedding."""
    return [job for job in jobs if job.kind in CLAIMABLE_KINDS and job.status not in TERMINAL and not _parked(job)]


def claimable(jobs: Iterable[JobRef], now: datetime) -> list[str]:
    """Ids the claim function could hand out now: queued and due, or working with an expired lease. The claim decides."""
    ids: list[str] = []
    for job in open_jobs(jobs):
        if job.status == "queued":
            if job.run_after is None or job.run_after <= now:
                ids.append(job.id)
        elif job.status in WORKING and job.lease_until is not None and job.lease_until < now:
            ids.append(job.id)
    return ids


# --- one job -----------------------------------------------------------------------------------------------------------

ProcessFn = Callable[[IngestionJob, WorkerDeps], Awaitable[JobOutcome]]


@dataclass
class JobContext:
    ledger: Any
    app: Any
    storage: Any
    worker_id: str
    process: ProcessFn = process_job
    heartbeat_seconds: float = HEARTBEAT_SECONDS
    converter_factory: Callable[[], Any] | None = None
    page_cap: int | None = None


def _result(job_id: str, result: str, status: str) -> dict[str, str]:
    return {"job_id": job_id, "result": result, "status": status}


async def _heartbeat(ctx: JobContext, job_id: str, task: asyncio.Task[Any]) -> None:
    while True:
        await asyncio.sleep(ctx.heartbeat_seconds)
        try:
            alive = await ctx.ledger.heartbeat(job_id, ctx.worker_id)
        except Exception:  # noqa: BLE001 - a missed beat is retried; the lease decides
            logger.warning("[RAG Ingest] heartbeat failed", extra={"job_id": job_id})
            continue
        if not alive:
            task.cancel()
            return


async def _fail(ctx: JobContext, job: IngestionJob, error_class: str, *, retryable: bool) -> str | None:
    try:
        row = await ctx.ledger.fail(job.id, ctx.worker_id, error_class=error_class, retryable=retryable)
    except LeaseLost:
        return None
    if row.status == "failed":
        logger.info("[Ingest Alert] job_id=%s error_class=%s", job.id, error_class)
    return row.status


async def _settle(ctx: JobContext, job: IngestionJob, outcome: JobOutcome) -> str:
    """The worker's rule (IngestWorker._finish_outcome): an outcome that names an error class is failed through the ledger."""
    if outcome.status in TERMINAL_SUCCESS or outcome.status == "lease_lost" or not outcome.error_class:
        return outcome.status
    status = await _fail(ctx, job, outcome.error_class, retryable=outcome.error_class not in _PERMANENT)
    return status or outcome.status


async def run_job(job_id: str, ctx: JobContext) -> dict[str, str]:
    """Claims one job for this actor and runs it; a job the claim does not hand out is skipped untouched (T-03.1-111)."""
    job = await ctx.ledger.claim_one(job_id, worker=ctx.worker_id, runner=RUNNER)
    if job is None:
        return _result(job_id, "skipped", "")
    deps = WorkerDeps(
        ledger=ctx.ledger,
        app=ctx.app,
        worker_id=ctx.worker_id,
        storage=ctx.storage,
        converter_factory=ctx.converter_factory,
        page_cap=ctx.page_cap,
    )
    task = asyncio.ensure_future(ctx.process(job, deps))
    beat = asyncio.create_task(_heartbeat(ctx, job.id, task))
    try:
        outcome = await task
        status = await _settle(ctx, job, outcome)
    except asyncio.CancelledError:
        if not task.cancelled():
            raise
        status = "lease_lost"
    except Exception as exc:  # noqa: BLE001 - classified and recorded on the ledger like the worker does
        error_class, retryable = classify_ingest_error(exc)
        status = await _fail(ctx, job, error_class, retryable=retryable) or "lease_lost"
    finally:
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat
    return _result(job.id, "processed", status)


# --- the driver ------------------------------------------------------------------------------------------------------


@dataclass
class DriveSummary:
    processed: int = 0
    skipped: int = 0
    rounds: int = 0
    statuses: dict[str, int] = field(default_factory=dict)


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


async def drive_batch(
    batch_id: str,
    *,
    ledger: Any,
    run_pass: Callable[[list[str]], Awaitable[list[dict[str, str]]]],
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], datetime] = _utcnow,
    idle_seconds: float = IDLE_SECONDS,
) -> DriveSummary:
    """Runs passes until no job of the batch is open. A job skipped in one pass (no room in the batch, or another runner had
    it) is offered again in the next; jobs another runner holds are waited for, since their lease either ends them or runs out."""
    summary = DriveSummary()
    while True:
        jobs = await ledger.list_batch_jobs(batch_id)
        pending = open_jobs(jobs)
        if not pending:
            return summary
        ids = claimable(pending, clock())
        progressed = False
        if ids:
            summary.rounds += 1
            for row in await run_pass(ids):
                if row.get("result") == "processed":
                    progressed = True
                    summary.processed += 1
                    status = str(row.get("status") or "")
                    summary.statuses[status] = summary.statuses.get(status, 0) + 1
                else:
                    summary.skipped += 1
            logger.info(
                "[Backfill][ray] pass %d: %d offered, %d processed so far", summary.rounds, len(ids), summary.processed
            )
        if not progressed:
            await sleep(idle_seconds)


# --- the shared token bucket ---------------------------------------------------------------------------------------


class TokenBucketActor:
    """One app rate limit for the whole actor pool; created as a Ray actor (num_cpus=0) by the runner."""

    def __init__(self, rate_per_second: float, clock: Callable[[], float] | None = None) -> None:
        self._bucket = TokenBucket(rate_per_second, clock=clock)

    def try_acquire(self) -> bool:
        return self._bucket.try_acquire()


class SharedTokenBucket:
    """The AppClient bucket interface over a remote try_acquire; the blocking call runs off the event loop."""

    def __init__(
        self,
        try_acquire: Callable[[], bool],
        *,
        rate_per_second: float,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        if rate_per_second <= 0:
            raise ValueError("rate_per_second must be positive")
        self._try_acquire = try_acquire
        self._wait = 1.0 / rate_per_second
        self._sleep = sleep

    async def acquire(self) -> None:
        while not await asyncio.to_thread(self._try_acquire):
            await self._sleep(self._wait)


def _remote_try_acquire(handle: Any) -> Callable[[], bool]:
    def try_acquire() -> bool:
        import ray

        return bool(ray.get(handle.try_acquire.remote()))

    return try_acquire


# --- the actor -------------------------------------------------------------------------------------------------------


class _LoopThread:
    """A private event loop on its own thread, so the actor's async clients work whatever thread Ray calls it from."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="ray-runner-loop", daemon=True)
        self._thread.start()

    def run(self, coro: Coroutine[Any, Any, T]) -> T:
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    @property
    def closed(self) -> bool:
        return self._loop.is_closed()

    def close(self) -> None:
        if self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        self._loop.close()


ClientsFactory = Callable[[], tuple[Any, Any, Any]]


def _env_clients(bucket: Any) -> ClientsFactory:
    env = WorkerEnv.from_env()

    def build() -> tuple[Any, Any, Any]:
        key = env.service_role_key.get_secret_value()
        ledger = LedgerClient(base_url=env.supabase_url, service_key=key)
        app = AppClient(
            app_base_url=env.app_internal_url,
            secret=SecretStr(env.sidecar_secret.get_secret_value()),
            token_bucket=bucket,
        )
        storage = StorageClient(base_url=env.supabase_url, service_key=key)
        return ledger, app, storage

    return build


class ProcessJobActor:
    """Ray Data callable class: one actor per pool slot, one job id per call (batch_size=1)."""

    def __init__(self, bucket: Any = None, *, clients: ClientsFactory | None = None) -> None:
        shared = SharedTokenBucket(_remote_try_acquire(bucket), rate_per_second=APP_RATE_PER_SECOND) if bucket else None
        factory = clients or _env_clients(shared)
        self._worker_id = f"ray:{uuid.uuid4().hex[:12]}"
        self._loop = _LoopThread()
        self._converter: Any = None
        self._ledger, self._app, self._storage = self._loop.run(self._build(factory))
        self._ctx = JobContext(
            ledger=self._ledger,
            app=self._app,
            storage=self._storage,
            worker_id=self._worker_id,
            converter_factory=self._converter_once,
            page_cap=_page_cap() if clients is None else None,
        )

    @staticmethod
    async def _build(factory: ClientsFactory) -> tuple[Any, Any, Any]:
        return factory()

    def _converter_once(self) -> Any:
        """The Docling range converter is built on the first tiered job and kept for the actor's life."""
        if self._converter is None:
            from rag_sidecar.settings import load_settings

            self._converter = load_settings().build_range_converter()
        return self._converter

    def __call__(self, batch: dict[str, Any]) -> dict[str, list[str]]:
        rows = [self._loop.run(run_job(str(job_id), self._ctx)) for job_id in batch["job_id"]]
        return {
            "job_id": [row["job_id"] for row in rows],
            "result": [row["result"] for row in rows],
            "status": [row["status"] for row in rows],
        }

    def close(self) -> None:
        if self._loop.closed:
            return

        async def shutdown() -> None:
            for client in (self._ledger, self._app, self._storage):
                aclose = getattr(client, "aclose", None)
                if aclose is not None:
                    with contextlib.suppress(Exception):
                        await aclose()

        with contextlib.suppress(Exception):
            self._loop.run(shutdown())
        self._loop.close()

    def __del__(self) -> None:
        with contextlib.suppress(Exception):
            self.close()


def _page_cap() -> int | None:
    from rag_sidecar.settings import load_settings

    try:
        return load_settings().page_cap
    except ValueError:
        return None


# --- Ray --------------------------------------------------------------------------------------------------------------


def _ray_pass(ray: Any, options: RunnerOptions, bucket: Any, job_ids: list[str]) -> list[dict[str, str]]:
    size = min(options.max_actors, len(job_ids))
    dataset = ray.data.from_items([{"job_id": job_id} for job_id in job_ids])
    mapped = dataset.map_batches(
        ProcessJobActor,
        batch_size=1,
        batch_format="numpy",
        num_cpus=options.cpus_per_actor,
        compute=ray.data.ActorPoolStrategy(min_size=min(options.min_actors, size), max_size=size),
        fn_constructor_kwargs={"bucket": bucket},
    )
    return [{key: str(value) for key, value in row.items()} for row in mapped.take_all()]


def _init_ray(ray: Any) -> bool:
    """Connects to RAY_ADDRESS when set, otherwise starts a local instance; returns whether this process started Ray."""
    if ray.is_initialized():
        return False
    address = (os.environ.get("RAY_ADDRESS") or "").strip()
    if address:
        ray.init(address=address, log_to_driver=True)
    else:
        os.environ.pop("RAY_ADDRESS", None)
        ray.init(include_dashboard=False, log_to_driver=True)
    return True


async def _drive(options: RunnerOptions, env: WorkerEnv, ray: Any, bucket: Any) -> DriveSummary:
    ledger = LedgerClient(base_url=env.supabase_url, service_key=env.service_role_key.get_secret_value())
    try:

        async def run_pass(job_ids: list[str]) -> list[dict[str, str]]:
            return await asyncio.to_thread(_ray_pass, ray, options, bucket, job_ids)

        return await drive_batch(options.batch_id, ledger=ledger, run_pass=run_pass)
    finally:
        await ledger.aclose()


def run(options: RunnerOptions) -> int:
    try:
        env = WorkerEnv.from_env()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return EXIT_BAD_ENV
    import ray

    started = _init_ray(ray)
    try:
        bucket = ray.remote(num_cpus=0)(TokenBucketActor).remote(APP_RATE_PER_SECOND)
        summary = asyncio.run(_drive(options, env, ray, bucket))
    except Exception:  # noqa: BLE001 - reported as a failed run; the ledger keeps every job's state
        logger.exception("[Backfill][ray] the runner failed")
        return EXIT_FAILED
    finally:
        if started:
            ray.shutdown()
    statuses = ", ".join(f"{name} {count}" for name, count in sorted(summary.statuses.items())) or "none"
    print(
        f"[Backfill][ray] batch {options.batch_id} has no open job: {summary.processed} processed in {summary.rounds} "
        f"passes ({statuses}), {summary.skipped} claims skipped",
        flush=True,
    )
    return EXIT_DONE


def _terminate(_signum: int, _frame: Any) -> None:
    raise SystemExit(EXIT_TERMINATED)


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    # The CLI stops the runner with SIGTERM; exiting through SystemExit lets the finally blocks shut Ray down.
    signal.signal(signal.SIGTERM, _terminate)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
