"""Daily monitor contracts (Phase 5.3 D-22 to D-27, D-43 to D-45): the alert config, daily cell, alert and drift report.

Every string is a Literal, an id, a hash or a pattern-constrained code. An alert, a daily cell and a drift report
never carry query, answer, chunk or document text (D-26).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .cache import TENANT_KEY_PATTERN
from .omit import omit_none_schema
from .retrieval import ConfigProvenance

CODE_PATTERN = r"^[a-z0-9_]+$"
SHA256_PATTERN = r"^[a-f0-9]{64}$"
HASH_PATTERN = r"^[a-f0-9]{8,64}$"
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
DAY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
TIMESTAMP_PATTERN = r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$"
WEEK_PATTERN = r"^\d{4}-W\d{2}$"
ENV_NAME_PATTERN = r"^[A-Z][A-Z0-9_]{0,127}$"
TRACE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$"
CLUSTER_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,63}$"
SLICE_PATTERN = r"^[a-z0-9_]+(:[A-Za-z0-9_.|-]+)*$"
LANGUAGE_CODE_PATTERN = r"^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$"
DEDUP_KEY_PATTERN = r"^[A-Za-z0-9:|_.-]{1,256}$"

Code = Annotated[str, Field(pattern=CODE_PATTERN)]
Sha256 = Annotated[str, Field(pattern=SHA256_PATTERN)]
HexHash = Annotated[str, Field(pattern=HASH_PATTERN)]
UuidStr = Annotated[str, Field(pattern=UUID_PATTERN)]
Day = Annotated[str, Field(pattern=DAY_PATTERN)]
Timestamp = Annotated[str, Field(pattern=TIMESTAMP_PATTERN)]
Week = Annotated[str, Field(pattern=WEEK_PATTERN)]
EnvName = Annotated[str, Field(pattern=ENV_NAME_PATTERN)]
TraceId = Annotated[str, Field(pattern=TRACE_ID_PATTERN)]
ClusterId = Annotated[str, Field(pattern=CLUSTER_ID_PATTERN)]
SliceKey = Annotated[str, Field(pattern=SLICE_PATTERN)]
TenantKey = Annotated[str, Field(pattern=TENANT_KEY_PATTERN)]
LanguageCode = Annotated[str, Field(pattern=LANGUAGE_CODE_PATTERN)]
Count = Annotated[int, Field(ge=0)]
Share = Annotated[float, Field(ge=0, le=1)]

MonitorRuleKind = Literal[
    "rate", "distribution", "latency", "judge_mean", "drift", "offline_online_gap", "language_drop"
]
# language_drop is reserved for Phase 7 plan 07-46 (LANG-10); this phase writes no entry for it.
MonitorRuleId = Literal[
    "refusal_rate",
    "zero_result_rate",
    "below_threshold_rate",
    "not_helpful_rate",
    "groundedness_flagged_rate",
    "kb_error_rate",
    "kb_degraded_rate",
    "kb_unavailable_rate",
    "top_score_psi",
    "latency_p95",
    "online_judge_mean",
    "test_set_not_representative",
    "offline_online_gap",
    "language_drop",
]
AlertSeverity = Literal["warning", "alert"]
AlertStatus = Literal["open", "acknowledged", "resolved"]
AlertSuggestion = Literal["recalibrate_refusal", "review_test_set"]
DeliveryChannel = Literal["webhook", "langfuse"]
DeliveryState = Literal["pending", "delivered", "failed", "disabled"]
ConfigChangeOrigin = Literal[
    "config_ui",
    "cli",
    "release_override",
    "local_prerelease",
    "profile_activation",
    "embedding_profile",
    "chunking_profile",
    "retrieval_log",
]
ScoreKind = Literal["rerank", "similarity"]
MonitorChannel = Literal["chat", "embed", "voice"]
MonitorRagMode = Literal["strict", "balanced", "flexible", "bypass", "unknown"]
DriftState = Literal["ok", "warn", "alert"]
ClusterState = Literal["under", "off", "ok"]
GapResult = Literal["passed", "failed", "insufficient_n"]

TOP_SCORE_BINS = 20
# Upper edges of the latency bins in milliseconds; the last bin holds everything above the last edge.
LATENCY_BIN_EDGES_MS: tuple[int, ...] = (
    50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000,
)
LATENCY_BINS = len(LATENCY_BIN_EDGES_MS) + 1

RuleParam = float | int | Code | list[Code]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _no_repeats(values: list, what: str) -> list:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    return values


def _omit_none(value: object) -> bool:
    return value is None


def _optional(**kwargs: object):  # noqa: ANN202 - returns a pydantic FieldInfo
    """A rule field left out of the hand-edited file while unset."""

    return Field(default=None, exclude_if=_omit_none, json_schema_extra=omit_none_schema, **kwargs)  # type: ignore[arg-type]


class MonitorRule(_Contract):
    """One rule of eval/config/monitor-alerts.json. Which band fields a rule needs depends on its kind (D-24, D-44)."""

    id: MonitorRuleId
    kind: MonitorRuleKind
    metric: Code | None = _optional()
    min_sample: int = Field(ge=1)
    baseline_min_sample: int | None = _optional(ge=1)
    ratio: float | None = _optional(gt=0)
    min_abs_delta: float | None = _optional(ge=0, le=1)
    min_z: float | None = _optional(ge=0)
    warn: float | None = _optional(ge=0)
    alert: float | None = _optional(ge=0)
    drop: float | None = _optional(gt=0, le=1)
    budget_ratio: float | None = _optional(gt=0)
    enabled: bool = True
    params: dict[Code, RuleParam] | None = _optional()

    @model_validator(mode="after")
    def _fields_for_kind(self) -> "MonitorRule":
        def need(*names: str) -> None:
            missing = [name for name in names if getattr(self, name) is None]
            if missing:
                raise ValueError(f"rule {self.id} of kind {self.kind} needs {', '.join(missing)}")

        if self.kind != "language_drop":
            need("metric")
        if self.kind == "rate":
            need("baseline_min_sample", "ratio", "min_abs_delta", "min_z")
        elif self.kind in ("distribution", "drift"):
            need("warn", "alert")
            if self.alert is not None and self.warn is not None and self.alert <= self.warn:
                raise ValueError(f"rule {self.id}: alert must be above warn")
        elif self.kind == "latency":
            need("baseline_min_sample", "ratio")
        elif self.kind == "judge_mean":
            need("drop")
        elif self.kind == "offline_online_gap":
            need("alert")
        return self


class MonitorDriftBands(_Contract):
    jsd_warn: float = Field(ge=0, le=1)
    jsd_alert: float = Field(ge=0, le=1)
    under_covered_min_share: Share
    under_covered_ratio: Share
    gap_alert: float = Field(ge=0, le=1)
    min_test_items: int = Field(ge=1)
    null_percentile: float = Field(gt=0, lt=1)

    @model_validator(mode="after")
    def _ordered(self) -> "MonitorDriftBands":
        if self.jsd_alert <= self.jsd_warn:
            raise ValueError("jsd_alert must be above jsd_warn")
        return self


class MonitorSamplingConfig(_Contract):
    weekly_cap: int = Field(ge=1)
    pilot_multiplier: float = Field(ge=1)
    pilot_cap_share: Share
    drift_fill_share: Share
    max_queries: int = Field(ge=1)
    min_queries: int = Field(ge=1)
    quota_tolerance: Share

    @model_validator(mode="after")
    def _bounds(self) -> "MonitorSamplingConfig":
        if self.min_queries > self.max_queries:
            raise ValueError("min_queries must not exceed max_queries")
        return self


class MonitorAlertsConfig(_Contract):
    schema_version: Literal[1] = 1
    window_days: list[int] = Field(min_length=1)
    baseline_days: int = Field(ge=1)
    rules: list[MonitorRule]
    drift: MonitorDriftBands
    sampling: MonitorSamplingConfig
    provenance: ConfigProvenance
    config_hash: str | None = Field(default=None, pattern=SHA256_PATTERN)

    @field_validator("window_days")
    @classmethod
    def _increasing(cls, value: list[int]) -> list[int]:
        if any(day < 1 for day in value) or any(b <= a for a, b in zip(value, value[1:])):
            raise ValueError("window_days must be positive and strictly increasing")
        return value

    @model_validator(mode="after")
    def _consistent(self) -> "MonitorAlertsConfig":
        _no_repeats([rule.id for rule in self.rules], "rule ids")
        for rule in self.rules:
            if rule.kind == "drift" and (rule.warn, rule.alert) != (self.drift.jsd_warn, self.drift.jsd_alert):
                raise ValueError(f"rule {rule.id}: warn and alert must equal drift.jsd_warn and drift.jsd_alert")
            if rule.kind == "offline_online_gap" and rule.alert != self.drift.gap_alert:
                raise ValueError(f"rule {rule.id}: alert must equal drift.gap_alert")
        return self


class ScoreHistogram(_Contract):
    """Twenty equal bins over 0 to 1 plus underflow and overflow (research Pitfall 15)."""

    bins: list[Count] = Field(min_length=TOP_SCORE_BINS, max_length=TOP_SCORE_BINS)
    underflow: Count = 0
    overflow: Count = 0


class LatencyHistogram(_Contract):
    """Counts per bin of LATENCY_BIN_EDGES_MS; the last bin is everything above the last edge."""

    bins: list[Count] = Field(min_length=LATENCY_BINS, max_length=LATENCY_BINS)


class MonitorDailyCell(_Contract):
    """One rag_monitor_daily row: counts and two fixed-bin histograms only (D-22)."""

    tenant_key: TenantKey
    day: Day
    language: LanguageCode
    rag_mode: MonitorRagMode
    channel: MonitorChannel
    doc_type: Code
    retrievals: Count
    refused: Count
    kb_unavailable: Count
    degraded: Count
    error: Count
    zero_result: Count
    below_threshold: Count
    helpful: Count
    not_helpful: Count
    judged: Count
    judge_score_sums: dict[Code, Annotated[float, Field(ge=0)]] = Field(default_factory=dict)
    groundedness_flagged: Count
    top_score_hist: dict[ScoreKind, ScoreHistogram] = Field(default_factory=dict)
    latency_hist: LatencyHistogram


class MonitorMeasure(_Contract):
    """A count over n and the measured value (a rate, a p95 in ms, a PSI or a mean, depending on the rule)."""

    count: Count | None = None
    n: Count
    value: float | None = None


class MonitorBand(_Contract):
    ratio: float | None = None
    min_abs_delta: float | None = None
    min_z: float | None = None
    warn: float | None = None
    alert: float | None = None
    drop: float | None = None
    budget: float | None = None
    measured_ratio: float | None = None
    measured_delta: float | None = None
    measured_z: float | None = None
    measured_value: float | None = None


class MonitorBreakdown(_Contract):
    by_mode: dict[MonitorRagMode, MonitorMeasure] = Field(default_factory=dict)
    by_channel: dict[MonitorChannel, MonitorMeasure] = Field(default_factory=dict)
    by_doc_type: dict[Code, MonitorMeasure] = Field(default_factory=dict)


class MonitorCompanion(_Contract):
    rule: MonitorRuleId
    value: float | None = None
    baseline: float | None = None
    n: Count


class MonitorConfigChange(_Contract):
    """What changed in the alert's window (D-27): record ids, key names and hash transitions, never values."""

    record_id: UuidStr | None = None
    at: Timestamp
    source: ConfigChangeOrigin
    changed_keys: list[EnvName] = Field(default_factory=list)
    before_hash: HexHash | None = None
    after_hash: HexHash | None = None
    unrecorded: bool = False


