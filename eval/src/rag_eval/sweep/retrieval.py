from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Sequence

from pydantic import BaseModel, ConfigDict, Field
from rag_sidecar.contracts.baseline import NoiseConfig
from rag_sidecar.contracts.retrieval import RetrievalParams

from rag_eval.harness_runner import HarnessRun, run_harness
from rag_eval.paths import REPO_ROOT

DEFAULT_POOLS = (25, 50, 75, 100)
DEFAULT_TOP_KS = (5, 8, 10, 15, 20)
PARAMS_PATH = REPO_ROOT / "eval" / "config" / "retrieval-params.json"
NOISE_PATH = REPO_ROOT / "eval" / "config" / "noise.json"
DEFAULT_GOLDEN = REPO_ROOT / "eval" / "fixtures" / "golden.jsonl"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SweepUsageError(Exception):
    pass


class SweepGrid(_Model):
    pools: tuple[int, ...] = DEFAULT_POOLS
    top_ks: tuple[int, ...] = DEFAULT_TOP_KS


class SweepCell(_Model):
    candidate_pool_size: int = Field(ge=1, le=200)
    rerank_input_cap: int = Field(ge=50, le=100)
    final_top_k: int = Field(ge=1, le=100)
    recall_at_k: float
    mrr: float
    mean_context_tokens: float = Field(ge=0)
    latency_p95_ms: float = Field(ge=0)
    n_items: int = Field(ge=0)
    run_config_hash: str | None = None
    out_dir: str | None = None


class Selection(_Model):
    chosen: SweepCell
    noise_band: float
    best_recall: float
    best_mrr: float
    within_band: list[tuple[int, int]]


class NoiseRecord(_Model):
    floor: float
    k: float
    spread: float
    band: float


class SweepResult(_Model):
    schema_version: int = 1
    mode: str
    dev_only: bool = True
    rule: str = ""
    run_config_name: str = ""
    run_config_sha256: str = ""
    golden_sha256: str = ""
    grid_sha256: str = ""
    grid: SweepGrid = Field(default_factory=SweepGrid)
    noise: NoiseRecord | None = None
    cells: list[SweepCell] = Field(default_factory=list)
    selection: Selection | None = None
    proposed_params: dict[str, Any] | None = None
    params_written: bool = False
    params_path: str | None = None
    notes: list[str] = Field(default_factory=list)


def rerank_cap(pool: int) -> int:
    return pool


def choose_configuration(cells: Sequence[SweepCell], noise: NoiseConfig, spread: float = 0.0) -> Selection:
    first = cells[0]
    return Selection(chosen=first, noise_band=0.0, best_recall=first.recall_at_k, best_mrr=first.mrr, within_band=[])


def run_retrieval_sweep(
    run_config: Path,
    grid: SweepGrid,
    out: Path,
    base_url: str | None = None,
    write_params: bool = False,
    runner: Callable[..., HarnessRun] = run_harness,
    golden: Path = DEFAULT_GOLDEN,
    fixture_mode: str | None = None,
    params_path: Path = PARAMS_PATH,
    noise_path: Path = NOISE_PATH,
) -> SweepResult:
    return SweepResult(mode="fixture")


def main(argv: list[str] | None = None) -> int:
    return 0


__all__: list[Any] = ["choose_configuration", "run_retrieval_sweep"]
