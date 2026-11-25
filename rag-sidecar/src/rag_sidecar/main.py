import asyncio
import contextlib
import json
import random
import tempfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from pydantic import ValidationError

from rag_sidecar.auth import SharedSecretMiddleware
from rag_sidecar.contracts import (
    InvoiceExtractRequest,
    InvoiceFields,
    ParseJobAccepted,
    ParseJobRequest,
    SidecarError,
    SidecarHealth,
    SidecarInfo,
    SidecarReady,
)
from rag_sidecar.extract.invoice import extract_invoice
from rag_sidecar.groundedness.router import build_groundedness_router
from rag_sidecar.groundedness.scorer import Scorer, available_scorer_names, build_scorers, close_scorers
from rag_sidecar.injection.router import build_injection_router
from rag_sidecar.injection.scorer import InjectionScorer, load_prompt_guard_config, resolve_scorer
from rag_sidecar.ingest.app_client import AppClient
from rag_sidecar.ingest.ledger_client import LedgerClient
from rag_sidecar.ingest.pool import UPLOAD_PRIORITY, PriorityPool
from rag_sidecar.ingest.storage_client import StorageClient
from rag_sidecar.ingest.worker import IngestWorker, RealClock
from rag_sidecar.parse.converter import Converter, default_converter
from rag_sidecar.parse.jobs import JobRunner, QueueFull
from rag_sidecar.parse.upload import BODY_ALLOWANCE_BYTES, MalformedUpload, UploadTooLarge, read_upload
from rag_sidecar.security.router import build_hidden_text_router
from rag_sidecar.settings import SidecarSettings, load_settings

CONTRACTS_SCHEMA_VERSION = 2
INVOICE_MARKDOWN_MAX_CHARS = 2_000_000
INVOICE_BODY_MAX_BYTES = 8 * 1024 * 1024

_ARTIFACT_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".json": "application/json",
}


def _error(status: int, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status, content=SidecarError(error=message).model_dump(mode="json"), headers=headers
    )


def _looks_like_pdf(path: Path) -> bool:
    try:
        head = path.read_bytes()[:8]
    except OSError:
        return False
    return head.startswith(b"%PDF-")


def _run_preflight_job(
    path: Path,
    settings: SidecarSettings,
    routing_cfg,
    file_sha: str,
) -> dict:
    from rag_sidecar.preflight.l1 import EncryptedPdf
    from rag_sidecar.preflight.run import run_preflight

    try:
        converter = settings.build_range_converter()
        output = run_preflight(path, None, routing_cfg, converter, file_sha=file_sha)
        return output.result.model_dump(mode="json")
    except EncryptedPdf:
        return {"__preflight_error__": "encrypted_pdf"}


