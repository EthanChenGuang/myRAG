from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SidecarHealth(_Contract):
    status: Literal["ok"]


class SidecarReady(_Contract):
    status: Literal["ready", "not_ready"]
    reason: str | None = None


class SidecarInfo(_Contract):
    service: Literal["rag-sidecar"]
    version: str
    contracts_schema_version: int


class SidecarError(_Contract):
    error: str
