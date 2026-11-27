"""Phase 7 closeout contracts: the defaults decision, its pre-registered regression plan and the vendor inventory.

D-18, D-20, A-10 and A-11; the cost, latency and per-language blocks are the ADM-02 delta (revision 4).
"""

import hashlib
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .feedback_loop import ShipCheckResult
from .monitor import CODE_PATTERN, Code, EnvName, LanguageCode, Sha256, Timestamp
from .omit import omit_none_schema

INCUMBENT_SOURCE_PATH = "eval/decisions/04.1-retrieval-defaults.json"
CONFIG_NAME_PATTERN = r"^[a-z0-9][a-z0-9_.:-]{0,127}$"
METRIC_PATTERN = r"^[a-z][a-z0-9_@.+]{0,127}$"
HOST_PATTERN = r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
PROVIDER_ID_PATTERN = r"^[a-z0-9][a-z0-9_.-]{0,63}$"

Backend = Literal["pgvector", "weaviate", "qdrant"]
ContentKind = Literal["query", "chunk_text", "answer", "vectors", "lexical_text", "file_bytes", "traces"]
MultiTenantPolicy = Literal["allowed", "requires_ack", "blocked"]
CostReason = Literal["not_measured", "not_provided"]
CostBasisKind = Literal["measured", "estimated"]
LatencyChannel = Literal["chat", "voice"]
SwitchDecision = Literal["adopt", "keep_incumbent"]

ConfigName = Annotated[str, Field(pattern=CONFIG_NAME_PATTERN)]
MetricName = Annotated[str, Field(pattern=METRIC_PATTERN)]
Host = Annotated[str, Field(pattern=HOST_PATTERN, max_length=253)]
ProviderId = Annotated[str, Field(pattern=PROVIDER_ID_PATTERN)]
OverrideValue = str | int | float | bool
Usd = Annotated[float, Field(ge=0)]
Probability = Annotated[float, Field(ge=0, le=1)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _omit_none(value: object) -> bool:
    return value is None


def _optional():  # noqa: ANN202 - returns a pydantic FieldInfo
    return Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema)


def _no_repeats(values: list, what: str) -> list:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    return values


def _check_interval(low: float | None, high: float | None) -> None:
    if low is not None and high is not None and low > high:
        raise ValueError("ci_low must not exceed ci_high")


class RegressionRunConfig(_Contract):
    name: ConfigName
    env: dict[EnvName, str] = Field(default_factory=dict)
    overrides: dict[Code, OverrideValue] = Field(default_factory=dict)


