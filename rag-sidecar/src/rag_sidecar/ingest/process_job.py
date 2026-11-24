"""The single per-job function used by the worker and Ray (D-06, D-10)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from rag_sidecar.contracts.queue import IngestionJob


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


async def process_job(job: IngestionJob, deps: WorkerDeps) -> JobOutcome:
    raise NotImplementedError("process_job")
