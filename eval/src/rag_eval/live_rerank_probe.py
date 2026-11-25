"""Phase 4.1 plan 08: capped live rerank quality and latency probe (stub)."""

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict

PLACEHOLDER_KEY = "proxy-injected"


class LiveProbeError(RuntimeError):
    pass


class BudgetExceeded(LiveProbeError):
    pass


@dataclass(frozen=True)
class LiveModel:
    name: str
    vendor: str
    model: str
    tier: str


LIVE_MODELS: tuple[LiveModel, ...] = (
    LiveModel("live-cohere-pro", "cohere", "rerank-v5.0-pro", "voice"),
    LiveModel("live-cohere-fast", "cohere", "rerank-v5.0-fast", "voice"),
    LiveModel("live-voyage-3", "voyage", "rerank-3", "voice"),
    LiveModel("live-voyage-3-lite", "voyage", "rerank-3-lite", "voice"),
)


@dataclass(frozen=True)
class RequestPlan:
    dev_items_total: int
    items_per_pass: int
    probe_per_model: int
    models: int
    total: int

    @property
    def sampled(self) -> bool:
        return False


def plan_requests(dev_items: int, **_kwargs: Any) -> RequestPlan:
    return RequestPlan(0, 0, 0, 0, 0)


def select_items(items: Sequence[Any], limit: int = 120) -> list[Any]:
    return []


class RequestBudget:
    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.used = 0

    @property
    def remaining(self) -> int:
        return 0

    def take(self, count: int) -> None:
        self.used += count


@dataclass(frozen=True)
class ProbeRequest:
    query: str
    documents: tuple[str, ...]


def build_requests(candidates: Sequence[str], queries: Sequence[str], n: int = 30, k: int = 75) -> list[ProbeRequest]:
    return []


def percentile(samples: Sequence[float], q: float) -> float:
    return 0.0


def request_headers(vendor: str, env: Mapping[str, str]) -> dict[str, str]:
    return {}


class ProbeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str = ""


def urllib_transport(url: str, headers: Mapping[str, str], body: bytes, timeout: float) -> int:
    return 0


def run_probe(model: LiveModel, requests: Sequence[ProbeRequest], budget: RequestBudget, *, transport: Callable[..., int] = urllib_transport, clock: Callable[[], float] | None = None, env: Mapping[str, str] | None = None) -> ProbeResult:
    return ProbeResult()


def harness_rerank_calls(stage_statuses: Sequence[Mapping[str, str]]) -> int:
    return 0
