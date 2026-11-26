from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class AnswerSentence(_Stub):
    pass


class BlockedRange(_Stub):
    pass


class OutputGuardSummary(_Stub):
    pass


class VersionConflict(_Stub):
    pass


class AnswerNotice(_Stub):
    pass


class ClaimsSummary(_Stub):
    pass


class AnswerChecks(_Stub):
    pass
