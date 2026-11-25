from collections.abc import Sequence

from rag_sidecar.groundedness.scorer import LOCAL_SCORER
from rag_sidecar.settings import SidecarSettings

HHEM_MODEL_ID = "vectara/hallucination_evaluation_model"


def _packages_installed() -> bool:
    return True


class LocalHhemScorer:
    name = LOCAL_SCORER

    def __init__(self, settings: SidecarSettings, loader=None, queue_wait_s: float = 2.0) -> None:
        self._settings = settings

    def available(self) -> bool:
        return True

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        return 0.0
