from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from rag_sidecar.settings import SidecarSettings

VECTARA_SCORER = "hhem_2_3_vectara"
LOCAL_SCORER = "hhem_2_1_open"


class ScorerUnavailable(Exception):
    def __init__(self, reason: str = "scorer_unavailable") -> None:
        super().__init__(reason)
        self.reason = reason


class ScorerBusy(Exception):
    pass


@runtime_checkable
class Scorer(Protocol):
    name: str

    def available(self) -> bool: ...

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float: ...


class StubScorer:
    def __init__(
        self,
        name: str,
        *,
        score: float = 0.5,
        available: bool = True,
        error: Exception | None = None,
        on_call: Callable[[Sequence[str], str], None] | None = None,
    ) -> None:
        self.name = name
        self._score = score
        self._available = available
        self._error = error
        self._on_call = on_call
        self.calls = 0

    def available(self) -> bool:
        return self._available

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        self.calls += 1
        if self._on_call is not None:
            self._on_call(premise_texts, hypothesis)
        if self._error is not None:
            raise self._error
        return self._score


def available_scorer_names(scorers: Mapping[str, Scorer]) -> list[str]:
    return [name for name in (VECTARA_SCORER, LOCAL_SCORER) if name in scorers and scorers[name].available()]


def build_scorers(settings: "SidecarSettings") -> dict[str, Scorer]:
    scorers: dict[str, Scorer] = {}
    return scorers


async def close_scorers(scorers: Mapping[str, Scorer]) -> None:
    for scorer in scorers.values():
        closer = getattr(scorer, "aclose", None)
        if closer is not None:
            await closer()