class MonitorDelivery(_Contract):
    state: DeliveryState
    attempts: Count = 0
    last_attempt_at: Timestamp | None = None


class MonitorAlert(_Contract):
    """One rag_monitor_alerts row (D-22, D-26, UI-SPEC 8.1). It has no free-text field."""

    id: UuidStr
    tenant_key: TenantKey
    rule: MonitorRuleId
    kind: MonitorRuleKind
    language: LanguageCode
    day: Day
    window_days: int = Field(ge=1)
    severity: AlertSeverity
    status: AlertStatus
    acknowledged_at: Timestamp | None = None
    observed: MonitorMeasure
    baseline: MonitorMeasure | None = None
    band: MonitorBand
    breakdown: MonitorBreakdown = Field(default_factory=MonitorBreakdown)
    companions: list[MonitorCompanion] = Field(default_factory=list)
    sample_trace_ids: list[TraceId] = Field(default_factory=list, max_length=10)
    cluster_ids: list[ClusterId] = Field(default_factory=list)
    config_changes: list[MonitorConfigChange] = Field(default_factory=list)
    suggestion: AlertSuggestion | None = None
    delivered: dict[DeliveryChannel, MonitorDelivery] = Field(default_factory=dict)
    dedup_key: str = Field(pattern=DEDUP_KEY_PATTERN)
    created_at: Timestamp
    updated_at: Timestamp

    @model_validator(mode="after")
    def _distinct(self) -> "MonitorAlert":
        _no_repeats(self.sample_trace_ids, "sample_trace_ids")
        _no_repeats(self.cluster_ids, "cluster_ids")
        return self


