from pydantic import BaseModel, ConfigDict


class OutputCaps(BaseModel):
    model_config = ConfigDict(extra="allow")
