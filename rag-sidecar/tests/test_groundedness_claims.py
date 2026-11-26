import asyncio
import importlib
import json
import threading
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import ClaimCheckRequest, ClaimCheckResult, SidecarError
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


# Task 2: the claims router with routing, premises and deadline (D-22, D-94).

def _claims_module():
    try:
        return importlib.import_module("rag_sidecar.groundedness.claims")
    except ModuleNotFoundError:
        pytest.fail("rag_sidecar.groundedness.claims is missing")


def _claims_settings(**overrides) -> SidecarSettings:
    values = {"secret": SecretStr("c" * 48)}
    values.update(overrides)
    return SidecarSettings(**values)


def _claims_body(language: str = "en", allow_vectara: bool = False, count: int = 3, **overrides) -> dict:
    body = {
        "request_id": "req-claims-1",
        "language": language,
        "premises": [
            {"ref": "S1", "text": "Alpha holds value one."},
            {"ref": "S2", "text": "Beta holds value two."},
            {"ref": "S3", "text": "Gamma holds value three."},
        ],
        "claims": [
            {"index": i, "hypothesis": f"Claim number {i}.", "premise_refs": ["S2", "S1"] if i == 0 else ["S3"]}
            for i in range(count)
        ],
        "allow_vectara": allow_vectara,
    }
    body.update(overrides)
    return body


def _route(payload: dict, scorers, settings: SidecarSettings | None = None) -> ClaimCheckResult:
    module = _claims_module()
    request = ClaimCheckRequest.model_validate(payload)
    return asyncio.run(module.route_claims(request, settings or _claims_settings(), scorers))


def _claim_stubs(**kwargs) -> dict[str, StubScorer]:
    return {
        VECTARA_SCORER: kwargs.get("vectara") or StubScorer(VECTARA_SCORER, score=0.83),
        LOCAL_SCORER: kwargs.get("local") or StubScorer(LOCAL_SCORER, score=0.61),
    }


def _by_index(result: ClaimCheckResult) -> dict:
    return {claim.index: claim for claim in result.claims}


def test_en_claims_without_vectara_go_to_the_local_scorer():
    scorers = _claim_stubs()
    result = _route(_claims_body("en", False), scorers)
    assert [(c.index, c.status, c.scorer) for c in result.claims] == [
        (0, "scored", "hhem_2_1_open"),
        (1, "scored", "hhem_2_1_open"),
        (2, "scored", "hhem_2_1_open"),
    ]
    assert all(c.score == pytest.approx(0.61) for c in result.claims)
    assert scorers[VECTARA_SCORER].batch_sizes == []
    assert scorers[LOCAL_SCORER].batch_sizes == [3]


def test_zh_hans_claims_with_vectara_allowed_go_to_vectara():
    scorers = _claim_stubs()
    result = _route(_claims_body("zh-Hans", True), scorers)
    assert {c.scorer for c in result.claims} == {"hhem_2_3_vectara"}
    assert scorers[LOCAL_SCORER].batch_sizes == []


def test_en_claims_with_vectara_allowed_go_to_vectara():
    scorers = _claim_stubs()
    result = _route(_claims_body("en", True), scorers)
    assert {c.scorer for c in result.claims} == {"hhem_2_3_vectara"}
    assert scorers[LOCAL_SCORER].batch_sizes == []


@pytest.mark.parametrize("language,allow", [("it", True), ("it", False), ("zh-hans", False), ("de", True)])
def test_languages_without_a_scorer_are_unsupported_language(language, allow):
    scorers = _claim_stubs()
    result = _route(_claims_body(language, allow), scorers)
    assert {(c.status, c.scorer, c.reason) for c in result.claims} == {("not_checked", "none", "unsupported_language")}
    assert scorers[VECTARA_SCORER].batch_sizes == []
    assert scorers[LOCAL_SCORER].batch_sizes == []


def test_zh_hans_without_a_vectara_key_is_unsupported_language():
    scorers = {LOCAL_SCORER: StubScorer(LOCAL_SCORER)}
    result = _route(_claims_body("zh-hans", True), scorers)
    assert {c.reason for c in result.claims} == {"unsupported_language"}
    assert scorers[LOCAL_SCORER].batch_sizes == []


def test_en_vectara_failures_fall_back_to_local_without_retrying_vectara():
    vectara = StubScorer(VECTARA_SCORER, score=0.83, fail_hypotheses={"Claim number 1."})
    local = StubScorer(LOCAL_SCORER, score=0.61)
    result = _by_index(_route(_claims_body("en", True), _claim_stubs(vectara=vectara, local=local)))
    assert (result[0].scorer, result[1].scorer, result[2].scorer) == (
        "hhem_2_3_vectara",
        "hhem_2_1_open",
        "hhem_2_3_vectara",
    )
    assert vectara.batch_sizes == [3]
    assert local.batch_sizes == [1]


def test_zh_hans_vectara_failure_is_error_without_local_fallback():
    vectara = StubScorer(VECTARA_SCORER, fail_hypotheses={"Claim number 0."})
    local = StubScorer(LOCAL_SCORER)
    result = _by_index(_route(_claims_body("zh-hans", True), _claim_stubs(vectara=vectara, local=local)))
    assert (result[0].status, result[0].reason) == ("not_checked", "error")
    assert result[1].status == "scored"
    assert local.batch_sizes == []


def test_local_scorer_raising_marks_every_claim_error():
    from rag_sidecar.groundedness import ScorerUnavailable

    local = StubScorer(LOCAL_SCORER, error=ScorerUnavailable("model_load_failed"))
    result = _route(_claims_body("en", False), _claim_stubs(local=local))
    assert {(c.status, c.reason) for c in result.claims} == {("not_checked", "error")}


