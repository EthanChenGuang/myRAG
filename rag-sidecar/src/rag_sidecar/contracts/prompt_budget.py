from pydantic import BaseModel, ConfigDict


class _Loose(BaseModel):
    model_config = ConfigDict(extra="allow")


class PromptBudgetConfig(_Loose):
    pass


class TokenizerCalibration(_Loose):
    pass


class PromptBudgetTrace(_Loose):
    pass


class PromptBudgetSummary(_Loose):
    pass
