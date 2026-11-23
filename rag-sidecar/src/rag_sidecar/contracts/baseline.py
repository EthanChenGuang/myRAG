from pydantic import BaseModel


class BaselineMetricStat(BaseModel):
    mean: float | None
    spread: float
    runs: list[float | None]
    n: int


class BaselineRun(BaseModel):
    run_id: str
    run_config_hash: str
    git_sha: str | None = None
    created_at: str


class Baseline(BaseModel):
    schema_version: int
    spread_kind: str
    corpus_sha256: str | None = None
    golden_sha256: str
    embedder_id: str | None = None
    embedder_version: int | None = None
    run_config_hash: str
    runs: list[BaselineRun]
    slices: dict[str, dict[str, BaselineMetricStat]]


class NoiseConfig(BaseModel):
    schema_version: int = 1
    k: float = 1.0
    floor: float = 0.0
    gated_slice_prefixes: list[str] = []
    metrics: dict[str, str] = {}


class GateOffender(BaseModel):
    slice: str
    metric: str
    baseline_mean: float
    threshold: float
    observed: float
    direction: str


class GateResult(BaseModel):
    passed: bool
    offenders: list[GateOffender]
    skipped: list[str]
    mismatches: list[str]
