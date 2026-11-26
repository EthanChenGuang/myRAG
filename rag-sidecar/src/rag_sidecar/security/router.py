"""POST /v1/hidden-text: the original file plus a HiddenTextRequest, answered with a HiddenTextReport (D-33).

The shared-secret middleware guards the route and fails closed when no secret is set. Spans and link
targets are never logged; only counts, reason kinds and the checker version.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import tempfile
import time
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import SidecarError
from rag_sidecar.contracts.ingest_security import HiddenTextReport, HiddenTextRequest
from rag_sidecar.parse.upload import BODY_ALLOWANCE_BYTES, MalformedUpload, UploadTooLarge, read_upload
from rag_sidecar.security.hidden_text import (
    CheckerUnavailable,
    EncryptedDocument,
    UnreadableDocument,
    UnsafePackage,
    cached_rules,
    check_hidden_text,
)
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.security")

CHECK_TIMEOUT_S = 60.0
UNAVAILABLE = "checker_unavailable"


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=SidecarError(error=message).model_dump(mode="json"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build_hidden_text_router(settings: SidecarSettings, timeout_s: float = CHECK_TIMEOUT_S) -> APIRouter:
    router = APIRouter()

    @router.post("/hidden-text", response_model=HiddenTextReport)
    async def hidden_text(request: Request) -> JSONResponse:
        started = time.monotonic()
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > settings.max_upload_bytes + BODY_ALLOWANCE_BYTES:
            return _error(413, "upload_too_large")
        with tempfile.TemporaryDirectory(prefix="rag-hidden-text-") as scratch:
            upload_path = Path(scratch) / "original.bin"
            try:
                upload = await read_upload(
                    request.stream(),
                    request.headers.get("content-type", ""),
                    upload_path,
                    settings.max_upload_bytes,
                )
            except UploadTooLarge:
                return _error(413, "upload_too_large")
            except MalformedUpload:
                return _error(422, "invalid_hidden_text_request")
            if upload.request_json is None or not upload_path.is_file():
                return _error(422, "invalid_hidden_text_request")
            try:
                payload = HiddenTextRequest.model_validate_json(upload.request_json)
            except ValidationError:
                return _error(422, "invalid_hidden_text_request")
            if payload.size_bytes != upload.file_bytes or payload.sha256 != _sha256(upload_path):
                return _error(422, "hidden_text_mismatch")
            try:
                rules = cached_rules()
            except Exception as exc:
                logger.warning("[RAG Security] hidden-text rules unavailable", extra={"error": type(exc).__name__})
                return _error(503, UNAVAILABLE)
            data = upload_path.read_bytes()
            try:
                report = await asyncio.wait_for(
                    run_in_threadpool(check_hidden_text, data, payload.mime_type, rules), timeout=timeout_s
                )
            except CheckerUnavailable:
                return _error(503, UNAVAILABLE)
            except EncryptedDocument:
                return _error(422, "encrypted_document")
            except UnreadableDocument:
                return _error(422, "unreadable_document")
            except UnsafePackage:
                return _error(422, "unsafe_package")
            except TimeoutError:
                logger.warning("[RAG Security] hidden-text check timed out", extra={"timeout_s": timeout_s})
                return _error(504, "hidden_text_timeout")
            except Exception as exc:
                logger.warning("[RAG Security] hidden-text check failed", extra={"error": type(exc).__name__})
                return _error(500, "hidden_text_failed")
        reasons = Counter(span.reason for span in report.spans)
        logger.info(
            "[RAG Security] hidden-text checked",
            extra={
                "status": report.status,
                "spans": len(report.spans),
                "dropped": report.dropped,
                "reasons": dict(sorted(reasons.items())),
                "link_targets": len(report.link_targets),
                "checker_version": report.checker_version,
                "latency_ms": max(0, int((time.monotonic() - started) * 1000)),
            },
        )
        return JSONResponse(content=report.model_dump(mode="json"))

    return router
