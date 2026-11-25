import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import GroundednessResult, SidecarError, SidecarReady
from rag_sidecar.groundedness import LOCAL_SCORER, VECTARA_SCORER, ScorerBusy, ScorerUnavailable, StubScorer
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "g" * 48
HEADER = {"x-sidecar-secret": SECRET}
PLACEHOLDER_KEY = "vectara-placeholder-key"


def _settings(secret: str | None = SECRET) -> SidecarSettings:
    return SidecarSettings(secret=SecretStr(secret) if secret is not None else None)


def _stubs(
    *,
    vectara: StubScorer | None = None,
    local: StubScorer | None = None,
) -> dict[str, StubScorer]:
    return {
        VECTARA_SCORER: vectara if vectara is not None else StubScorer(VECTARA_SCORER, score=0.83),
        LOCAL_SCORER: local if local is not None else StubScorer(LOCAL_SCORER, score=0.61),
    }


def _body(language: str = "en", allow_vectara: bool = True, **overrides) -> dict:
    body = {
        "request_id": "req-1",
        "language": language,
        "premise_texts": ["The sky is blue.", "Grass is green."],
        "hypothesis": "The sky is blue.",
        "allow_vectara": allow_vectara,
    }
    body.update(overrides)
    return body


def _post(scorers, body, headers=HEADER, settings=None):
    app = create_app(settings if settings is not None else _settings(), scorers=scorers)
    return TestClient(app).post("/v1/groundedness", json=body, headers=headers)


def _result(response) -> GroundednessResult:
    assert response.status_code == 200, response.text
    return GroundednessResult.model_validate(response.json())


def test_en_with_vectara_allowed_uses_vectara():
    scorers = _stubs()
    result = _result(_post(scorers, _body("en", True)))
    assert result.status == "scored"
    assert result.scorer == "hhem_2_3_vectara"
    assert result.score == pytest.approx(0.83)
    assert result.latency_ms >= 0
    assert scorers[VECTARA_SCORER].calls == 1
    assert scorers[LOCAL_SCORER].calls == 0


def test_en_without_vectara_allowed_uses_local():
    scorers = _stubs()
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert result.score == pytest.approx(0.61)
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 1


def test_en_with_vectara_allowed_but_no_key_uses_local():
    scorers = {LOCAL_SCORER: StubScorer(LOCAL_SCORER, score=0.4)}
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")


def test_zh_hans_with_vectara_allowed_uses_vectara():
    scorers = _stubs()
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_3_vectara")
    assert scorers[LOCAL_SCORER].calls == 0


def test_zh_hans_without_vectara_allowed_is_scorer_unavailable():
    scorers = _stubs()
    result = _result(_post(scorers, _body("zh-Hans", False)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_unavailable")
    assert result.score is None
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_zh_hans_without_vectara_key_is_scorer_unavailable():
    scorers = {LOCAL_SCORER: StubScorer(LOCAL_SCORER)}
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")
    assert scorers[LOCAL_SCORER].calls == 0


@pytest.mark.parametrize("language", ["it", "zh-Hant", "unknown", "de", "mixed", "zh"])
def test_unsupported_languages_never_call_a_scorer(language):
    scorers = _stubs()
    result = _result(_post(scorers, _body(language, True)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "unsupported_language")
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_vectara_failure_for_en_falls_back_to_local_without_retry():
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_http_500"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert vectara.calls == 1
    assert scorers[LOCAL_SCORER].calls == 1


def test_vectara_failure_for_zh_hans_is_not_checked_without_retry():
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_timeout"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("zh-Hans", True)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_unavailable")
    assert vectara.calls == 1
    assert scorers[LOCAL_SCORER].calls == 0


def test_vectara_unexpected_error_is_treated_as_unavailable():
    vectara = StubScorer(VECTARA_SCORER, error=RuntimeError("boom"))
    scorers = _stubs(vectara=vectara)
    result = _result(_post(scorers, _body("en", True)))
    assert (result.status, result.scorer) == ("scored", "hhem_2_1_open")
    assert vectara.calls == 1


def test_local_busy_is_scorer_busy():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, error=ScorerBusy()))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "scorer_busy")


def test_local_unavailable_for_en_is_scorer_unavailable():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, available=False))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")
    assert scorers[LOCAL_SCORER].calls == 0


def test_local_missing_for_en_is_scorer_unavailable():
    result = _result(_post({}, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


def test_local_raising_unavailable_is_scorer_unavailable():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, error=ScorerUnavailable("model_load_failed")))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


