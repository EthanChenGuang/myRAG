"""Priority queue in front of the Docling process pool (A-4, F-5)."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import time
from collections.abc import Callable
from concurrent.futures import Executor, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

UPLOAD_PRIORITY = 100


class PoolCrashed(Exception):
    """Retryable failure when a pool worker process died."""


@dataclass(order=True)
class _QueueEntry:
    priority: int
    seq: int
    fn: Callable[..., Any] = field(compare=False)
    args: tuple[Any, ...] = field(compare=False)
    deadline_s: float = field(compare=False)
    future: asyncio.Future[Any] = field(compare=False)


class PriorityPool:
    """Serialises CPU work with priority preemption for upload conversions."""

    def __init__(
        self,
        *,
        workers: int = 1,
        executor: Executor | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._workers = max(1, workers)
        self._executor = executor or ThreadPoolExecutor(max_workers=self._workers)
        self._owns_executor = executor is None
        self._loop = loop
        self._queue: asyncio.PriorityQueue[_QueueEntry] = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._dispatcher: asyncio.Task[None] | None = None
        self._crashed = False

    def start(self) -> None:
        loop = self._loop or asyncio.get_running_loop()
        self._loop = loop
        self._dispatcher = loop.create_task(self._dispatch())

    async def stop(self) -> None:
        if self._dispatcher is not None:
            self._dispatcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._dispatcher
        while not self._queue.empty():
            try:
                entry = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if not entry.future.done():
                entry.future.cancel()
        if self._owns_executor:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def submit(
        self,
        fn: Callable[..., Any],
        args: tuple[Any, ...],
        *,
        priority: int,
        deadline_s: float,
    ) -> asyncio.Future[Any]:
        loop = self._loop or asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        entry = _QueueEntry(-priority, next(self._seq), fn, args, deadline_s, future)
        self._queue.put_nowait(entry)
        return future

    async def _dispatch(self) -> None:
        while True:
            entry = await self._queue.get()
            if self._crashed:
                self._crashed = False
            started = time.monotonic()
            try:
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(self._executor, (lambda e=entry: e.fn(*e.args)))
                if not entry.future.done():
                    entry.future.set_result(result)
            except PoolCrashed as exc:
                self._crashed = True
                if not entry.future.done():
                    entry.future.set_exception(exc)
            except Exception as exc:
                if not entry.future.done():
                    entry.future.set_exception(PoolCrashed(str(exc)) if self._owns_executor else exc)
            if entry.deadline_s > 0 and time.monotonic() - started > entry.deadline_s:
                logger.warning("[RAG Ingest] pool work exceeded deadline", extra={"deadline_s": entry.deadline_s})