class DriftLimits(_Contract):
    warn: float = Field(ge=0, le=1)
    alert: float = Field(ge=0, le=1)
    gap: float = Field(ge=0, le=1)


class DriftTrendPoint(_Contract):
    week: Week
    divergence: float | None = Field(default=None, ge=0, le=1)
    state: DriftState


class DriftCluster(_Contract):
    id: ClusterId
    production_share: Share
    test_share: Share
    test_items: Count
    state: ClusterState


class DriftScores(_Contract):
    unweighted: float | None = None
    weighted: float | None = None
    uncovered_share: Share | None = None


class DriftGap(_Contract):
    slice: SliceKey
    offline: float | None = None
    online: float | None = None
    online_n: Count
    gap: float | None = None
    result: GapResult


class DriftRate(_Contract):
    slice: SliceKey
    metric: Code
    online: Share | None = None
    online_n: Count
    offline: Share | None = None


class DriftReport(_Contract):
    """Weekly test-set drift for one tenant (D-43, D-44); written under eval/golden/private/reports/."""

    week: Week
    tenant_hash: HexHash | None = None
    divergence: float | None = Field(default=None, ge=0, le=1)
    state: DriftState
    null_p95: float | None = Field(default=None, ge=0, le=1)
    limits: DriftLimits
    trend: list[DriftTrendPoint] = Field(default_factory=list)
    clusters: list[DriftCluster] = Field(default_factory=list)
    scores: DriftScores | None = None
    gaps: list[DriftGap] = Field(default_factory=list)
    rates: list[DriftRate] = Field(default_factory=list)

    @model_validator(mode="after")
    def _distinct_clusters(self) -> "DriftReport":
        _no_repeats([cluster.id for cluster in self.clusters], "cluster ids")
        return self


