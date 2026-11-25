from collections.abc import Sequence

import httpx

from rag_sidecar.groundedness.scorer import VECTARA_SCORER
from rag_sidecar.settings import SidecarSettings


class VectaraScorer:
    name = VECTARA_SCORER

    def __init__(
        self,
        settings: SidecarSettings,
        transport: httpx.AsyncBaseTransport | None = None,
        total_timeout_s: float = 8.0,
    ) -> None:
        self.total_timeout_s = total_timeout_s

    def available(self) -> bool:
        return False

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        return 0.0

    async def aclose(self) -> None:
        return None
