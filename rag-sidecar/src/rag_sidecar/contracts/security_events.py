from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from rag_sidecar.contracts.groundedness import _Contract

SecuritySource = Literal["ingest_injection", "retrieval_injection", "output_guard", "hidden_text", "untrusted_link"]
SecurityAction = Literal["detected", "quarantined", "dropped", "downweighted", "removed", "blocked", "warned"]
AlertStatus = Literal["open", "acknowledged"]
LinkPreviewState = Literal["unknown", "none", "subset", "mismatch"]
DetectorName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
HostName = Annotated[
    str,
    Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$", max_length=253),
]
TenantKey = Annotated[str, Field(min_length=1)]

_UNIQUE = {"uniqueItems": True}


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _check_time(value: str | None) -> str | None:
    if value is not None:
        _parse_time(value)
    return value


class SecurityEvent(_Contract):
    """D-43: one row of `rag_security_events`. Ids and rule ids only; there is no text field."""

    id: UUID | None = None
    tenant_key: TenantKey
    source: SecuritySource
    action: SecurityAction
    detector: DetectorName
    rule_ids: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(default_factory=list)
    document_id: str | None = Field(default=None, min_length=1)
    chunk_id: str | None = None
    uploader_id: UUID | None = None
    trace_id: str | None = None
    created_at: str | None = None

    @field_validator("created_at")
    @classmethod
    def _valid_times(cls, value: str | None) -> str | None:
        return _check_time(value)


class SecurityAlert(_Contract):
    """D-45: one row of `rag_security_alerts`, unique per uploader and window."""

    id: UUID | None = None
    tenant_key: TenantKey
    uploader_id: UUID
    event_count: int = Field(ge=1)
    window_start: str = Field(min_length=1)
    window_end: str = Field(min_length=1)
    status: AlertStatus
    held: bool = False
    created_at: str | None = None

    @field_validator("window_start", "window_end", "created_at")
    @classmethod
    def _valid_times(cls, value: str | None) -> str | None:
        return _check_time(value)

    @model_validator(mode="after")
    def _window_order(self) -> "SecurityAlert":
        if _parse_time(self.window_end) <= _parse_time(self.window_start):
            raise ValueError("window_end must be after window_start")
        return self


class UploaderHold(_Contract):
    """D-46: one row of `rag_uploader_holds`; a hold is active while released_at is null."""

    id: UUID | None = None
    tenant_key: TenantKey
    user_id: UUID
    created_by: UUID
    reason: str | None = Field(default=None, max_length=500)
    created_at: str | None = None
    released_at: str | None = None

    @field_validator("created_at", "released_at")
    @classmethod
    def _valid_times(cls, value: str | None) -> str | None:
        return _check_time(value)


class SecurityUploaderView(_Contract):
    """D-47: the uploader as an admin route returns it; email only for deployment admins."""

    user_id: UUID
    display_name: str | None = None
    email: str | None = None
    tenant_key: TenantKey
    workspace_name: str | None = None
    event_count: int = Field(default=0, ge=0)
    last_event_at: str | None = None
    held: bool = False
    held_since: str | None = None


class SecurityEventView(_Contract):
    id: UUID
    created_at: str = Field(min_length=1)
    tenant_key: TenantKey
    workspace_name: str | None = None
    source: SecuritySource
    action: SecurityAction
    detector: DetectorName
    rule_ids: list[str] = Field(default_factory=list)
    document_id: str | None = Field(default=None, min_length=1)
    file_name: str | None = None
    uploader_id: UUID | None = None
    uploader_name: str | None = None
    uploader_email: str | None = None


class SecurityAlertView(_Contract):
    id: UUID
    tenant_key: TenantKey
    workspace_name: str | None = None
    uploader_id: UUID
    uploader_name: str | None = None
    uploader_email: str | None = None
    event_count: int = Field(ge=1)
    window_hours: int = Field(ge=1)
    threshold: int = Field(ge=1)
    opened_at: str = Field(min_length=1)
    status: AlertStatus
    held: bool = False


class LinkPreviewStatus(_Contract):
    """D-40: Baileys preview hosts against the output allowlist; host names only."""

    state: LinkPreviewState
    preview_hosts: list[HostName] = Field(default_factory=list, json_schema_extra=_UNIQUE)
    hosts_not_allowlisted: list[HostName] = Field(default_factory=list, json_schema_extra=_UNIQUE)

    @model_validator(mode="after")
    def _state_rules(self) -> "LinkPreviewStatus":
        if len(set(self.preview_hosts)) != len(self.preview_hosts):
            raise ValueError("preview_hosts must not repeat")
        if not set(self.hosts_not_allowlisted) <= set(self.preview_hosts):
            raise ValueError("hosts_not_allowlisted must be preview hosts")
        if self.state in ("unknown", "none") and (self.preview_hosts or self.hosts_not_allowlisted):
            raise ValueError(f"state {self.state} carries no hosts")
        if self.state == "subset" and (not self.preview_hosts or self.hosts_not_allowlisted):
            raise ValueError("state subset needs preview hosts that are all allowlisted")
        if self.state == "mismatch" and not self.hosts_not_allowlisted:
            raise ValueError("state mismatch needs at least one host not on the allowlist")
        return self
