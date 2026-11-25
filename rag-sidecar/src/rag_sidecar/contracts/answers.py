from pydantic import BaseModel, ConfigDict


class _Stub(BaseModel):
    model_config = ConfigDict(extra="allow")


class CitationRecord(_Stub):
    pass


class AnswerGroundedness(_Stub):
    pass


class AnswerFeedback(_Stub):
    pass


class AnswerFeedbackRequest(_Stub):
    pass


class AnswerRecord(_Stub):
    pass
