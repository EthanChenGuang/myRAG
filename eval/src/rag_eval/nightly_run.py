"""Shared nightly runner (Phase 5.3 D-33, D-19). Stub."""

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class NightlyOutcome:
    parts: tuple = ()
    report_paths: dict = field(default_factory=dict)
    counts: dict = field(default_factory=dict)
    effective_config_hash: str | None = None


def run_nightly_tier(golden, out_dir, **kwargs) -> NightlyOutcome:
    return NightlyOutcome()
