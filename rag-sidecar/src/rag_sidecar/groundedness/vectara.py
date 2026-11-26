import asyncio
import logging
import math
from collections.abc import Sequence

import httpx

from rag_sidecar.groundedness.scorer import VECTARA_SCORER, ResultCallback, ScorePair, ScorerUnavailable
from rag_sidecar.settings import SidecarSettings

logger = logging.getLogger("rag_sidecar.groundedness.vectara")

VECTARA_MODEL_NAME = "hhem_v2.3"
EVALUATE_PATH = "/v2/evaluate_factual_consistency"
CONNECT_TIMEOUT_S = 2.0
TOTAL_TIMEOUT_S = 8.0
MAX_CONCURRENT_REQUESTS = 4


class VectaraScorer:
    name = VECTARA_SCORER

    def __init__(
        self,
        settings: SidecarSettings,
        transport: httpx.AsyncBaseTransport | None = None,
        total_timeout_s: float = TOTAL_TIMEOUT_S,
    ) -> None:
        self._key = settings.vectara_api_key if settings.vectara_configured else None
        self._url = settings.vectara_base_url.rstrip("/") + EVALUATE_PATH
        self._transport = transport
        self.total_timeout_s = total_timeout_s
        self._client: httpx.AsyncClient | None = None

    def available(self) -> bool:
        return self._key is not None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=self._transport,
                timeout=httpx.Timeout(TOTAL_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
                follow_redirects=False,
                trust_env=self._transport is None,
            )
        return self._client

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        if self._key is None:
            raise ScorerUnavailable("vectara_not_configured")
        body = {
            "generated_text": hypothesis,
            "source_texts": list(premise_texts),
            "model_parameters": {"model_name": VECTARA_MODEL_NAME},
        }
        headers = {"x-api-key": self._key.get_secret_value(), "accept": "application/json"}
        try:
            response = await asyncio.wait_for(
                self._http().post(self._url, json=body, headers=headers), timeout=self.total_timeout_s
            )
        except (TimeoutError, httpx.TimeoutException):
            logger.warning("[Groundedness] vectara timeout")
            raise ScorerUnavailable("vectara_timeout") from None
        except httpx.HTTPError:
            logger.warning("[Groundedness] vectara network error")
            raise ScorerUnavailable("vectara_network_error") from None
        if response.status_code != 200:
            logger.warning("[Groundedness] vectara http error", extra={"status_code": response.status_code})
            raise ScorerUnavailable(f"vectara_http_{response.status_code}")
        try:
            payload = response.json()
        except ValueError:
            raise ScorerUnavailable("vectara_bad_response") from None
        raw = payload.get("score") if isinstance(payload, dict) else None
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ScorerUnavailable("vectara_bad_response")
        score = float(raw)
        if math.isnan(score) or score < 0.0 or score > 1.0:
            raise ScorerUnavailable("vectara_bad_response")
        return score

    async def score_many(
        self, pairs: Sequence[ScorePair], *, on_result: ResultCallback | None = None
    ) -> list[float | None]:
        if self._key is None:
            raise ScorerUnavailable("vectara_not_configured")
        gate = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
        results: list[float | None] = [None] * len(pairs)

        async def one(position: int, premise_texts: Sequence[str], hypothesis: str) -> None:
            async with gate:
                try:
                    value: float | None = await self.score(premise_texts, hypothesis)
                except ScorerUnavailable:
                    value = None
                except Exception:
                    logger.warning("[Groundedness] vectara unexpected error")
                    value = None
            results[position] = value
            if on_result is not None:
                on_result(position, value)

        await asyncio.gather(*(one(i, premises, hypothesis) for i, (premises, hypothesis) in enumerate(pairs)))
        return results

    async def aclose(self) -> None:
        if self._client is not None:
            client, self._client = self._client, None
            await client.aclose()
