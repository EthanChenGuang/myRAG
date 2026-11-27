"""POST /v1/embed: an EmbedRequest answered with an EmbedResponse (D-26).

The shared-secret middleware guards the route. Texts are never logged; only counts and latency.
"""

from __future__ import annotations

import logging
import math
import time

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import SidecarError
from rag_sidecar.contracts.embed import BGE_M3_DIMS, EmbedRequest, EmbedResponse
from rag_sidecar.embed.bge_m3 import EmbedInputTooLong, Embedder

logger = logging.getLogger("rag_sidecar.embed")

# 32 inputs x 20,000 characters x 4 UTF-8 bytes plus JSON overhead.
MAX_BODY_BYTES = 4 * 1024 * 1024
UNAVAILABLE = "model_unavailable"


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=SidecarError(error=message).model_dump(mode="json"))


def _usable(vectors: object, expected: int) -> bool:
    if not isinstance(vectors, list) or len(vectors) != expected:
        return False
    return all(
        isinstance(vector, list) and len(vector) == BGE_M3_DIMS and all(math.isfinite(x) for x in vector)
        for vector in vectors
    )


def build_embed_router(embedder: Embedder | None) -> APIRouter:
    router = APIRouter()

    @router.post("/embed", response_model=EmbedResponse)
    async def embed(request: Request) -> JSONResponse:
        started = time.monotonic()
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, "embed_request_too_large")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _error(413, "embed_request_too_large")
        try:
            payload = EmbedRequest.model_validate_json(bytes(body))
        except (ValidationError, ValueError):
            return _error(422, "invalid_embed_request")

        if embedder is None:
            return _error(503, UNAVAILABLE)
        try:
            vectors = await run_in_threadpool(embedder.embed, list(payload.inputs))
        except EmbedInputTooLong as too_long:
            return _error(422, f"embed_input_too_long: limit {too_long.limit} tokens")
        except Exception as exc:
            logger.warning(
                "[Embed] BGE-M3 embedding failed", extra={"inputs": len(payload.inputs), "error": type(exc).__name__}
            )
            return _error(503, UNAVAILABLE)
        if not _usable(vectors, len(payload.inputs)):
            logger.warning("[Embed] BGE-M3 returned unusable vectors", extra={"inputs": len(payload.inputs)})
            return _error(503, UNAVAILABLE)

        response = EmbedResponse(revision=embedder.revision, vectors=vectors)
        logger.info(
            "[Embed] BGE-M3 embedded",
            extra={"inputs": len(payload.inputs), "latency_ms": max(0, int((time.monotonic() - started) * 1000))},
        )
        return JSONResponse(content=response.model_dump(mode="json"))

    return router
