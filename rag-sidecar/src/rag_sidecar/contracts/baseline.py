from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.eval_run import GoldenFilter, RagRunOptions


def _default_metric_directions() -> dict[str, Literal["higher", "lower"]]:
    return {
        "recall_at_5": "higher",
        "recall_at_10": "higher",
        "mrr": "higher",
        "correct_refusal_rate": "higher",
        "false_refusal_rate": "lower",
    }


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class BaselineMetricStat(_Contract):
    mean: float | None
    spread: float = Field(ge=0)
    runs: list[float | None]
    n: int = Field(ge=0)


class BaselineRun(_Contract):
    run_id: str
    run_config_hash: str
    git_sha: str | None = None
    created_at: str


class PairedStat(_Contract):
    n: int = Field(ge=0)
    n_nonzero: int = Field(ge=0)
    mean_d: float | None
    ci_low: float | None
    ci_high: float | None


class PairedReport(_Contract):
    seed: int
    resamples: int = Field(ge=1)
    all_zero: bool
    slices: dict[str, dict[str, PairedStat]]


class Baseline(_Contract):
    schema_version: Literal[1] = 1
    spread_kind: Literal["stdev_ddof1"]
    tier: Literal["smoke", "nightly", "live"]
    deployment_mode: str
    request_options: RagRunOptions
    corpus_sha256: str | None = None
    golden_sha256: str
    golden_filter: GoldenFilter
    gate_population: Literal["all", "production"] = "all"
    embedder_id: str | None = None
    embedder_version: int | None = None
    embedder_source_sha256: str | None = None
    run_config_hash: str
    runs: list[BaselineRun] = Field(min_length=3)
    slices: dict[str, dict[str, BaselineMetricStat]]
    items: dict[str, dict[str, list[float | None]]] | None = None


class NoiseConfig(_Contract):
    schema_version: Literal[1] = 1
    k: float = Field(default=3.0, ge=0)
    floor: float = Field(default=0.02, ge=0)
    gated_slice_prefixes: list[str] = Field(
        default_factory=lambda: ["overall", "language:", "category:cross_lingual", "pair:"]
    )
    metrics: dict[str, Literal["higher", "lower"]] = Field(default_factory=_default_metric_directions)


class GateOffender(_Contract):
    slice: str
    metric: str
    baseline_mean: float
    threshold: float
    observed: float
    direction: Literal["higher", "lower"]


class GateResult(_Contract):
    passed: bool
    offenders: list[GateOffender]
    skipped: list[str]
    mismatches: list[str]
    paired: PairedReport | None = None
