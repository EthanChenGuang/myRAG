import logging
import math
import time

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import (
    InjectionClassifyRequest,
    InjectionClassifyResponse,
    InjectionClassifyResult,
    SidecarError,
)
from rag_sidecar.contracts.injection import PromptGuardConfig
from rag_sidecar.injection.scorer import InjectionScorer, TextScore

logger = logging.getLogger("rag_sidecar.injection")

# 32 items x 20,000 characters x 4 UTF-8 bytes plus JSON overhead.
MAX_BODY_BYTES = 4 * 1024 * 1024
UNAVAILABLE = "promptguard_unavailable"


class _ScorerFailed(Exception):
    pass


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=SidecarError(error=message).model_dump(mode="json"))


def _checked(raw: object, expected: int) -> list[TextScore]:
    if not isinstance(raw, list) or len(raw) != expected:
        raise _ScorerFailed("result_count")
    checked: list[TextScore] = []
    for entry in raw:
        if not isinstance(entry, TextScore):
            raise _ScorerFailed("result_type")
        score = float(entry.score)
        if math.isnan(score) or score < 0.0 or score > 1.0 or entry.windows < 1:
            raise _ScorerFailed("result_value")
        checked.append(TextScore(score=score, windows=int(entry.windows)))
    return checked


def build_injection_router(scorer: InjectionScorer | None, config: PromptGuardConfig | None) -> APIRouter:
    router = APIRouter()

    @router.post("/injection/classify", response_model=InjectionClassifyResponse)
    async def classify(request: Request) -> JSONResponse:
        started = time.monotonic()
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, "injection_request_too_large")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _error(413, "injection_request_too_large")
        try:
            payload = InjectionClassifyRequest.model_validate_json(bytes(body))
        except (ValidationError, ValueError):
            return _error(422, "invalid_injection_request")

        if scorer is None or config is None:
            return _error(503, UNAVAILABLE)
        texts = [item.text for item in payload.items]
        try:
            scores = _checked(await run_in_threadpool(scorer.score, texts), len(texts))
        except Exception as exc:
            logger.warning(
                "[RAG Security] prompt guard scoring failed",
                extra={"items": len(texts), "error": type(exc).__name__},
            )
            return _error(503, UNAVAILABLE)

        response = InjectionClassifyResponse(
            model_id=scorer.model_id,
            revision=scorer.revision,
            results=[
                InjectionClassifyResult(
                    id=item.id,
                    score=scored.score,
                    label="MALICIOUS" if scored.score >= config.threshold else "BENIGN",
                    windows=scored.windows,
                )
                for item, scored in zip(payload.items, scores, strict=True)
            ],
        )
        logger.info(
            "[RAG Security] prompt guard classified",
            extra={
                "items": len(texts),
                "flagged": sum(1 for result in response.results if result.label == "MALICIOUS"),
                "latency_ms": max(0, int((time.monotonic() - started) * 1000)),
            },
        )
        return JSONResponse(content=response.model_dump(mode="json"))

    return router
