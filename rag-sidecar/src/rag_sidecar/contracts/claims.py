from pydantic import BaseModel, ConfigDict

MAX_CLAIMS = 0


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class ClaimCheckRequest(_Stub):
    pass


class ClaimCheckResult(_Stub):
    pass


class ClaimJudgement(_Stub):
    pass


class ClaimVerdict(_Stub):
    pass


class GroundednessJudgeThresholds(_Stub):
    pass
