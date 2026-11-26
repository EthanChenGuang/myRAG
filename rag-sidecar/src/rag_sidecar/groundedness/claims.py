import asyncio
import logging
import time
from collections import Counter
from collections.abc import Mapping, Sequence

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from rag_sidecar.contracts import ClaimCheckRequest, ClaimCheckResult
from rag_sidecar.contracts.claims import ClaimVerdict
from rag_sidecar.groundedness.router import (
    LOCAL_LANGUAGES,
    MAX_BODY_BYTES,
    VECTARA_LANGUAGES,
    _error,
    _usable,
)
from rag_sidecar.groundedness.scorer import (
    LOCAL_SCORER,
    VECTARA_SCORER,
    ScorePair,
    Scorer,
    usable_score,
)
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.groundedness.claims")

PREMISE_SEPARATOR = "\n\n"


def build_premise(refs: Sequence[str], texts: Mapping[str, str], max_chars: int) -> list[str]:
    """Join the claim's premise_refs in the order sent (cited blocks first), cut to max_chars in total."""
    parts: list[str] = []
    used = 0
    for ref in refs:
        if parts:
            used += len(PREMISE_SEPARATOR)
        room = max_chars - used
        if room <= 0:
            break
        text = texts[ref]
        if len(text) > room:
            parts.append(text[:room])
            break
        parts.append(text)
        used += len(text)
    return parts


class _Tally:
    def __init__(self) -> None:
        self.scored: dict[int, tuple[str, float]] = {}
        self.failed: set[int] = set()

    def settled(self, index: int) -> bool:
        return index in self.scored or index in self.failed


async def _run_leg(
    scorer: Scorer,
    name: str,
    indexes: list[int],
    pairs: Mapping[int, ScorePair],
    tally: _Tally,
    *,
    retry_elsewhere: list[int] | None,
) -> None:
    def record(position: int, value: float | None) -> None:
        index = indexes[position]
        score = usable_score(value) if value is not None else None
        if score is not None:
            tally.scored[index] = (name, score)
        elif retry_elsewhere is not None:
            retry_elsewhere.append(index)
        else:
            tally.failed.add(index)

    try:
        await scorer.score_many([pairs[index] for index in indexes], on_result=record)
    except asyncio.CancelledError:
        raise
    except Exception as failure:
        logger.warning(
            "[Groundedness] claims scorer failed",
            extra={"scorer": name, "reason": getattr(failure, "reason", "scorer_error")},
        )
        handed = set(retry_elsewhere or [])
        for index in indexes:
            if tally.settled(index) or index in handed:
                continue
            if retry_elsewhere is not None:
                retry_elsewhere.append(index)
            else:
                tally.failed.add(index)


async def route_claims(
    payload: ClaimCheckRequest,
    settings: SidecarSettings,
    scorers: Mapping[str, Scorer],
    *,
    started: float | None = None,
) -> ClaimCheckResult:
    began = started if started is not None else time.monotonic()
    language = payload.language.strip().lower()
    indexes = [claim.index for claim in payload.claims]

    def finish(verdicts: list[ClaimVerdict]) -> ClaimCheckResult:
        return ClaimCheckResult(claims=verdicts, latency_ms=max(0, int((time.monotonic() - began) * 1000)))

    vectara = (
        _usable(scorers, VECTARA_SCORER) if payload.allow_vectara and language in VECTARA_LANGUAGES else None
    )
    local = _usable(scorers, LOCAL_SCORER) if language in LOCAL_LANGUAGES else None

    if vectara is None and local is None:
        reason = "error" if language in LOCAL_LANGUAGES else "unsupported_language"
        return finish(
            [ClaimVerdict(index=index, status="not_checked", scorer="none", reason=reason) for index in indexes]
        )

    texts = {premise.ref: premise.text for premise in payload.premises}
    pairs: dict[int, ScorePair] = {
        claim.index: (build_premise(claim.premise_refs, texts, settings.claim_premise_max_chars), claim.hypothesis)
        for claim in payload.claims
    }
    tally = _Tally()

    async def run_all() -> None:
        if vectara is not None:
            fallback: list[int] | None = [] if local is not None else None
            await _run_leg(vectara, VECTARA_SCORER, indexes, pairs, tally, retry_elsewhere=fallback)
            if local is not None and fallback:
                await _run_leg(local, LOCAL_SCORER, fallback, pairs, tally, retry_elsewhere=None)
        elif local is not None:
            await _run_leg(local, LOCAL_SCORER, indexes, pairs, tally, retry_elsewhere=None)

    remaining_s = settings.claims_deadline_ms / 1000 - (time.monotonic() - began)
    try:
        await asyncio.wait_for(run_all(), timeout=max(0.0, remaining_s))
    except TimeoutError:
        pass

    verdicts: list[ClaimVerdict] = []
    for index in indexes:
        if index in tally.scored:
            name, score = tally.scored[index]
            verdicts.append(ClaimVerdict(index=index, status="scored", scorer=name, score=score))  # type: ignore[arg-type]
        elif index in tally.failed:
            verdicts.append(ClaimVerdict(index=index, status="not_checked", scorer="none", reason="error"))
        else:
            verdicts.append(ClaimVerdict(index=index, status="not_checked", scorer="none", reason="timeout"))
    return finish(verdicts)


def build_claims_router(settings: SidecarSettings, scorers: Mapping[str, Scorer]) -> APIRouter:
    router = APIRouter()

    @router.post("/groundedness/claims", response_model=ClaimCheckResult)
    async def groundedness_claims(request: Request) -> JSONResponse:
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
            payload = ClaimCheckRequest.model_validate_json(bytes(body))
        except (ValidationError, ValueError):
            return _error(422, "invalid_claims_request")

        result = await route_claims(payload, settings, scorers, started=started)
        statuses = Counter(claim.status for claim in result.claims)
        reasons = Counter(claim.reason for claim in result.claims if claim.reason is not None)
        logger.info(
            "[Groundedness] claims checked",
            extra={
                "request_id": payload.request_id,
                "counts": {"scored": statuses.get("scored", 0), "not_checked": statuses.get("not_checked", 0)},
                "reasons": dict(sorted(reasons.items())),
                "scorers": sorted({claim.scorer for claim in result.claims if claim.scorer != "none"}),
                "latency_ms": result.latency_ms,
            },
        )
        return JSONResponse(content=result.model_dump(mode="json"))

    return router
