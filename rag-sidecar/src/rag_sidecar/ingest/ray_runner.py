"""Optional Ray Data runner for one backfill batch (D-37). Placeholder: the behaviour lands with the tests' GREEN commit."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from rag_sidecar.contracts.queue import IngestionJob


@dataclass(frozen=True)
class RunnerOptions:
    batch_id: str
    min_actors: int = 0
    max_actors: int = 0
    cpus_per_actor: float = 0.0


@dataclass
class JobContext:
    ledger: Any
    app: Any
    storage: Any
    worker_id: str
    process: Any = None
    heartbeat_seconds: float = 40.0


@dataclass
class DriveSummary:
    processed: int = 0
    skipped: int = 0
    statuses: dict[str, int] = field(default_factory=dict)


def parse_args(argv: list[str] | None = None) -> RunnerOptions:
    return RunnerOptions(batch_id="")


def claimable(jobs: Iterable[IngestionJob], now: datetime) -> list[str]:
    return []


def open_jobs(jobs: Iterable[IngestionJob]) -> list[IngestionJob]:
    return []


async def run_job(job_id: str, ctx: JobContext) -> dict[str, str]:
    return {}


async def drive_batch(
    batch_id: str,
    *,
    ledger: Any,
    run_pass: Callable[[list[str]], Awaitable[list[dict[str, str]]]],
    sleep: Callable[[float], Awaitable[None]] | None = None,
    clock: Callable[[], datetime] | None = None,
) -> DriveSummary:
    return DriveSummary()


class SharedTokenBucket:
    def __init__(self, try_acquire: Callable[[], bool], *, rate_per_second: float, sleep: Any = None) -> None:
        self._try_acquire = try_acquire

    async def acquire(self) -> None:
        return None


class TokenBucketActor:
    def __init__(self, rate_per_second: float, clock: Callable[[], float] | None = None) -> None:
        pass

    def try_acquire(self) -> bool:
        return False


class ProcessJobActor:
    def __init__(self, bucket: Any = None, *, clients: Callable[[], tuple[Any, Any, Any]] | None = None) -> None:
        pass

    def __call__(self, batch: dict[str, Any]) -> dict[str, list[str]]:
        return {}

    def close(self) -> None:
        pass


def main(argv: list[str] | None = None) -> int:
    return 1
