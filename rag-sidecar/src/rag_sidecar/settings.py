import os
from importlib.metadata import PackageNotFoundError, version as _package_version

from pydantic import BaseModel, ConfigDict, Field, SecretStr

SECRET_ENV_VAR = "RAG_SIDECAR_SECRET"
PARSE_WORKERS_ENV_VAR = "RAG_SIDECAR_PARSE_WORKERS"
PARSE_QUEUE_ENV_VAR = "RAG_SIDECAR_PARSE_QUEUE"
PARSE_TTL_ENV_VAR = "RAG_SIDECAR_PARSE_TTL_SECONDS"
MAX_UPLOAD_ENV_VAR = "RAG_SIDECAR_MAX_UPLOAD_MB"
PAGE_CAP_ENV_VAR = "RAG_SIDECAR_PAGE_CAP"
DOCLING_ARTIFACTS_ENV_VAR = "RAG_SIDECAR_DOCLING_ARTIFACTS"


def _package_version_or_fallback() -> str:
    try:
        return _package_version("rag-sidecar")
    except PackageNotFoundError:
        from rag_sidecar import __version__

        return __version__


class SidecarSettings(BaseModel):
    model_config = ConfigDict(frozen=True)

    secret: SecretStr | None = None
    min_secret_length: int = 32
    version: str = ""
    parse_workers: int = Field(default=1, ge=1, le=8)
    parse_queue: int = Field(default=8, ge=0, le=1000)
    parse_ttl_seconds: int = Field(default=3600, ge=1, le=604800)
    max_upload_mb: int = Field(default=20, ge=1, le=500)
    page_cap: int = Field(default=300, ge=1, le=10000)
    docling_artifacts: str | None = None

    def model_post_init(self, __context: object) -> None:
        if not self.version:
            object.__setattr__(self, "version", _package_version_or_fallback())

    @property
    def secret_configured(self) -> bool:
        return self.secret is not None and len(self.secret.get_secret_value()) >= self.min_secret_length

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def load_settings() -> SidecarSettings:
    raw = os.environ.get(SECRET_ENV_VAR)
    return SidecarSettings(secret=SecretStr(raw) if raw else None)
