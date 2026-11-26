"""Phase 4.2 gates (stub: names only until the spec models land)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict

PHASE42_SWITCHES: frozenset[str] = frozenset()
SELECTABLE: tuple[str, ...] = ()


class Phase42GateSpec(BaseModel):
    model_config = ConfigDict(extra="allow")


def runs_for(spec: Phase42GateSpec, gate: str) -> list[str]:
    return []


def run_config_for(spec: Phase42GateSpec, run: Any) -> dict[str, Any]:
    return {}
