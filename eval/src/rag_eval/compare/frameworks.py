from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.baseline import PairedStat
from rag_sidecar.contracts.eval_run import RagTrace
from rag_sidecar.contracts.report import ItemResult

from rag_eval.paired import RESAMPLES, SEED

EXIT_OK = 0
EXIT_INVALID = 2


class ComparisonError(RuntimeError):
    pass


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TransformItemDifference(_Model):
    item_id: str
    fields: list[str]


class TransformDifference(_Model):
    transform: str
    n_items: int = Field(ge=0)
    items: list[TransformItemDifference]


class FusedOrderDifferences(_Model):
    compared: int = Field(ge=0)
    identical: int = Field(ge=0)
    tie_only: int = Field(ge=0)
    rank: int = Field(ge=0)
    tie_only_items: list[str] = Field(default_factory=list)
    rank_items: list[str] = Field(default_factory=list)


class FrameworkComparison(_Model):
    schema_version: Literal[1] = 1
    seed: int = SEED
    resamples: int = RESAMPLES
    all_zero: bool = False
    overall: dict[str, PairedStat] = Field(default_factory=dict)
    languages: dict[str, dict[str, PairedStat]] = Field(default_factory=dict)
    categories: dict[str, dict[str, PairedStat]] = Field(default_factory=dict)
    language_pairs: dict[str, dict[str, PairedStat]] = Field(default_factory=dict)
    transforms: list[TransformDifference] = Field(default_factory=list)
    fused_order: FusedOrderDifferences = Field(default_factory=lambda: FusedOrderDifferences(compared=0, identical=0, tie_only=0, rank=0))
    problems: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class FrameworkRun:
    framework: str
    items: list[ItemResult]
    traces: list[RagTrace] = field(default_factory=list)
    run_config_hash: str | None = None
    embedder: str | None = None


def compare(reference: FrameworkRun, candidate: FrameworkRun) -> FrameworkComparison:
    return FrameworkComparison()


def load_run(directory: Path, framework: str) -> FrameworkRun:
    return FrameworkRun(framework=framework, items=[])


def main(argv: list[str] | None = None, runner=None) -> int:
    return EXIT_OK
