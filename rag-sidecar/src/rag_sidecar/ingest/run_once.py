"""One-shot runner: claim one named job and run it (D-06).

``python -m rag_sidecar.ingest.run_once --job <id>`` exits 0 when the job ends ready, quarantined, needs_review or
skipped_duplicate, 1 when it failed or was requeued, and 2 when the job could not be claimed.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import sys
import uuid
from typing import Any

from pydantic import SecretStr

from rag_sidecar.ingest.app_client import AppClient
from rag_sidecar.ingest.ledger_client import LedgerClient
from rag_sidecar.ingest.process_job import TERMINAL_SUCCESS, WorkerDeps, process_job
from rag_sidecar.ingest.worker_env import WorkerEnv

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 40.0
EXIT_OK = 0
EXIT_NOT_DONE = 1
EXIT_NOT_CLAIMED = 2
EXIT_BAD_ENV = 3


async def _heartbeat(ledger: Any, job_id: str, worker_id: str, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            if not await ledger.heartbeat(job_id, worker_id):
                return
        except Exception:  # noqa: BLE001 - a missed beat is retried on the next tick; the lease decides
            logger.warning("[RAG Ingest] heartbeat failed", extra={"job_id": job_id})


async def run_once(
    job_id: str,
    *,
    ledger: Any,
    app: Any,
    worker_id: str,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> int:
    job = await ledger.claim_one(job_id, worker=worker_id)
    if job is None:
        return EXIT_NOT_CLAIMED
    beat = asyncio.create_task(_heartbeat(ledger, job.id, worker_id, heartbeat_seconds))
    try:
        outcome = await process_job(job, WorkerDeps(ledger=ledger, app=app, worker_id=worker_id))
    finally:
        beat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat
    print(json.dumps({"job_id": job.id, "status": outcome.status, "error_class": outcome.error_class}), flush=True)
    return EXIT_OK if outcome.status in TERMINAL_SUCCESS else EXIT_NOT_DONE


async def _main(job_id: str) -> int:
    try:
        env = WorkerEnv.from_env()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return EXIT_BAD_ENV
    worker_id = f"run-once-{uuid.uuid4().hex[:8]}"
    ledger = LedgerClient(base_url=env.supabase_url, service_key=env.service_role_key.get_secret_value())
    app = AppClient(app_base_url=env.app_internal_url, secret=SecretStr(env.sidecar_secret.get_secret_value()))
    try:
        return await run_once(job_id, ledger=ledger, app=app, worker_id=worker_id)
    finally:
        await ledger.aclose()
        await app.aclose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="rag_sidecar.ingest.run_once")
    parser.add_argument("--job", required=True, help="id of the ingestion job to claim and run")
    args = parser.parse_args(argv)
    return asyncio.run(_main(args.job))


if __name__ == "__main__":
    sys.exit(main())