@pytest.mark.parametrize("bad", [1.5, -0.1, float("nan")])
def test_out_of_range_score_is_not_reported(bad):
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, score=bad))
    result = _result(_post(scorers, _body("en", False)))
    assert (result.status, result.reason) == ("not_checked", "scorer_unavailable")


def test_premise_over_cap_is_too_long_without_calling_a_scorer():
    scorers = _stubs()
    premise = ["a" * 30_000, "b" * 30_001]
    result = _result(_post(scorers, _body("en", True, premise_texts=premise)))
    assert (result.status, result.scorer, result.reason) == ("not_checked", "none", "too_long")
    assert scorers[VECTARA_SCORER].calls == 0
    assert scorers[LOCAL_SCORER].calls == 0


def test_premise_at_cap_is_scored():
    scorers = _stubs()
    premise = ["a" * 30_000, "b" * 30_000]
    result = _result(_post(scorers, _body("en", False, premise_texts=premise)))
    assert result.status == "scored"


def test_scorer_receives_premise_and_hypothesis():
    seen: list[tuple[list[str], str]] = []
    local = StubScorer(LOCAL_SCORER, on_call=lambda p, h: seen.append((list(p), h)))
    _result(_post(_stubs(local=local), _body("en", False)))
    assert seen == [(["The sky is blue.", "Grass is green."], "The sky is blue.")]


def test_missing_secret_header_is_401():
    scorers = _stubs()
    response = _post(scorers, _body(), headers={})
    assert response.status_code == 401
    assert SidecarError.model_validate(response.json()).error == "unauthorized"
    assert scorers[VECTARA_SCORER].calls == 0


def test_wrong_secret_header_is_401():
    response = _post(_stubs(), _body(), headers={"x-sidecar-secret": "w" * 48})
    assert response.status_code == 401


def test_unconfigured_secret_is_503():
    response = _post(_stubs(), _body(), settings=_settings(None))
    assert response.status_code == 503


def test_unknown_body_field_is_422():
    scorers = _stubs()
    response = _post(scorers, _body(extra_field="x"))
    assert response.status_code == 422
    assert scorers[VECTARA_SCORER].calls == 0


@pytest.mark.parametrize(
    "body",
    [
        {"request_id": "r", "language": "en", "premise_texts": [], "hypothesis": "h", "allow_vectara": False},
        {"request_id": "r", "language": "en", "premise_texts": ["p"], "hypothesis": "", "allow_vectara": False},
        {"request_id": "r", "language": "en", "premise_texts": ["p"], "hypothesis": "h"},
    ],
)
def test_invalid_body_is_422(body):
    response = _post(_stubs(), body)
    assert response.status_code == 422


def test_malformed_json_is_422():
    app = create_app(_settings(), scorers=_stubs())
    response = TestClient(app).post(
        "/v1/groundedness", content=b"{not json", headers={**HEADER, "content-type": "application/json"}
    )
    assert response.status_code == 422


def test_oversized_body_is_413():
    scorers = _stubs()
    body = _body(premise_texts=["x" * (2 * 1024 * 1024)])
    response = _post(scorers, body)
    assert response.status_code == 413
    assert scorers[LOCAL_SCORER].calls == 0


def test_ready_lists_available_scorers():
    scorers = _stubs(local=StubScorer(LOCAL_SCORER, available=False))
    response = TestClient(create_app(_settings(), scorers=scorers)).get("/ready")
    assert response.status_code == 200
    ready = SidecarReady.model_validate(response.json())
    assert ready.status == "ready"
    assert ready.scorers == ["hhem_2_3_vectara"]


def test_ready_lists_both_scorers():
    response = TestClient(create_app(_settings(), scorers=_stubs())).get("/ready")
    assert SidecarReady.model_validate(response.json()).scorers == ["hhem_2_3_vectara", "hhem_2_1_open"]


def test_ready_lists_no_scorers_when_none_are_configured():
    response = TestClient(create_app(_settings(), scorers={})).get("/ready")
    assert response.status_code == 200
    assert response.json()["scorers"] == []


def test_router_never_logs_request_text(caplog):
    caplog.set_level("DEBUG")
    body = _body("en", True, premise_texts=["SECRET-PREMISE-TEXT"], hypothesis="SECRET-HYPOTHESIS-TEXT")
    vectara = StubScorer(VECTARA_SCORER, error=ScorerUnavailable("vectara_http_500"))
    _result(_post(_stubs(vectara=vectara), body))
    joined = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    assert "SECRET-PREMISE-TEXT" not in joined
    assert "SECRET-HYPOTHESIS-TEXT" not in joined