_RATE_RULES: tuple[MonitorRuleId, ...] = (
    "refusal_rate",
    "zero_result_rate",
    "below_threshold_rate",
    "not_helpful_rate",
    "groundedness_flagged_rate",
    "kb_error_rate",
    "kb_degraded_rate",
    "kb_unavailable_rate",
)


def default_monitor_alerts() -> MonitorAlertsConfig:
    """The D-24 and D-44 numbers with provenance.source = defaults; live verification changes them by pull request."""

    drift = MonitorDriftBands(
        jsd_warn=0.10,
        jsd_alert=0.20,
        under_covered_min_share=0.05,
        under_covered_ratio=0.5,
        gap_alert=0.15,
        min_test_items=50,
        null_percentile=0.95,
    )
    rules = [
        MonitorRule(
            id=rule_id,
            kind="rate",
            metric=rule_id,
            min_sample=50,
            baseline_min_sample=200,
            ratio=2.0,
            min_abs_delta=0.05,
            min_z=3.0,
        )
        for rule_id in _RATE_RULES
    ]
    rules += [
        MonitorRule(
            id="top_score_psi",
            kind="distribution",
            metric="top_score",
            min_sample=300,
            baseline_min_sample=1000,
            warn=0.10,
            alert=0.25,
        ),
        MonitorRule(
            id="latency_p95",
            kind="latency",
            metric="latency_p95_ms",
            min_sample=50,
            baseline_min_sample=200,
            ratio=1.5,
            budget_ratio=1.0,
        ),
        MonitorRule(id="online_judge_mean", kind="judge_mean", metric="online_judge_mean", min_sample=50, drop=0.10),
        MonitorRule(
            id="test_set_not_representative",
            kind="drift",
            metric="cluster_jsd",
            min_sample=50,
            warn=drift.jsd_warn,
            alert=drift.jsd_alert,
        ),
        MonitorRule(
            id="offline_online_gap",
            kind="offline_online_gap",
            metric="judge_gap",
            min_sample=50,
            alert=drift.gap_alert,
        ),
    ]
    return MonitorAlertsConfig(
        window_days=[1, 3, 7],
        baseline_days=30,
        rules=rules,
        drift=drift,
        sampling=MonitorSamplingConfig(
            weekly_cap=30,
            pilot_multiplier=5,
            pilot_cap_share=0.4,
            drift_fill_share=0.5,
            max_queries=5000,
            min_queries=30,
            quota_tolerance=0.10,
        ),
        provenance=ConfigProvenance(source="defaults"),
    )
