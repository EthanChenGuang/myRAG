from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from rag_sidecar.contracts.eval_run import GoldenFilter, RagRunOptions
from rag_sidecar.contracts.omit import omit_default_schema, omit_none_schema
from rag_sidecar.contracts.quality_gates import AbsoluteGateResult


def _default_metric_directions() -> dict[str, Literal["higher", "lower"]]:
    return {
        "recall_at_5": "higher",
        "recall_at_10": "higher",
        "mrr": "higher",
        "correct_refusal_rate": "higher",
        "false_refusal_rate": "lower",
    }


def _omit_none(value: object) -> bool:
    return value is None


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
    gate_population: Literal["all", "production", "real"] = "all"
    embedder_id: str | None = None
    embedder_version: int | None = None
    embedder_source_sha256: str | None = None
    run_config_hash: str
    runs: list[BaselineRun] = Field(min_length=3)
    slices: dict[str, dict[str, BaselineMetricStat]]
    items: dict[str, dict[str, list[float | None]]] | None = None
    golden_set_version: int | None = Field(default=None, ge=1, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
    golden_manifest_sha256: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=_omit_none, json_schema_extra=omit_none_schema
    )
    rag_mode: Literal["strict", "balanced", "flexible"] = Field(
        default="strict", exclude_if=lambda value: value == "strict", json_schema_extra=omit_default_schema
    )


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
    kind: Literal["noise_band", "absolute_zero"] = "noise_band"
    reason: str | None = None


class GateResult(_Contract):
    passed: bool
    offenders: list[GateOffender]
    skipped: list[str]
    mismatches: list[str]
    paired: PairedReport | None = None
    absolute: AbsoluteGateResult | None = Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)
