from pydantic import BaseModel


class SidecarHealth(BaseModel):
    status: str


class SidecarReady(BaseModel):
    status: str
    reason: str | None = None


class SidecarInfo(BaseModel):
    service: str
    version: str
    contracts_schema_version: int


class SidecarError(BaseModel):
    error: str
