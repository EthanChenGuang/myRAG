"""Gradual rollout contracts (Phase 7 LANG-11): a rollout record and the promote result.

Tenant keys are canonical (lower case) and checked again by the SQL guard; a record holds ids, keys, codes and
timestamps only, and its salt and actor ids are never rendered (07-UI-SPEC).
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .cache import EMBEDDING_PROFILE_ID_PATTERN
from .monitor import Count, TenantKey, Timestamp, UuidStr
from .feedback_loop import LanguageCode

RolloutKind = Literal["embedding_profile", "chunking_profile", "rebuild_run"]
RolloutMode = Literal["tenants", "share"]
RolloutState = Literal["active", "promoted", "rolled_back", "cancelled"]
RolloutMetric = Literal["refusal_rate", "not_helpful_rate", "judge_score"]
RolloutVerdict = Literal["holds", "worse", "insufficient", "unmeasured"]

CHUNKING_PROFILE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
SALT_PATTERN = r"^[A-Za-z0-9_-]{8,128}$"
# A refusal code, optionally followed by colon-separated parts such as a language and a metric.
REFUSAL_CODE_PATTERN = r"^[a-z][a-z0-9_]{0,63}(:[a-z0-9][a-z0-9_.-]{0,63}){0,3}$"

EmbeddingProfileId = Annotated[str, Field(pattern=EMBEDDING_PROFILE_ID_PATTERN)]
ChunkingProfileId = Annotated[str, Field(pattern=CHUNKING_PROFILE_ID_PATTERN)]
RefusalCode = Annotated[str, Field(pattern=REFUSAL_CODE_PATTERN)]

_REF_FIELD: dict[str, str] = {
    "embedding_profile": "embedding_profile_id",
    "chunking_profile": "chunking_profile_ids",
    "rebuild_run": "rebuild_run_id",
}


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _no_repeats(values: list, what: str) -> list:
    if len(values) != len(set(values)):
        raise ValueError(f"{what} must not repeat")
    return values


class RolloutRef(_Contract):
    """What one arm serves: exactly one of an embedding profile, chunking profiles or a rebuild run."""

    embedding_profile_id: EmbeddingProfileId | None = None
    chunking_profile_ids: list[ChunkingProfileId] | None = Field(
        default=None, min_length=1, json_schema_extra={"uniqueItems": True}
    )
    rebuild_run_id: UuidStr | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "RolloutRef":
        set_fields = [name for name in _REF_FIELD.values() if getattr(self, name) is not None]
        if len(set_fields) != 1:
            raise ValueError("a rollout ref names exactly one of embedding_profile_id, chunking_profile_ids, rebuild_run_id")
        if self.chunking_profile_ids is not None:
            _no_repeats(self.chunking_profile_ids, "chunking_profile_ids")
        return self

    @property
    def field(self) -> str:
        return next(name for name in _REF_FIELD.values() if getattr(self, name) is not None)


class RolloutRecord(_Contract):
    """One rag_rollouts row with its tenant memberships (plans 07-47, 07-49)."""

    id: UuidStr
    kind: RolloutKind
    candidate_ref: RolloutRef
    incumbent_ref: RolloutRef | None = None
    mode: RolloutMode
    share_percent: int | None = Field(default=None, ge=0, le=100)
    salt: str = Field(pattern=SALT_PATTERN)
    state: RolloutState
    included_tenants: list[TenantKey] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})
    excluded_tenants: list[TenantKey] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})
    created_at: Timestamp
    created_by: UuidStr | None = None
    ended_at: Timestamp | None = None
    ended_by: UuidStr | None = None

    @model_validator(mode="after")
    def _consistent(self) -> "RolloutRecord":
        expected = _REF_FIELD[self.kind]
        if self.candidate_ref.field != expected:
            raise ValueError(f"a {self.kind} rollout's candidate_ref must name {expected}")
        if self.incumbent_ref is None:
            if self.kind != "rebuild_run":
                raise ValueError("incumbent_ref is required unless the rollout is a rebuild_run")
        elif self.incumbent_ref.field != expected:
            raise ValueError(f"a {self.kind} rollout's incumbent_ref must name {expected}")
        if (self.mode == "share") != (self.share_percent is not None):
            raise ValueError("share_percent is required for mode share and not allowed for mode tenants")
        _no_repeats(self.included_tenants, "included_tenants")
        _no_repeats(self.excluded_tenants, "excluded_tenants")
        if set(self.included_tenants) & set(self.excluded_tenants):
            raise ValueError("a tenant key must not be both included and excluded")
        if (self.state == "active") != (self.ended_at is None):
            raise ValueError("ended_at is set exactly when the rollout is no longer active")
        if self.ended_by is not None and self.ended_at is None:
            raise ValueError("ended_by needs ended_at")
        return self


class RolloutMeasure(_Contract):
    value: float | None = Field(default=None, ge=0)
    n: Count

    @model_validator(mode="after")
    def _measured(self) -> "RolloutMeasure":
        if self.value is None and self.n != 0:
            raise ValueError("a measure with samples needs a value")
        return self


class RolloutLanguageComparison(_Contract):
    """One language and measure: the candidate arm now, the same tenants before the rollout, the other tenants now."""

    language: LanguageCode
    metric: RolloutMetric
    candidate_now: RolloutMeasure
    candidate_before: RolloutMeasure
    incumbent_now: RolloutMeasure
    verdict: RolloutVerdict

    @model_validator(mode="after")
    def _rates(self) -> "RolloutLanguageComparison":
        if self.metric.endswith("_rate"):
            for measure in (self.candidate_now, self.candidate_before, self.incumbent_now):
                if measure.value is not None and measure.value > 1:
                    raise ValueError("a rate must lie between 0 and 1")
        return self


class RolloutPromoteResult(_Contract):
    """The answer of a promote attempt; a refusal changes nothing and carries one code."""

    rollout_id: UuidStr
    ok: bool
    refusal: RefusalCode | None = None
    comparisons: list[RolloutLanguageComparison] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistent(self) -> "RolloutPromoteResult":
        if self.ok == (self.refusal is not None):
            raise ValueError("a refusal code is present exactly when ok is false")
        _no_repeats([(item.language, item.metric) for item in self.comparisons], "language and metric comparisons")
        if self.ok and any(item.verdict in ("worse", "insufficient") for item in self.comparisons):
            raise ValueError("a promoted rollout cannot have a worse or insufficient language")
        return self
