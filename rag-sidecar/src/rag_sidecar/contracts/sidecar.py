from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SidecarHealth(_Contract):
    status: Literal["ok"]


AvailableScorer = Literal["hhem_2_3_vectara", "hhem_2_1_open"]


class SidecarReady(_Contract):
    status: Literal["ready", "not_ready"]
    reason: str | None = None
    scorers: list[AvailableScorer] = Field(default_factory=list, json_schema_extra={"uniqueItems": True})

    @field_validator("scorers")
    @classmethod
    def _no_repeats(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("scorers must not repeat")
        return value


class SidecarInfo(_Contract):
    service: Literal["rag-sidecar"]
    version: str
    contracts_schema_version: int


class SidecarError(_Contract):
    error: str
