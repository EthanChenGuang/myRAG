from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class GroundednessRequest(_Stub):
    pass


class GroundednessResult(_Stub):
    pass


class GroundednessThresholdCell(_Stub):
    pass


class GroundednessThresholds(_Stub):
    pass
