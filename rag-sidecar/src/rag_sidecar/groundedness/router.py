import logging
import math
import time
from collections.abc import Mapping

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import GroundednessRequest, GroundednessResult, SidecarError
from rag_sidecar.groundedness.scorer import LOCAL_SCORER, VECTARA_SCORER, Scorer, ScorerBusy, ScorerUnavailable
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.groundedness")

MAX_PREMISE_CHARS = 60_000
MAX_HYPOTHESIS_CHARS = 60_000
MAX_BODY_BYTES = 1024 * 1024

VECTARA_LANGUAGES = frozenset({"en", "zh-hans"})
LOCAL_LANGUAGES = frozenset({"en"})


class _NotChecked(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=SidecarError(error=message).model_dump(mode="json"))


def _usable(scorers: Mapping[str, Scorer], name: str) -> Scorer | None:
    scorer = scorers.get(name)
    if scorer is None:
        return None
    try:
        return scorer if scorer.available() else None
    except Exception:
        return None


def _valid_score(value: object) -> float:
    try:
        score = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ScorerUnavailable("invalid_score") from None
    if math.isnan(score) or score < 0.0 or score > 1.0:
        raise ScorerUnavailable("invalid_score")
    return score


async def _run(scorer: Scorer, payload: GroundednessRequest) -> float:
    try:
        raw = await scorer.score(list(payload.premise_texts), payload.hypothesis)
    except (ScorerUnavailable, ScorerBusy):
        raise
    except Exception as exc:
        raise ScorerUnavailable("scorer_error") from exc
    return _valid_score(raw)


async def route_groundedness(scorers: Mapping[str, Scorer], payload: GroundednessRequest) -> tuple[str, float]:
    language = payload.language.strip().lower()
    if language not in VECTARA_LANGUAGES and language not in LOCAL_LANGUAGES:
        raise _NotChecked("unsupported_language")
    premise_chars = sum(len(text) for text in payload.premise_texts)
    if premise_chars > MAX_PREMISE_CHARS or len(payload.hypothesis) > MAX_HYPOTHESIS_CHARS:
        raise _NotChecked("too_long")

    if payload.allow_vectara and language in VECTARA_LANGUAGES:
        vectara = _usable(scorers, VECTARA_SCORER)
        if vectara is not None:
            try:
                return VECTARA_SCORER, await _run(vectara, payload)
            except (ScorerUnavailable, ScorerBusy) as failure:
                logger.warning(
                    "[Groundedness] vectara failed, no retry",
                    extra={"request_id": payload.request_id, "reason": getattr(failure, "reason", "scorer_busy")},
                )

    if language not in LOCAL_LANGUAGES:
        raise _NotChecked("scorer_unavailable")
    local = _usable(scorers, LOCAL_SCORER)
    if local is None:
        raise _NotChecked("scorer_unavailable")
    try:
        return LOCAL_SCORER, await _run(local, payload)
    except ScorerBusy:
        raise _NotChecked("scorer_busy") from None
    except ScorerUnavailable as failure:
        logger.warning(
            "[Groundedness] local scorer failed",
            extra={"request_id": payload.request_id, "reason": failure.reason},
        )
        raise _NotChecked("scorer_unavailable") from None


def build_groundedness_router(settings: SidecarSettings, scorers: Mapping[str, Scorer]) -> APIRouter:
    router = APIRouter()

    @router.post("/groundedness", response_model=GroundednessResult)
    async def groundedness(request: Request) -> JSONResponse:
        started = time.monotonic()
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return _error(413, "groundedness_request_too_large")
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                return _error(413, "groundedness_request_too_large")
        try:
            payload = GroundednessRequest.model_validate_json(bytes(body))
        except (ValidationError, ValueError):
            return _error(422, "invalid_groundedness_request")

        try:
            scorer, score = await route_groundedness(scorers, payload)
            result = GroundednessResult(
                status="scored",
                scorer=scorer,  # type: ignore[arg-type]
                score=score,
                latency_ms=max(0, int((time.monotonic() - started) * 1000)),
            )
        except _NotChecked as skipped:
            result = GroundednessResult(
                status="not_checked",
                scorer="none",
                reason=skipped.reason,
                latency_ms=max(0, int((time.monotonic() - started) * 1000)),
            )
        logger.info(
            "[Groundedness] %s",
            result.status,
            extra={
                "request_id": payload.request_id,
                "scorer": result.scorer,
                "reason": result.reason,
                "latency_ms": result.latency_ms,
            },
        )
        return JSONResponse(content=result.model_dump(mode="json"))

    return router
