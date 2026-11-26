import asyncio
import threading

import httpx
import pytest
from pydantic import SecretStr

from rag_sidecar.groundedness import LOCAL_SCORER, VECTARA_SCORER, StubScorer
from rag_sidecar.groundedness.local_hhem import LocalHhemScorer
from rag_sidecar.groundedness.vectara import VectaraScorer
from rag_sidecar.settings import SidecarSettings

PLACEHOLDER_KEY = "vectara-placeholder-key-0000"


def _pairs(count: int) -> list[tuple[list[str], str]]:
    return [([f"Premise number {i}."], f"Claim number {i}.") for i in range(count)]


# Task 1: score_many on the protocol and both scorers (D-94).


def test_stub_score_many_returns_one_score_per_pair_in_order():
    scorer = StubScorer(LOCAL_SCORER, score_by_hypothesis={"Claim number 1.": 0.2, "Claim number 2.": 0.9})
    seen: list[tuple[int, float | None]] = []

    scores = asyncio.run(scorer.score_many(_pairs(3), on_result=lambda i, s: seen.append((i, s))))

    assert scores == [pytest.approx(0.5), pytest.approx(0.2), pytest.approx(0.9)]
    assert [i for i, _ in seen] == [0, 1, 2]
    assert scorer.batch_sizes == [3]


def test_stub_score_many_reports_failed_pairs_as_none():
    scorer = StubScorer(LOCAL_SCORER, fail_hypotheses={"Claim number 0."})
    assert asyncio.run(scorer.score_many(_pairs(2))) == [None, pytest.approx(0.5)]


class _BatchModel:
    def __init__(self, value: float = 0.8):
        self.value = value
        self.batches: list[list[tuple[str, str]]] = []
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def predict(self, pairs):
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            self.batches.append(list(pairs))
            threading.Event().wait(0.01)
            return [self.value] * len(pairs)
        finally:
            with self._lock:
                self.active -= 1


def _local(model) -> LocalHhemScorer:
    return LocalHhemScorer(SidecarSettings(), loader=lambda *args, **kwargs: model)


def test_local_score_many_uses_micro_batches_of_at_most_eight():
    model = _BatchModel(0.8)
    scores = asyncio.run(_local(model).score_many(_pairs(20)))

    assert scores == [pytest.approx(0.8)] * 20
    assert [len(batch) for batch in model.batches] == [8, 8, 4]
    assert model.batches[0][0] == ("Premise number 0.", "Claim number 0.")


def test_local_score_many_joins_premises_like_score():
    model = _BatchModel(0.8)
    asyncio.run(_local(model).score_many([(["Part A.", "Part B."], "Claim.")]))
    assert model.batches == [[("Part A.\n\nPart B.", "Claim.")]]


def test_local_score_many_is_serialized_by_the_semaphore():
    model = _BatchModel(0.8)
    scorer = _local(model)

    async def run():
        return await asyncio.gather(scorer.score_many(_pairs(16)), scorer.score_many(_pairs(16)), scorer.score(["p"], "h"))

    asyncio.run(run())
    assert model.max_active == 1
    assert len(model.batches) == 5


def test_local_score_many_failed_batch_is_none_for_that_batch_only():
    class FlakyModel(_BatchModel):
        def predict(self, pairs):
            self.batches.append(list(pairs))
            if len(self.batches) == 2:
                raise RuntimeError("inference failed")
            return [0.7] * len(pairs)

    scores = asyncio.run(_local(FlakyModel()).score_many(_pairs(12)))
    assert scores[:8] == [pytest.approx(0.7)] * 8
    assert scores[8:] == [None] * 4


def test_local_score_many_out_of_range_score_is_none():
    class OddModel(_BatchModel):
        def predict(self, pairs):
            return [0.4, 1.7, float("nan")][: len(pairs)]

    assert asyncio.run(_local(OddModel()).score_many(_pairs(3))) == [pytest.approx(0.4), None, None]


def test_local_score_unchanged_after_score_many():
    model = _BatchModel(0.66)
    assert asyncio.run(_local(model).score(["p1", "p2"], "h")) == pytest.approx(0.66)
    assert model.batches == [[("p1\n\np2", "h")]]


def _vectara(handler) -> VectaraScorer:
    settings = SidecarSettings(secret=SecretStr("s" * 48), vectara_api_key=SecretStr(PLACEHOLDER_KEY))
    return VectaraScorer(settings, transport=httpx.MockTransport(handler))


def test_vectara_score_many_runs_at_most_four_requests_at_a_time():
    state = {"active": 0, "max": 0, "requests": 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        state["active"] += 1
        state["requests"] += 1
        state["max"] = max(state["max"], state["active"])
        await asyncio.sleep(0.02)
        state["active"] -= 1
        return httpx.Response(200, json={"score": 0.75})

    scorer = _vectara(handler)

    async def run():
        try:
            return await scorer.score_many(_pairs(10))
        finally:
            await scorer.aclose()

    assert asyncio.run(run()) == [pytest.approx(0.75)] * 10
    assert state["max"] == 4
    assert state["requests"] == 10


def test_vectara_score_many_failed_request_is_none_without_retry():
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        import json

        hypothesis = json.loads(request.content)["generated_text"]
        requests.append(hypothesis)
        if hypothesis == "Claim number 1.":
            return httpx.Response(500, json={})
        return httpx.Response(200, json={"score": 0.4})

    scorer = _vectara(handler)

    async def run():
        try:
            return await scorer.score_many(_pairs(3))
        finally:
            await scorer.aclose()

    assert asyncio.run(run()) == [pytest.approx(0.4), None, pytest.approx(0.4)]
    assert sorted(requests) == ["Claim number 0.", "Claim number 1.", "Claim number 2."]


def test_both_scorer_names_are_unchanged():
    assert (VECTARA_SCORER, LOCAL_SCORER) == ("hhem_2_3_vectara", "hhem_2_1_open")
