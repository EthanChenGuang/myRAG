from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse

from rag_sidecar.auth import SharedSecretMiddleware
from rag_sidecar.contracts import SidecarHealth, SidecarInfo, SidecarReady
from rag_sidecar.parse.converter import Converter
from rag_sidecar.settings import SidecarSettings, load_settings

CONTRACTS_SCHEMA_VERSION = 1


def create_app(settings: SidecarSettings | None = None, converter: Converter | None = None) -> FastAPI:
    resolved = settings if settings is not None else load_settings()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SharedSecretMiddleware, settings=resolved)

    @app.get("/health", response_model=SidecarHealth)
    def health() -> SidecarHealth:
        return SidecarHealth(status="ok")

    @app.get("/ready", response_model=SidecarReady)
    def ready() -> SidecarReady | JSONResponse:
        if resolved.secret_configured:
            return SidecarReady(status="ready")
        not_ready = SidecarReady(status="not_ready", reason="sidecar secret not configured")
        return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))

    v1 = APIRouter(prefix="/v1")

    @v1.get("/info", response_model=SidecarInfo)
    def info() -> SidecarInfo:
        return SidecarInfo(
            service="rag-sidecar",
            version=resolved.version,
            contracts_schema_version=CONTRACTS_SCHEMA_VERSION,
        )

    app.include_router(v1)
    return app


app = create_app()
