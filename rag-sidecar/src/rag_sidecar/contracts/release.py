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

    @field_validator("gated_slice_prefixes")
    @classmethod
    def _distinct_prefixes(cls, value: list[str]) -> list[str]:
        return _no_repeats(value, "gated_slice_prefixes")

    @model_validator(mode="after")
    def _consistent(self) -> "RegressionPlan":
        names = [config.name for config in self.configs]
        _no_repeats(names, "config names")
        if self.incumbent_config not in names:
            raise ValueError("incumbent_config must name one of the configs")
        if self.split == "dev" and self.test_split_budget != 0:
            raise ValueError("a dev-split plan has no test-split budget")
        return self

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

    @model_validator(mode="after")
    def _reason_when_unregistered(self) -> "TestSplitUse":
        if not self.registered and self.reason is None:
            raise ValueError("an unregistered test-split use needs a reason")
        return self


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

    @model_validator(mode="after")
    def _consistent(self) -> "SwitchVerdict":
        _check_interval(self.ci_low, self.ci_high)
        _no_repeats(self.too_small_slices, "too_small_slices")
        if self.p_holm is not None and (self.p_value is None or self.p_holm < self.p_value):
            raise ValueError("p_holm must not be below p_value")
        if self.decision == "adopt":
            if not (self.gated_slices_ok and self.latency_ok):
                raise ValueError("an adopted switch holds every gated slice and the latency budgets")
            if self.injection_asr is None or self.injection_asr != 0:
                raise ValueError("an adopted switch keeps the injection attack-success rate at 0")
        return self


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

    @model_validator(mode="after")
    def _consistent(self) -> "BackendResult":
        _check_interval(self.ci_low, self.ci_high)
        if self.valid == (self.invalid_reason is not None):
            raise ValueError("invalid_reason is set exactly when the run is invalid for a backend comparison")
        return self


class BackendComparison(_Contract):
    incumbent: Literal["pgvector"] = "pgvector"
    results: list[BackendResult] = Field(min_length=1)
    winner: Backend
    reason: Code

    @model_validator(mode="after")
    def _consistent(self) -> "BackendComparison":
        _no_repeats([result.backend for result in self.results], "backends")
        if self.winner != self.incumbent:
            match = next((result for result in self.results if result.backend == self.winner), None)
            if match is None or not match.valid:
                raise ValueError("a winning backend needs a valid result")
            if match.ci_low is None or match.ci_low <= 0 or match.delta is None or match.band is None:
                raise ValueError("a backend wins only with ci_low above 0")
            if match.delta <= match.band:
                raise ValueError("a backend wins only beyond the noise band")
        return self


class IncumbentSource(_Contract):
    path: Literal["eval/decisions/04.1-retrieval-defaults.json"]
    sha256: Sha256


class CostAmount(_Contract):
    usd: Usd | None
    reason: CostReason | None = None

    @model_validator(mode="after")
    def _amount_or_reason(self) -> "CostAmount":
        if (self.usd is None) == (self.reason is None):
            raise ValueError("an amount is a number or None with a reason code, never both")
        return self


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

    @model_validator(mode="after")
    def _one_kind(self) -> "CostPer1000":
        if (self.documents is None) == (self.queries is None):
            raise ValueError("a cost row is per 1,000 documents or per 1,000 queries")
        if self.documents is not None and (self.embedding_profile is None or self.backend is None):
            raise ValueError("an ingest cost row names its embedding profile and backend")
        if self.queries is not None and self.config_name is None:
            raise ValueError("a query cost row names its configuration")
        return self


class CostBasis(_Contract):
    price_table_sha256: Sha256
    document_sample: int = Field(ge=0)
    query_sample: int = Field(ge=0)
    kind: CostBasisKind


class CostSummary(_Contract):
    per_1000_documents: list[CostPer1000] = Field(min_length=1)
    per_1000_queries: list[CostPer1000] = Field(min_length=1)
    basis: CostBasis

    @model_validator(mode="after")
    def _rows_match_lists(self) -> "CostSummary":
        if any(row.documents is None for row in self.per_1000_documents):
            raise ValueError("per_1000_documents holds ingest cost rows only")
        if any(row.queries is None for row in self.per_1000_queries):
            raise ValueError("per_1000_queries holds query cost rows only")
        _no_repeats(
            [(row.embedding_profile, row.backend) for row in self.per_1000_documents], "ingest cost rows"
        )
        _no_repeats([row.config_name for row in self.per_1000_queries], "query cost rows")
        return self


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

    @model_validator(mode="after")
    def _has_total(self) -> "LatencyEntry":
        stages = [value.stage for value in self.values]
        _no_repeats(stages, "latency stages")
        if "total" not in stages:
            raise ValueError("a latency entry holds the total")
        return self


class LatencySummary(_Contract):
    budgets_sha256: Sha256
    entries: list[LatencyEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _distinct(self) -> "LatencySummary":
        _no_repeats([(entry.config_name, entry.channel) for entry in self.entries], "latency entries")
        return self


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

    @model_validator(mode="after")
    def _reason_when_undecided(self) -> "LanguageQuality":
        if self.below_baseline is None and self.reason is None:
            raise ValueError("a language without a below_baseline verdict names its reason")
        return self


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

    @model_validator(mode="after")
    def _consistent(self) -> "DefaultsDecision":
        if set(self.defaults) - set(self.incumbent):
            raise ValueError("every default names a variable of the incumbent map")
        _no_repeats([verdict.switch for verdict in self.verdicts], "verdict switches")
        if self.backend != self.backend_comparison.winner:
            raise ValueError("backend must equal the backend comparison winner")
        if self.provisional == "fixtures" and self.backend != "pgvector":
            raise ValueError("a fixture record never moves the default backend")
        if self.provisional is None:
            missing = [name for name in ("cost", "latency", "per_language") if getattr(self, name) is None]
            if missing:
                raise ValueError(f"a non-provisional record needs {', '.join(missing)}")
        if self.per_language is not None:
            if not self.per_language:
                raise ValueError("per_language lists every enabled language")
            _no_repeats([entry.language for entry in self.per_language], "per_language languages")
            below = [entry.language for entry in self.per_language if entry.below_baseline is True]
            if below and self.adopts_change():
                raise ValueError(f"enabled language below its baseline: {', '.join(below)}")
        return self


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

    @model_validator(mode="after")
    def _consistent(self) -> "VendorEntry":
        _no_repeats(self.hosts, "hosts")
        _no_repeats(self.content, "content")
        _no_repeats(self.providers, "providers")
        if self.multi_tenant == "requires_ack" and self.ack_switch is None:
            raise ValueError("multi_tenant requires_ack names its ack_switch")
        if self.multi_tenant != "requires_ack" and self.ack_switch is not None:
            raise ValueError("ack_switch belongs to multi_tenant requires_ack only")
        return self


class VendorDataFlow(_Contract):
    """D-20 inventory in config/rag/vendor-data-flow.json; retention and training read to_verify until checked."""

    schema_version: Literal[1] = 1
    vendors: list[VendorEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def _distinct(self) -> "VendorDataFlow":
        _no_repeats([entry.vendor for entry in self.vendors], "vendors")
        hosts = [host for entry in self.vendors for host in entry.hosts]
        _no_repeats(hosts, "hosts across vendors")
        return self
