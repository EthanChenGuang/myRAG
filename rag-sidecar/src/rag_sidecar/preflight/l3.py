"""L3 preflight: vision-model verdicts for pages on which L1 and L2 disagree (D-50)."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from rag_sidecar.contracts.queue import DetectVlmResponse, JobSettingsSnapshot
from rag_sidecar.contracts.routing import PageStructureVerdict, ParseRoutingConfig
from rag_sidecar.preflight.l2 import L2Page


class VlmApp(Protocol):
    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse: ...


@dataclass
class L3Page(L2Page):
    verdict: PageStructureVerdict | None = None
    l3_examined: bool = False


class LoopVlmApp:
    def __init__(
        self,
        client: Any,
        job_id: str,
        worker_id: str,
        attempt_no: int,
        loop: asyncio.AbstractEventLoop,
        timeout_s: float = 60.0,
    ) -> None:
        self._client = client
        self._job_id = job_id
        self._worker_id = worker_id
        self._attempt_no = attempt_no
        self._loop = loop
        self._timeout_s = timeout_s

    def detect(self, pages: Sequence[tuple[int, bytes]]) -> DetectVlmResponse:
        raise NotImplementedError


def l3_refine(
    pages: list[L2Page],
    disagreements: list[int],
    path: Path | str,
    snapshot: JobSettingsSnapshot | None,
    app_client: VlmApp,
    cfg: ParseRoutingConfig,
) -> list[L2Page]:
    return pages
