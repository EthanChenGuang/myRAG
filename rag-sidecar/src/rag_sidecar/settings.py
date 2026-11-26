import os
from importlib.metadata import PackageNotFoundError, version as _package_version
from pathlib import Path
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, model_validator

SECRET_ENV_VAR = "RAG_SIDECAR_SECRET"
PARSE_WORKERS_ENV_VAR = "RAG_SIDECAR_PARSE_WORKERS"
PARSE_QUEUE_ENV_VAR = "RAG_SIDECAR_PARSE_QUEUE"
PARSE_TTL_ENV_VAR = "RAG_SIDECAR_PARSE_TTL_SECONDS"
MAX_UPLOAD_ENV_VAR = "RAG_SIDECAR_MAX_UPLOAD_MB"
PAGE_CAP_ENV_VAR = "RAG_SIDECAR_PAGE_CAP"
DOCLING_ARTIFACTS_ENV_VAR = "RAG_SIDECAR_DOCLING_ARTIFACTS"
INGEST_WORKER_ENV_VAR = "RAG_INGEST_WORKER"
INGEST_WORKER_CONCURRENCY_ENV_VAR = "RAG_INGEST_WORKER_CONCURRENCY"
INGEST_APP_RATE_ENV_VAR = "RAG_INGEST_APP_RATE"
INGEST_CONVERTER_ENV_VAR = "RAG_INGEST_CONVERTER"
INGEST_RECORDED_DIR_ENV_VAR = "RAG_INGEST_RECORDED_DIR"
SIDECAR_ENV_VAR = "RAG_SIDECAR_ENV"
SUPABASE_URL_ENV_VAR = "NEXT_PUBLIC_SUPABASE_URL"
SERVICE_ROLE_KEY_ENV_VAR = "SUPABASE_SERVICE_ROLE_KEY"
APP_INTERNAL_URL_ENV_VAR = "RAG_APP_INTERNAL_URL"
VECTARA_API_KEY_ENV_VAR = "VECTARA_API_KEY"
VECTARA_BASE_URL_ENV_VAR = "VECTARA_BASE_URL"
HHEM_MODEL_REVISION_ENV_VAR = "HHEM_MODEL_REVISION"
PROMPT_GUARD_ENABLED_ENV_VAR = "PROMPT_GUARD_ENABLED"
PROMPT_GUARD_MODEL_DIR_ENV_VAR = "PROMPT_GUARD_MODEL_DIR"
REDIS_URL_ENV_VAR = "REDIS_URL"
DEFAULT_VECTARA_BASE_URL = "https://api.vectara.io"
DEFAULT_HHEM_MODEL_REVISION = "de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8"


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
    ingest_worker: bool = False
    ingest_worker_concurrency: int = Field(default=2, ge=1, le=32)
    ingest_app_rate: float = Field(default=10.0, ge=0.1, le=10_000.0)
    ingest_converter: str = "docling"
    ingest_recorded_dir: str | None = None
    sidecar_env: str | None = None
    supabase_url: str | None = None
    service_role_key: SecretStr | None = None
    app_internal_url: str | None = None
    vectara_api_key: SecretStr | None = None
    vectara_base_url: str = DEFAULT_VECTARA_BASE_URL
    hhem_model_revision: str = DEFAULT_HHEM_MODEL_REVISION
    prompt_guard_enabled: bool = False
    prompt_guard_model_dir: str | None = None
    redis_url: SecretStr | None = None

    def model_post_init(self, __context: object) -> None:
        if not self.version:
            object.__setattr__(self, "version", _package_version_or_fallback())

    @property
    def secret_configured(self) -> bool:
        return self.secret is not None and len(self.secret.get_secret_value()) >= self.min_secret_length

    @property
    def vectara_configured(self) -> bool:
        return self.vectara_api_key is not None and len(self.vectara_api_key.get_secret_value().strip()) > 0

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def worker_id(self) -> str:
        return "sidecar-ingest"

    def worker_env_ready(self) -> bool:
        if not self.ingest_worker:
            return True
        return bool(
            (self.supabase_url or "").strip()
            and self.service_role_key is not None
            and len(self.service_role_key.get_secret_value()) > 0
            and (self.app_internal_url or "").strip()
            and self.secret_configured
        )

    def build_range_converter(self):
        from rag_sidecar.ingest.converters import select_range_converter

        recorded_root = Path(self.ingest_recorded_dir) if self.ingest_recorded_dir else None
        return select_range_converter(self.ingest_converter, recorded_root=recorded_root)

    @model_validator(mode="after")
    def _recorded_converter_test_only(self) -> Self:
        recorded_dir = (self.ingest_recorded_dir or "").strip()
        if self.ingest_converter == "recorded" or recorded_dir:
            if self.sidecar_env != "test":
                raise ValueError("recorded_converter_requires_test_env")
        if self.ingest_converter == "recorded" and not recorded_dir:
            raise ValueError("recorded_converter_requires_dir")
        return self


