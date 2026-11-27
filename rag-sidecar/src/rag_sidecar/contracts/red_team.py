from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RedTeamCorpusItem(_Contract):
    pass


class RedTeamReport(_Contract):
    pass
