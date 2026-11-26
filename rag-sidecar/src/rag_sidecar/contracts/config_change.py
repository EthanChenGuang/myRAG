"""Stub for the RED commit."""

from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class ConfigChangeRecord(_Stub):
    pass


class ConfigGateCheck(_Stub):
    pass


class ConfigGateLayer(_Stub):
    pass


class WeeklyGatesSection(_Stub):
    pass