_INT_VARIABLES = {
    "parse_workers": PARSE_WORKERS_ENV_VAR,
    "parse_queue": PARSE_QUEUE_ENV_VAR,
    "parse_ttl_seconds": PARSE_TTL_ENV_VAR,
    "max_upload_mb": MAX_UPLOAD_ENV_VAR,
    "page_cap": PAGE_CAP_ENV_VAR,
    "ingest_worker_concurrency": INGEST_WORKER_CONCURRENCY_ENV_VAR,
}


def _usable_int(field: str, raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        value = int(raw.strip())
        SidecarSettings(**{field: value})
    except (ValueError, ValidationError):
        return None
    return value


def _on_off(raw: str | None, *, default: bool = False) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() == "on"


def _usable_float(raw: str | None) -> float | None:
    if raw is None:
        return None
    try:
        value = float(raw.strip())
        SidecarSettings(ingest_app_rate=value)
    except (ValueError, ValidationError):
        return None
    return value


def load_settings() -> SidecarSettings:
    raw = os.environ.get(SECRET_ENV_VAR)
    values: dict[str, object] = {"secret": SecretStr(raw) if raw else None}
    for field, variable in _INT_VARIABLES.items():
        value = _usable_int(field, os.environ.get(variable))
        if value is not None:
            values[field] = value
    artifacts = (os.environ.get(DOCLING_ARTIFACTS_ENV_VAR) or "").strip()
    values["docling_artifacts"] = artifacts or None
    values["ingest_worker"] = _on_off(os.environ.get(INGEST_WORKER_ENV_VAR))
    rate = _usable_float(os.environ.get(INGEST_APP_RATE_ENV_VAR))
    if rate is not None:
        values["ingest_app_rate"] = rate
    converter = (os.environ.get(INGEST_CONVERTER_ENV_VAR) or "docling").strip().lower()
    values["ingest_converter"] = converter or "docling"
    recorded = (os.environ.get(INGEST_RECORDED_DIR_ENV_VAR) or "").strip()
    values["ingest_recorded_dir"] = recorded or None
    sidecar_env = (os.environ.get(SIDECAR_ENV_VAR) or "").strip()
    values["sidecar_env"] = sidecar_env or None
    supabase = (os.environ.get(SUPABASE_URL_ENV_VAR) or "").strip()
    values["supabase_url"] = supabase.rstrip("/") or None
    service = (os.environ.get(SERVICE_ROLE_KEY_ENV_VAR) or "").strip()
    values["service_role_key"] = SecretStr(service) if service else None
    app_url = (os.environ.get(APP_INTERNAL_URL_ENV_VAR) or "").strip()
    values["app_internal_url"] = app_url.rstrip("/") or None
    vectara_key = (os.environ.get(VECTARA_API_KEY_ENV_VAR) or "").strip()
    values["vectara_api_key"] = SecretStr(vectara_key) if vectara_key else None
    vectara_base = (os.environ.get(VECTARA_BASE_URL_ENV_VAR) or "").strip().rstrip("/")
    values["vectara_base_url"] = vectara_base or DEFAULT_VECTARA_BASE_URL
    revision = (os.environ.get(HHEM_MODEL_REVISION_ENV_VAR) or "").strip()
    values["hhem_model_revision"] = revision or DEFAULT_HHEM_MODEL_REVISION
    values["prompt_guard_enabled"] = (os.environ.get(PROMPT_GUARD_ENABLED_ENV_VAR) or "").strip().lower() == "true"
    model_dir = (os.environ.get(PROMPT_GUARD_MODEL_DIR_ENV_VAR) or "").strip()
    values["prompt_guard_model_dir"] = model_dir or None
    return SidecarSettings(**values)