"""Stub for the RED commit."""

from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class ReleaseGateConfig(_Stub):
    pass


class ReleaseGatePart(_Stub):
    pass


class ReleaseGateResult(_Stub):
    pass
