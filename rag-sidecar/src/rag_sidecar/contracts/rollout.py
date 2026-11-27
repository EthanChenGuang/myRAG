from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RolloutRecord(_Contract):
    pass


class RolloutPromoteResult(_Contract):
    pass
