"""Environment of the ingestion worker (D-09)."""

from __future__ import annotations

from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, SecretStr


class WorkerEnv(BaseModel):
    model_config = ConfigDict(frozen=True)

    supabase_url: str
    service_role_key: SecretStr
    app_internal_url: str
    sidecar_secret: SecretStr

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> WorkerEnv:
        raise NotImplementedError("from_env")