def test_en_without_any_usable_scorer_is_error():
    result = _route(_claims_body("en", False), {LOCAL_SCORER: StubScorer(LOCAL_SCORER, available=False)})
    assert {(c.status, c.reason) for c in result.claims} == {("not_checked", "error")}


def test_premise_is_built_from_premise_refs_in_order():
    seen: dict[str, list[str]] = {}
    local = StubScorer(LOCAL_SCORER, on_call=lambda premises, hypothesis: seen.update({hypothesis: list(premises)}))
    _route(_claims_body("en", False, count=2), _claim_stubs(local=local))
    assert seen["Claim number 0."] == ["Beta holds value two.", "Alpha holds value one."]
    assert seen["Claim number 1."] == ["Gamma holds value three."]


def test_premise_is_cut_to_the_per_claim_cap():
    seen: dict[str, list[str]] = {}
    local = StubScorer(LOCAL_SCORER, on_call=lambda premises, hypothesis: seen.update({hypothesis: list(premises)}))
    body = _claims_body("en", False, count=1)
    body["premises"] = [{"ref": "S1", "text": "a" * 700}, {"ref": "S2", "text": "b" * 700}, {"ref": "S3", "text": "c"}]
    body["claims"][0]["premise_refs"] = ["S1", "S2", "S3"]
    _route(body, _claim_stubs(local=local), _claims_settings(claim_premise_max_chars=1000))
    premises = seen["Claim number 0."]
    assert premises[0] == "a" * 700
    assert premises[1].startswith("b")
    assert len("\n\n".join(premises)) == 1000
    assert len(premises) == 2


def test_claims_deadline_returns_partial_results_and_never_unsupported():
    local = StubScorer(
        LOCAL_SCORER,
        score=0.1,
        delay_by_hypothesis={"Claim number 2.": 5.0, "Claim number 3.": 5.0},
    )
    started = time.monotonic()
    result = _by_index(_route(_claims_body("en", False, count=4), _claim_stubs(local=local), _claims_settings(claims_deadline_ms=200)))
    elapsed = time.monotonic() - started
    assert elapsed < 2.0
    assert (result[0].status, result[0].score) == ("scored", pytest.approx(0.1))
    assert result[1].status == "scored"
    assert [(result[i].status, result[i].scorer, result[i].reason, result[i].score) for i in (2, 3)] == [
        ("not_checked", "none", "timeout", None),
        ("not_checked", "none", "timeout", None),
    ]


def test_claims_deadline_default_is_below_the_app_groundedness_timeout():
    settings = SidecarSettings()
    assert 0 < settings.claims_deadline_ms < 20_000
    assert 0 < settings.claim_premise_max_chars < 3_000 * 4


def test_result_validates_and_carries_latency():
    result = _route(_claims_body("en", False), _claim_stubs())
    ClaimCheckResult.model_validate(result.model_dump(mode="json"))
    assert result.latency_ms >= 0


def _claims_client(scorers, settings: SidecarSettings | None = None) -> TestClient:
    module = _claims_module()
    app = FastAPI()
    app.include_router(module.build_claims_router(settings or _claims_settings(), scorers))
    return TestClient(app)


def test_router_scores_a_valid_request():
    response = _claims_client(_claim_stubs()).post("/groundedness/claims", json=_claims_body("en", False))
    assert response.status_code == 200, response.text
    assert len(ClaimCheckResult.model_validate(response.json()).claims) == 3


def test_router_oversized_body_is_413():
    scorers = _claim_stubs()
    body = _claims_body("en", False)
    body["premises"] = [{"ref": f"P{i}", "text": "x" * 50_000} for i in range(30)]
    body["claims"] = [{"index": 0, "hypothesis": "Claim.", "premise_refs": ["P0"]}]
    response = _claims_client(scorers).post("/groundedness/claims", json=body)
    assert response.status_code == 413
    assert SidecarError.model_validate(response.json()).error == "groundedness_request_too_large"
    assert scorers[LOCAL_SCORER].batch_sizes == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(claims=[]),
        lambda b: b.update(extra_field="x"),
        lambda b: b["claims"][0].update(premise_refs=["S9"]),
        lambda b: b.pop("allow_vectara"),
        lambda b: b.update(claims=[{"index": i, "hypothesis": "h", "premise_refs": ["S1"]} for i in range(41)]),
    ],
)
def test_router_invalid_body_is_422(mutate):
    body = _claims_body("en", False)
    mutate(body)
    response = _claims_client(_claim_stubs()).post("/groundedness/claims", json=body)
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_claims_request"


def test_router_malformed_json_is_422():
    response = _claims_client(_claim_stubs()).post(
        "/groundedness/claims", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_claims_request"


def test_router_logs_counts_and_never_text(caplog):
    caplog.set_level("DEBUG")
    body = _claims_body("en", True, count=2)
    body["premises"][0]["text"] = "SECRET-PREMISE-TEXT"
    body["premises"][1]["text"] = "SECRET-PREMISE-TWO"
    body["claims"][0]["hypothesis"] = "SECRET-HYPOTHESIS-TEXT"
    vectara = StubScorer(VECTARA_SCORER, fail_hypotheses={"SECRET-HYPOTHESIS-TEXT"})
    response = _claims_client(_claim_stubs(vectara=vectara)).post("/groundedness/claims", json=body)
    assert response.status_code == 200
    joined = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "SECRET-" not in joined
    summary = [r for r in caplog.records if getattr(r, "request_id", None) == "req-claims-1" and hasattr(r, "counts")]
    assert len(summary) == 1
    record = summary[0]
    assert record.counts == {"scored": 2, "not_checked": 0}
    assert record.scorers == ["hhem_2_1_open", "hhem_2_3_vectara"]
    assert isinstance(record.latency_ms, int)
