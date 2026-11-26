"""Stub for the RED commit."""

from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class JudgeCalibrationCell(_Stub):
    pass


class JudgeCalibration(_Stub):
    pass


class JudgeSeedCase(_Stub):
    pass
