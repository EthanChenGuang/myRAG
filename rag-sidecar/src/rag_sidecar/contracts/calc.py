from pydantic import BaseModel, ConfigDict


class _Loose(BaseModel):
    model_config = ConfigDict(extra="allow")


class CalcSource(_Loose):
    pass


class CalcOperand(_Loose):
    pass


class CalcRounding(_Loose):
    pass


class CalcStep(_Loose):
    pass


class CalcRequest(_Loose):
    pass


class CalcResult(_Loose):
    pass


class CalcTrace(_Loose):
    pass


class CalcCheck(_Loose):
    pass


class CalcLimits(_Loose):
    pass
