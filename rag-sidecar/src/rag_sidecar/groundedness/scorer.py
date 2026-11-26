import asyncio
import math
from collections.abc import Callable, Collection, Mapping, Sequence
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from rag_sidecar.settings import SidecarSettings

VECTARA_SCORER = "hhem_2_3_vectara"
LOCAL_SCORER = "hhem_2_1_open"

ScorePair = tuple[Sequence[str], str]
ResultCallback = Callable[[int, "float | None"], None]


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

    async def score_many(
        self, pairs: Sequence[ScorePair], *, on_result: ResultCallback | None = None
    ) -> list[float | None]: ...


def usable_score(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        score = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if math.isnan(score) or score < 0.0 or score > 1.0:
        return None
    return score


class StubScorer:
    def __init__(
        self,
        name: str,
        *,
        score: float = 0.5,
        available: bool = True,
        error: Exception | None = None,
        on_call: Callable[[Sequence[str], str], None] | None = None,
        score_by_hypothesis: Mapping[str, float] | None = None,
        fail_hypotheses: Collection[str] = (),
        delay_by_hypothesis: Mapping[str, float] | None = None,
    ) -> None:
        self.name = name
        self._score = score
        self._available = available
        self._error = error
        self._on_call = on_call
        self._score_by_hypothesis = dict(score_by_hypothesis or {})
        self._fail_hypotheses = frozenset(fail_hypotheses)
        self._delay_by_hypothesis = dict(delay_by_hypothesis or {})
        self.calls = 0
        self.batch_sizes: list[int] = []

    def available(self) -> bool:
        return self._available

    async def score(self, premise_texts: Sequence[str], hypothesis: str) -> float:
        self.calls += 1
        if self._on_call is not None:
            self._on_call(premise_texts, hypothesis)
        if self._error is not None:
            raise self._error
        return self._score

    async def score_many(
        self, pairs: Sequence[ScorePair], *, on_result: ResultCallback | None = None
    ) -> list[float | None]:
        self.batch_sizes.append(len(pairs))
        if self._error is not None:
            raise self._error
        results: list[float | None] = []
        for position, (premise_texts, hypothesis) in enumerate(pairs):
            if self._on_call is not None:
                self._on_call(premise_texts, hypothesis)
            delay = self._delay_by_hypothesis.get(hypothesis, 0.0)
            if delay > 0:
                await asyncio.sleep(delay)
            value: float | None
            if hypothesis in self._fail_hypotheses:
                value = None
            else:
                value = self._score_by_hypothesis.get(hypothesis, self._score)
            results.append(value)
            if on_result is not None:
                on_result(position, value)
        return results


def available_scorer_names(scorers: Mapping[str, Scorer]) -> list[str]:
    return [name for name in (VECTARA_SCORER, LOCAL_SCORER) if name in scorers and scorers[name].available()]


def build_scorers(settings: "SidecarSettings") -> dict[str, Scorer]:
    scorers: dict[str, Scorer] = {}
    if settings.vectara_configured:
        from rag_sidecar.groundedness.vectara import VectaraScorer

        scorers[VECTARA_SCORER] = VectaraScorer(settings)
    from rag_sidecar.groundedness.local_hhem import LocalHhemScorer

    local = LocalHhemScorer(settings)
    if local.available():
        scorers[LOCAL_SCORER] = local
    return scorers


async def close_scorers(scorers: Mapping[str, Scorer]) -> None:
    for scorer in scorers.values():
        closer = getattr(scorer, "aclose", None)
        if closer is not None:
            await closer()
