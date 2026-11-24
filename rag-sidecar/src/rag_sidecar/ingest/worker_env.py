"""Environment of the ingestion worker (D-09)."""

from __future__ import annotations

import os
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, SecretStr

_SUPABASE_URL = "NEXT_PUBLIC_SUPABASE_URL"
_SERVICE_KEY = "SUPABASE_SERVICE_ROLE_KEY"
_APP_URL = "RAG_APP_INTERNAL_URL"
_SECRET = "RAG_SIDECAR_SECRET"
_REQUIRED = (_SUPABASE_URL, _SERVICE_KEY, _APP_URL, _SECRET)


class WorkerEnv(BaseModel):
    model_config = ConfigDict(frozen=True)

    supabase_url: str
    service_role_key: SecretStr
    app_internal_url: str
    sidecar_secret: SecretStr

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> WorkerEnv:
        source = os.environ if environ is None else environ
        values = {name: (source.get(name) or "").strip() for name in _REQUIRED}
        missing = [name for name in _REQUIRED if not values[name]]
        if missing:
            raise ValueError(f"worker environment is incomplete: {', '.join(missing)}")
        return cls(
            supabase_url=values[_SUPABASE_URL].rstrip("/"),
            service_role_key=SecretStr(values[_SERVICE_KEY]),
            app_internal_url=values[_APP_URL].rstrip("/"),
            sidecar_secret=SecretStr(values[_SECRET]),
        )