def create_app(
    settings: SidecarSettings | None = None,
    converter: Converter | None = None,
    scorers: Mapping[str, Scorer] | None = None,
    injection_scorer: InjectionScorer | None = None,
) -> FastAPI:
    resolved = settings if settings is not None else load_settings()
    active_converter = converter if converter is not None else default_converter()
    docling_in_use = converter is None and active_converter is not None
    runner = JobRunner(resolved, active_converter) if active_converter is not None else None
    active_scorers: Mapping[str, Scorer] = scorers if scorers is not None else build_scorers(resolved)
    prompt_guard_config = load_prompt_guard_config()
    active_injection_scorer = (
        injection_scorer if injection_scorer is not None else resolve_scorer(resolved, prompt_guard_config)
    )

    ingest_worker: IngestWorker | None = None
    ingest_pool: PriorityPool | None = None
    preflight_pool: PriorityPool | None = None
    ingest_task: asyncio.Task[None] | None = None
    ledger_client: LedgerClient | None = None
    app_client: AppClient | None = None
    storage_client: StorageClient | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        nonlocal ingest_worker, ingest_pool, preflight_pool, ingest_task, ledger_client, app_client, storage_client
        from rag_sidecar.ingest.maintenance import start_maintenance_from_env

        preflight_pool = PriorityPool(workers=resolved.parse_workers)
        preflight_pool.start()
        app.state.preflight_pool = preflight_pool
        if resolved.ingest_worker and resolved.worker_env_ready():
            assert resolved.supabase_url is not None
            assert resolved.service_role_key is not None
            assert resolved.app_internal_url is not None
            assert resolved.secret is not None
            ledger_client = LedgerClient(
                base_url=resolved.supabase_url,
                service_key=resolved.service_role_key.get_secret_value(),
            )
            app_client = AppClient(app_base_url=resolved.app_internal_url, secret=resolved.secret)
            storage_client = StorageClient(
                base_url=resolved.supabase_url,
                service_key=resolved.service_role_key.get_secret_value(),
            )
            ingest_pool = PriorityPool(workers=resolved.parse_workers)
            ingest_pool.start()
            ingest_worker = IngestWorker(
                resolved,
                ledger_client,
                storage_client,
                app_client,
                ingest_pool,
                RealClock(),
                random.Random(),
            )
            ingest_task = asyncio.create_task(ingest_worker.run())
            app.state.ingest_worker = ingest_worker
        maintenance = start_maintenance_from_env()
        try:
            yield
        finally:
            if maintenance is not None:
                await maintenance.stop()
            if ingest_worker is not None:
                await ingest_worker.stop()
            if ingest_pool is not None:
                await ingest_pool.stop()
            if preflight_pool is not None:
                await preflight_pool.stop()
            if ledger_client is not None:
                await ledger_client.aclose()
            if app_client is not None:
                await app_client.aclose()
            if storage_client is not None:
                await storage_client.aclose()
            if ingest_task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await ingest_task
            await close_scorers(active_scorers)
            if runner is not None:
                runner.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.parse_runner = runner
    app.add_middleware(SharedSecretMiddleware, settings=resolved)

    @app.get("/health", response_model=SidecarHealth)
    def health() -> SidecarHealth:
        return SidecarHealth(status="ok")

    @app.get("/ready", response_model=SidecarReady)
    def ready(request: Request) -> SidecarReady | JSONResponse:
        if not resolved.secret_configured:
            not_ready = SidecarReady(status="not_ready", reason="sidecar secret not configured")
            return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))
        if resolved.ingest_worker and not resolved.worker_env_ready():
            not_ready = SidecarReady(status="not_ready", reason="worker_env_missing")
            return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))
        if docling_in_use and not (resolved.docling_artifacts and Path(resolved.docling_artifacts).is_dir()):
            not_ready = SidecarReady(status="not_ready", reason="docling_artifacts_missing")
            return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))
        worker = getattr(request.app.state, "ingest_worker", None)
        if resolved.ingest_worker and worker is not None:
            ok, reason = worker.readiness(env_ok=resolved.worker_env_ready())
            if not ok:
                not_ready = SidecarReady(status="not_ready", reason=reason or "worker_not_ready")
                return JSONResponse(status_code=503, content=not_ready.model_dump(mode="json"))
            return SidecarReady(status="ready", reason="worker_running", scorers=available_scorer_names(active_scorers))
        return SidecarReady(status="ready", scorers=available_scorer_names(active_scorers))

    v1 = APIRouter(prefix="/v1")

    @v1.get("/info", response_model=SidecarInfo)
    def info() -> SidecarInfo:
        return SidecarInfo(
            service="rag-sidecar",
            version=resolved.version,
            contracts_schema_version=CONTRACTS_SCHEMA_VERSION,
        )

    @v1.post("/parse/jobs", status_code=202, response_model=ParseJobAccepted)
    async def submit_parse_job(request: Request) -> Response:
        if runner is None:
            return _error(503, "docling_unavailable")
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > resolved.max_upload_bytes + BODY_ALLOWANCE_BYTES:
            return _error(413, "upload_too_large")
        try:
            slot = runner.reserve()
        except QueueFull as full:
            return _error(429, "parse_queue_full", {"Retry-After": str(full.retry_after)})
        started = False
        try:
            try:
                upload = await read_upload(
                    request.stream(),
                    request.headers.get("content-type", ""),
                    slot.input_path,
                    resolved.max_upload_bytes,
                )
            except UploadTooLarge:
                return _error(413, "upload_too_large")
            except MalformedUpload:
                return _error(422, "invalid_parse_request")
            if upload.request_json is None or upload.file_bytes == 0:
                return _error(422, "invalid_parse_request")
            try:
                parse_request = ParseJobRequest.model_validate_json(upload.request_json)
            except ValidationError:
                return _error(422, "invalid_parse_request")
            job_id = runner.start(slot, parse_request)
            started = True
            return JSONResponse(status_code=202, content=ParseJobAccepted(job_id=job_id).model_dump(mode="json"))
        finally:
            if not started:
                runner.release(slot)

    @v1.get("/parse/jobs/{job_id}")
    def get_parse_job(job_id: str) -> Response:
        if runner is None:
            return _error(503, "docling_unavailable")
        state = runner.state(job_id)
        if state is None:
            return _error(404, "job_not_found")
        return JSONResponse(content=state.model_dump(mode="json"))

    @v1.delete("/parse/jobs/{job_id}")
    def delete_parse_job(job_id: str) -> Response:
        if runner is None:
            return _error(503, "docling_unavailable")
        if not runner.delete(job_id):
            return _error(404, "job_not_found")
        return Response(status_code=204)

    @v1.get("/parse/jobs/{job_id}/artifacts/{name}")
    def get_parse_artifact(job_id: str, name: str) -> Response:
        if runner is None:
            return _error(503, "docling_unavailable")
        path = runner.artifact(job_id, name)
        if path is None:
            return _error(404, "artifact_not_found")
        media_type = _ARTIFACT_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
        return FileResponse(path, media_type=media_type, headers={"x-content-type-options": "nosniff"})

    @v1.post("/preflight")
    async def preflight_probe(request: Request) -> Response:
        pool: PriorityPool | None = getattr(request.app.state, "preflight_pool", None)
        if pool is None:
            return _error(503, "preflight_unavailable")
        from rag_sidecar.preflight.config import load_routing_config
        from rag_sidecar.preflight.l2 import sha256_file

        routing_cfg = load_routing_config()
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > resolved.max_upload_bytes + BODY_ALLOWANCE_BYTES:
            return _error(413, "upload_too_large")
        with tempfile.TemporaryDirectory(prefix="rag-preflight-") as scratch:
            upload_path = Path(scratch) / "upload.bin"
            try:
                upload = await read_upload(
                    request.stream(),
                    request.headers.get("content-type", ""),
                    upload_path,
                    resolved.max_upload_bytes,
                )
            except UploadTooLarge:
                return _error(413, "upload_too_large")
            except MalformedUpload:
                return _error(415, "invalid_preflight_request")
            if upload.file_bytes == 0:
                return _error(415, "invalid_preflight_request")
            if not _looks_like_pdf(upload_path):
                return _error(415, "invalid_preflight_request")
            digest = sha256_file(upload_path)
            deadline_s = routing_cfg.timeouts.preflight_ms / 1000.0
            future = pool.submit(
                _run_preflight_job,
                (upload_path, resolved, routing_cfg, digest),
                priority=UPLOAD_PRIORITY,
                deadline_s=deadline_s,
            )
            try:
                payload = await future
            except Exception:
                return _error(500, "preflight_failed")
            if isinstance(payload, dict) and payload.get("__preflight_error__") == "encrypted_pdf":
                return _error(422, "encrypted_pdf")
            return JSONResponse(content=payload)

    @v1.post("/ingest/wake", status_code=202)
    def ingest_wake(request: Request) -> JSONResponse:
        worker = getattr(request.app.state, "ingest_worker", None)
        if worker is None:
            return JSONResponse(status_code=202, content={"woken": False})
        worker.wake()
        return JSONResponse(status_code=202, content={"woken": True})

    @v1.post("/extract/invoice", response_model=InvoiceFields)
    async def extract_invoice_fields(request: Request) -> Response:
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > INVOICE_BODY_MAX_BYTES:
            return _error(413, "invoice_too_large")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > INVOICE_BODY_MAX_BYTES:
                return _error(413, "invoice_too_large")
        try:
            payload = json.loads(body)
        except (ValueError, RecursionError):
            return _error(422, "invalid_invoice_request")
        markdown = payload.get("markdown") if isinstance(payload, dict) else None
        if isinstance(markdown, str) and len(markdown) > INVOICE_MARKDOWN_MAX_CHARS:
            return _error(413, "invoice_too_large")
        try:
            extract_request = InvoiceExtractRequest.model_validate(payload)
        except ValidationError:
            return _error(422, "invalid_invoice_request")
        fields = await run_in_threadpool(
            extract_invoice, extract_request.markdown, extract_request.tables, extract_request.language_hint
        )
        return JSONResponse(content=fields.model_dump(mode="json"))

    v1.include_router(build_groundedness_router(resolved, active_scorers))
    v1.include_router(build_injection_router(active_injection_scorer, prompt_guard_config))
    v1.include_router(build_hidden_text_router(resolved))
    app.include_router(v1)
    return app


app = create_app()
