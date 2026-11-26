"""Setting-check and config-change contracts (Phase 5.3 D-13 to D-17, UI-SPEC 8.1).

A check result and a change record hold setting names and hashes, never values. The typed override reason is the
only operator-written text (500 characters in a record, 200 in the weekly report).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .monitor import (
    CODE_PATTERN,
    Code,
    Count,
    Day,
    DriftState,
    EnvName,
    HexHash,
    MonitorRuleId,
    Sha256,
    Timestamp,
    UUID_PATTERN,
    Week,
)
from .quality_gates import GateCheckRow
from .release_gate import GitSha, GithubLogin

CHECK_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$"
ACTOR_PATTERN = rf"^(local-config-ui|cli|ci|{UUID_PATTERN[1:-1]})$"
CELL_KEY_PATTERN = r"^[A-Za-z0-9_.:/@+-]{1,128}(\|[A-Za-z0-9_.:/@+-]{1,128}){1,7}$"

ConfigGateLayerName = Literal["deterministic", "live", "real_set"]
ConfigGateLayerResult = Literal["pass", "fail", "error", "skipped"]
ConfigGateOutcome = Literal["pass", "fail", "error"]
ConfigGateStatus = Literal["queued", "running", "done"]
ConfigGateMode = Literal["warn", "enforce"]
ConfigGateSavedAs = Literal["pass", "override", "warn", "skipped", "not_saved"]
ConfigChangeSource = Literal["config_ui", "cli", "release_override", "local_prerelease", "profile_activation"]
ConfigChangeGateResult = Literal["pass", "fail", "error", "skipped", "not_required"]
JudgeCellState = Literal["gating", "report_only", "uncalibrated"]

LAYER_ORDER: tuple[ConfigGateLayerName, ...] = ("deterministic", "live", "real_set")
RELEASE_SOURCES = frozenset({"release_override", "local_prerelease"})

Actor = Annotated[str, Field(pattern=ACTOR_PATTERN)]
CellKey = Annotated[str, Field(pattern=CELL_KEY_PATTERN)]


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _no_repeats(values: list, what: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")


class ConfigGateLayer(_Contract):
    layer: ConfigGateLayerName
    set_hash: Sha256 | None = None
    result: ConfigGateLayerResult
    reason: str | None = Field(default=None, pattern=CODE_PATTERN)
    checks: list[GateCheckRow] = Field(default_factory=list)

    @model_validator(mode="after")
    def _reason(self) -> "ConfigGateLayer":
        if self.result in ("skipped", "error") and self.reason is None:
            raise ValueError(f"a {self.result} layer names its reason")
        return self


class ConfigGateNotEvaluated(_Contract):
    key: EnvName
    reason: Code


class ConfigGateCheck(_Contract):
    """The check object of GET /api/config/rag-gate/check/:id (D-13, D-14). An error counts as not passed."""

    check_id: str = Field(pattern=CHECK_ID_PATTERN)
    status: ConfigGateStatus
    stage: ConfigGateLayerName | None = None
    started_at: Timestamp | None = None
    finished_at: Timestamp | None = None
    mode: ConfigGateMode
    cached: bool = False
    rag_settings_hash: Sha256
    changed_keys: list[EnvName] = Field(default_factory=list)
    result: ConfigGateOutcome | None = None
    error_reason: Code | None = None
    layers: list[ConfigGateLayer]
    not_evaluated_on_real_set: list[EnvName] = Field(default_factory=list)
    not_evaluated: list[ConfigGateNotEvaluated] = Field(default_factory=list)
    uncalibrated_cells: list[CellKey] = Field(default_factory=list)
    saved_as: ConfigGateSavedAs | None = None

    @model_validator(mode="after")
    def _consistent(self) -> "ConfigGateCheck":
        if tuple(layer.layer for layer in self.layers) != LAYER_ORDER:
            raise ValueError("layers must be deterministic, live and real_set, in that order")
        _no_repeats(self.changed_keys, "changed_keys")
        if self.status == "done":
            if self.result is None:
                raise ValueError("a done check has a result")
        elif self.result is not None:
            raise ValueError("only a done check has a result")
        if (self.result == "error") != (self.error_reason is not None):
            raise ValueError("error_reason is set exactly when the result is error")
        return self


class ConfigGateSummary(_Contract):
    """Counts and offender metric names; release_sha and github_actor only on release records."""

    checks: Count = 0
    failed: Count = 0
    skipped: Count = 0
    offenders: list[Code] = Field(default_factory=list)
    layers: dict[ConfigGateLayerName, ConfigGateLayerResult] = Field(default_factory=dict)
    release_sha: GitSha | None = None
    github_actor: GithubLogin | None = None


class ConfigChangeRecord(_Contract):
    """One rag_config_change_records row (D-16): key names and hashes, never values."""

    id: Annotated[str, Field(pattern=UUID_PATTERN)]
    created_at: Timestamp
    actor: Actor
    source: ConfigChangeSource
    changed_keys: list[EnvName] = Field(default_factory=list)
    before_hash: Sha256
    after_hash: Sha256
    retrieval_config_hash: HexHash | None = None
    gate_result: ConfigChangeGateResult
    gate_summary: ConfigGateSummary = Field(default_factory=ConfigGateSummary)
    override_reason: str | None = Field(default=None, min_length=10, max_length=500)
    uncalibrated_cells: list[CellKey] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistent(self) -> "ConfigChangeRecord":
        _no_repeats(self.changed_keys, "changed_keys")
        release_fields = self.gate_summary.release_sha is not None or self.gate_summary.github_actor is not None
        if release_fields and self.source not in RELEASE_SOURCES:
            raise ValueError("release_sha and github_actor belong to release_override and local_prerelease records")
        if self.source == "release_override" and self.override_reason is None:
            raise ValueError("a release override records its reason")
        return self


class WeeklyOverride(_Contract):
    date: Day
    actor: Actor
    changed_keys: list[EnvName] = Field(default_factory=list)
    before_hash: Sha256
    after_hash: Sha256
    gate_result: ConfigChangeGateResult
    override_reason: str | None = Field(default=None, max_length=200)


class WeeklyChangeCount(_Contract):
    source: ConfigChangeSource
    gate_result: ConfigChangeGateResult
    count: Count


class WeeklyReleaseOverride(_Contract):
    date: Day
    sha: GitSha
    github_actor: GithubLogin
    override_reason: str | None = Field(default=None, max_length=200)


class WeeklyDrift(_Contract):
    tenant_hash: HexHash
    week: Week
    divergence: float | None = Field(default=None, ge=0, le=1)
    state: DriftState


class WeeklyGatesSection(_Contract):
    """WeeklyReport.gates (D-17, research X-7): numbers, ids, names and the capped reason only."""

    overrides: list[WeeklyOverride] = Field(default_factory=list)
    change_counts: list[WeeklyChangeCount] = Field(default_factory=list)
    release_overrides: list[WeeklyReleaseOverride] = Field(default_factory=list)
    open_alerts: dict[MonitorRuleId, Count] = Field(default_factory=dict)
    judge_cells: dict[JudgeCellState, Count] = Field(default_factory=dict)
    drift: list[WeeklyDrift] = Field(default_factory=list)
    skipped_runs: dict[Code, Count] = Field(default_factory=dict)
    overdue_re_reviews: Count = 0
