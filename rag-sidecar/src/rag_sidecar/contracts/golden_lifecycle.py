from pydantic import BaseModel, ConfigDict


class _Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GoldenSetManifest(_Contract):
    pass


def manifest_hash(data: dict) -> str:
    return ""
