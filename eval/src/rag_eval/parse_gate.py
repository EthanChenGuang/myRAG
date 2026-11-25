"""Gate tiered routing against fixed routing on retrieval quality (D-40, SC6)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.parse_eval import ModeProjection, ParseGateReport
from rag_sidecar.contracts.report import EvalReport
from rag_sidecar.contracts.routing import ParseRoutingConfig


class GateMismatch(ValueError):
    pass


class IngestLedger(BaseModel):
    model_config = ConfigDict(extra="allow")


@dataclass(frozen=True)
class ModeRun:
    report: EvalReport
    ledger: IngestLedger


@dataclass
class GateOutcome:
    report: ParseGateReport
    details: dict = field(default_factory=dict)


def mode_projection(ledgers: Sequence[IngestLedger], cfg: ParseRoutingConfig) -> ModeProjection:
    return ModeProjection(premium_page_share=0, projected_cost_per_1000_pages_usd=0)


def run_gate(fixed: Sequence[ModeRun], tiered: Sequence[ModeRun], noise: NoiseConfig, cfg: ParseRoutingConfig) -> GateOutcome:
    empty = mode_projection([], cfg)
    return GateOutcome(
        ParseGateReport(recall_at_k=[], correct_refusal=[], noise_band_k=0, noise_band_floor=0, fixed=empty, tiered=empty, passed=False)
    )


def main(argv: list[str] | None = None) -> int:
    return 1
