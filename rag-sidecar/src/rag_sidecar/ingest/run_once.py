"""One-shot runner: claim one named job and run it (D-06)."""

from __future__ import annotations

from typing import Any


async def run_once(job_id: str, *, ledger: Any, app: Any, worker_id: str) -> int:
    raise NotImplementedError("run_once")