class RegressionPlan(_Contract):
    """A-10 pre-registration, written before the first test-split run; its canonical hash is the record's plan_sha256."""

    schema_version: Literal[1] = 1
    stage: Literal["a", "b"]
    split: Literal["dev", "test"]
    primary_metric: MetricName
    configs: list[RegressionRunConfig] = Field(min_length=1)
    incumbent_config: ConfigName
    gated_slice_prefixes: list[str] = Field(min_length=1)
    alpha: float = Field(default=0.05, gt=0, lt=1)
    min_gate_n: int = Field(default=10, ge=1)
    test_split_budget: int = Field(ge=0)
    created_at: Timestamp



    def canonical_json(self) -> str:
        return json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def canonical_sha256(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


class TestSplitUse(_Contract):
    """One line of the test-split ledger; an unregistered run names its reason (Pitfall 12)."""

    __test__ = False

    run_id: Annotated[str, Field(min_length=1, max_length=128)]
    config_name: ConfigName
    plan_sha256: Sha256
    used_at: Timestamp
    registered: bool
    reason: str | None = Field(default=None, min_length=10, max_length=500)



class SwitchVerdict(_Contract):
    switch: EnvName
    value: str
    delta: float | None
    ci_low: float | None
    ci_high: float | None
    band: float = Field(ge=0)
    p_value: Probability | None
    p_holm: Probability | None
    gated_slices_ok: bool
    too_small_slices: list[str] = Field(default_factory=list)
    latency_ok: bool
    injection_asr: Probability | None
    decision: SwitchDecision
    reason: Code



class BackendResult(_Contract):
    backend: Backend
    config_name: ConfigName
    valid: bool
    invalid_reason: Code | None = None
    delta: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    band: float | None = Field(default=None, ge=0)
    cost_note: str = Field(min_length=1, max_length=1000)
    operational_note: str = Field(min_length=1, max_length=1000)



class BackendComparison(_Contract):
    incumbent: Literal["pgvector"] = "pgvector"
    results: list[BackendResult] = Field(min_length=1)
    winner: Backend
    reason: Code



class IncumbentSource(_Contract):
    path: Literal["eval/decisions/04.1-retrieval-defaults.json"]
    sha256: Sha256


class CostAmount(_Contract):
    usd: Usd | None
    reason: CostReason | None = None



class IngestCostParts(_Contract):
    parse: CostAmount
    embedding: CostAmount
    enrichment: CostAmount
    external_store: CostAmount


class QueryCostParts(_Contract):
    query_embedding: CostAmount
    rerank: CostAmount
    generation: CostAmount
    external_store: CostAmount


class CostPer1000(_Contract):
    """Cost per 1,000 documents ingested (per embedding profile and backend) or per 1,000 queries (per configuration)."""

    embedding_profile: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    backend: Backend | None = None
    config_name: ConfigName | None = None
    documents: IngestCostParts | None = None
    queries: QueryCostParts | None = None



class CostBasis(_Contract):
    price_table_sha256: Sha256
    document_sample: int = Field(ge=0)
    query_sample: int = Field(ge=0)
    kind: CostBasisKind


class CostSummary(_Contract):
    per_1000_documents: list[CostPer1000] = Field(min_length=1)
    per_1000_queries: list[CostPer1000] = Field(min_length=1)
    basis: CostBasis



class LatencyValue(_Contract):
    stage: Annotated[str, Field(pattern=CODE_PATTERN)]
    p50_ms: float | None = Field(ge=0)
    p95_ms: float | None = Field(ge=0)
    budget_p50_ms: float | None = Field(default=None, ge=0)
    budget_p95_ms: float | None = Field(default=None, ge=0)
    within_budget: bool | None
    report_only: bool = False


class LatencyEntry(_Contract):
    config_name: ConfigName
    channel: LatencyChannel
    values: list[LatencyValue] = Field(min_length=1)



class LatencySummary(_Contract):
    budgets_sha256: Sha256
    entries: list[LatencyEntry] = Field(min_length=1)



class LanguageQuality(_Contract):
    """One enabled language: the adopted configuration's primary metric against the incumbent's (ADM-02)."""

    language: LanguageCode
    metric: MetricName
    n: int = Field(ge=0)
    value: float | None
    baseline: float | None
    difference: float | None
    band: float = Field(ge=0)
    below_baseline: bool | None
    reason: Code | None = None



class DefaultsDecision(_Contract):
    """D-18 record in eval/config/release-defaults.json; code defaults follow only a non-provisional one."""

    schema_version: Literal[1] = 1
    provisional: Literal["fixtures"] | None
    decided_at: Timestamp
    plan_sha256: Sha256
    primary_metric: MetricName
    incumbent_source: IncumbentSource
    incumbent: dict[EnvName, str] = Field(min_length=1)
    defaults: dict[EnvName, str] = Field(min_length=1)
    embedding_profile: Annotated[str, Field(min_length=1, max_length=128)]
    reranker: Annotated[str, Field(min_length=1, max_length=64)]
    backend: Backend
    verdicts: list[SwitchVerdict] = Field(default_factory=list)
    backend_comparison: BackendComparison
    config_hashes: dict[ConfigName, Sha256] = Field(min_length=1)
    test_split_uses: list[TestSplitUse] = Field(default_factory=list)
    ship_check_ref: ShipCheckResult | None = _optional()
    cost: CostSummary | None = _optional()
    latency: LatencySummary | None = _optional()
    per_language: list[LanguageQuality] | None = _optional()

    def adopts_change(self) -> bool:
        if self.backend != self.backend_comparison.incumbent:
            return True
        return any(self.incumbent.get(name) != value for name, value in self.defaults.items())



class VendorEntry(_Contract):
    vendor: ProviderId
    name: Annotated[str, Field(min_length=1, max_length=128)]
    hosts: list[Host] = Field(min_length=1)
    content: list[ContentKind] = Field(min_length=1)
    switch: EnvName | None
    opt_in: bool
    multi_tenant: MultiTenantPolicy
    ack_switch: EnvName | None = _optional()
    retention: Annotated[str, Field(min_length=1, max_length=1000)]
    training: Annotated[str, Field(min_length=1, max_length=1000)]
    providers: list[ProviderId] = Field(default_factory=list)



class VendorDataFlow(_Contract):
    """D-20 inventory in config/rag/vendor-data-flow.json; retention and training read to_verify until checked."""

    schema_version: Literal[1] = 1
    vendors: list[VendorEntry] = Field(min_length=1)

