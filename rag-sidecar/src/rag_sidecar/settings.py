import os
from importlib.metadata import PackageNotFoundError, version as _package_version

from pydantic import BaseModel, ConfigDict, SecretStr

SECRET_ENV_VAR = "RAG_SIDECAR_SECRET"


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

    def model_post_init(self, __context: object) -> None:
        if not self.version:
            object.__setattr__(self, "version", _package_version_or_fallback())

    @property
    def secret_configured(self) -> bool:
        return self.secret is not None and len(self.secret.get_secret_value()) >= self.min_secret_length


def load_settings() -> SidecarSettings:
    raw = os.environ.get(SECRET_ENV_VAR)
    return SidecarSettings(secret=SecretStr(raw) if raw else None)
