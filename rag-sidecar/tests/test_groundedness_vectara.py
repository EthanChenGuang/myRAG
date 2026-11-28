import asyncio
import json
import logging

import httpx
import pytest
from pydantic import SecretStr

from rag_sidecar.groundedness import VECTARA_SCORER, ScorerUnavailable, build_scorers
from rag_sidecar.groundedness.vectara import VectaraScorer
from rag_sidecar.settings import SidecarSettings, load_settings

PLACEHOLDER_KEY = "vectara-placeholder-key-0000"
PREMISE = ["PREMISE-ONE the sky is blue", "PREMISE-TWO grass is green"]
HYPOTHESIS = "HYPOTHESIS-TEXT the sky is blue"


def _settings(**overrides) -> SidecarSettings:
    values = {"secret": SecretStr("s" * 48), "vectara_api_key": SecretStr(PLACEHOLDER_KEY)}
    values.update(overrides)
    return SidecarSettings(**values)


class _Recorder:
    def __init__(self, handler):
        self.requests: list[httpx.Request] = []
        self._handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


def _scorer(handler, **overrides) -> tuple[VectaraScorer, _Recorder]:
    recorder = _Recorder(handler)
    scorer = VectaraScorer(_settings(**overrides), transport=httpx.MockTransport(recorder))
    return scorer, recorder


def _score(scorer: VectaraScorer) -> float:
    async def run() -> float:
        try:
            return await scorer.score(PREMISE, HYPOTHESIS)
        finally:
            await scorer.aclose()

    return asyncio.run(run())


def test_request_shape_and_score():
    scorer, recorder = _scorer(lambda request: httpx.Response(200, json={"score": 0.83}))
    assert _score(scorer) == pytest.approx(0.83)
    assert len(recorder.requests) == 1
    request = recorder.requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.vectara.io/v2/evaluate_factual_consistency"
    assert request.headers["x-api-key"] == PLACEHOLDER_KEY
    assert request.headers["content-type"].startswith("application/json")
    assert json.loads(request.content) == {
        "generated_text": HYPOTHESIS,
        "source_texts": PREMISE,
        "model_parameters": {"model_name": "hhem_v2.3"},
    }


@pytest.mark.parametrize("base", ["https://vectara.example.test", "https://vectara.example.test/"])
def test_base_url_override_with_or_without_trailing_slash(base):
    scorer, recorder = _scorer(lambda request: httpx.Response(200, json={"score": 0.2}), vectara_base_url=base)
    assert _score(scorer) == pytest.approx(0.2)
    assert str(recorder.requests[0].url) == "https://vectara.example.test/v2/evaluate_factual_consistency"


def test_timeouts_are_two_seconds_connect_and_eight_total():
    scorer, recorder = _scorer(lambda request: httpx.Response(200, json={"score": 0.5}))
    _score(scorer)
    timeout = recorder.requests[0].extensions["timeout"]
    assert timeout["connect"] == 2.0
    assert timeout["read"] == 8.0
    assert timeout["write"] == 8.0
    assert timeout["pool"] == 8.0
    assert scorer.total_timeout_s == 8.0


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500, 503])
def test_http_errors_raise_unavailable_after_one_request(status):
    scorer, recorder = _scorer(lambda request: httpx.Response(status, json={"messages": ["no"]}))
    with pytest.raises(ScorerUnavailable) as caught:
        _score(scorer)
    assert caught.value.reason == f"vectara_http_{status}"
    assert len(recorder.requests) == 1


@pytest.mark.parametrize(
    "payload",
    [{"score": "high"}, {"score": None}, {"score": 1.2}, {"score": -0.01}, {}, [], {"score": True}, {"score": "NaN"}],
)
def test_bad_scores_raise_unavailable(payload):
    scorer, recorder = _scorer(lambda request: httpx.Response(200, json=payload))
    with pytest.raises(ScorerUnavailable) as caught:
        _score(scorer)
    assert caught.value.reason == "vectara_bad_response"
    assert len(recorder.requests) == 1


def test_non_json_body_raises_unavailable():
    scorer, recorder = _scorer(lambda request: httpx.Response(200, content=b"<html>"))
    with pytest.raises(ScorerUnavailable):
        _score(scorer)
    assert len(recorder.requests) == 1


def test_timeout_raises_unavailable_after_one_request():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    scorer, recorder = _scorer(handler)
    with pytest.raises(ScorerUnavailable) as caught:
        _score(scorer)
    assert caught.value.reason == "vectara_timeout"
    assert len(recorder.requests) == 1


def test_connect_error_raises_unavailable_after_one_request():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    scorer, recorder = _scorer(handler)
    with pytest.raises(ScorerUnavailable) as caught:
        _score(scorer)
    assert caught.value.reason == "vectara_network_error"
    assert len(recorder.requests) == 1


def test_total_deadline_bounds_a_slow_response():
    async def run() -> None:
        async def handler(request):
            await asyncio.sleep(5)
            return httpx.Response(200, json={"score": 0.5})

        scorer = VectaraScorer(_settings(), transport=httpx.MockTransport(handler), total_timeout_s=0.05)
        try:
            with pytest.raises(ScorerUnavailable) as caught:
                await scorer.score(PREMISE, HYPOTHESIS)
            assert caught.value.reason == "vectara_timeout"
        finally:
            await scorer.aclose()

    asyncio.run(run())


def test_logs_never_contain_key_or_texts(caplog):
    caplog.set_level(logging.DEBUG)
    for status in (200, 500):
        scorer, _ = _scorer(lambda request, s=status: httpx.Response(s, json={"score": 0.5}))
        try:
            _score(scorer)
        except ScorerUnavailable:
            pass
    joined = "\n".join(record.getMessage() + repr(record.__dict__) for record in caplog.records)
    for secret in [PLACEHOLDER_KEY, HYPOTHESIS, *PREMISE]:
        assert secret not in joined


def test_scorer_without_key_is_unavailable():
    scorer = VectaraScorer(SidecarSettings(), transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert scorer.available() is False


def test_scorer_with_key_is_available():
    scorer = VectaraScorer(_settings(), transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert scorer.name == VECTARA_SCORER
    assert scorer.available() is True


def test_build_scorers_includes_vectara_only_with_key():
    assert VECTARA_SCORER in build_scorers(_settings())
    assert VECTARA_SCORER not in build_scorers(SidecarSettings())
    assert VECTARA_SCORER not in build_scorers(_settings(vectara_api_key=SecretStr("")))


def test_load_settings_reads_vectara_variables(monkeypatch):
    monkeypatch.setenv("VECTARA_API_KEY", PLACEHOLDER_KEY)
    monkeypatch.setenv("VECTARA_BASE_URL", "https://vectara.example.test/")
    monkeypatch.setenv("HHEM_MODEL_REVISION", "0123456789abcdef0123456789abcdef01234567")
    settings = load_settings()
    assert settings.vectara_api_key is not None
    assert settings.vectara_api_key.get_secret_value() == PLACEHOLDER_KEY
    assert settings.vectara_configured is True
    assert settings.vectara_base_url == "https://vectara.example.test"
    assert settings.hhem_model_revision == "0123456789abcdef0123456789abcdef01234567"
    assert PLACEHOLDER_KEY not in repr(settings)


def test_load_settings_defaults(monkeypatch):
    for name in ("VECTARA_API_KEY", "VECTARA_BASE_URL", "HHEM_MODEL_REVISION"):
        monkeypatch.delenv(name, raising=False)
    settings = load_settings()
    assert settings.vectara_api_key is None
    assert settings.vectara_configured is False
    assert settings.vectara_base_url == "https://api.vectara.io"
    assert settings.hhem_model_revision == "de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8"


def test_empty_vectara_key_means_unset(monkeypatch):
    monkeypatch.setenv("VECTARA_API_KEY", "   ")
    monkeypatch.delenv("VECTARA_BASE_URL", raising=False)
    settings = load_settings()
    assert settings.vectara_api_key is None
    assert settings.vectara_configured is False


def test_blank_base_url_and_revision_fall_back_to_defaults(monkeypatch):
    monkeypatch.setenv("VECTARA_BASE_URL", "  ")
    monkeypatch.setenv("HHEM_MODEL_REVISION", "")
    settings = load_settings()
    assert settings.vectara_base_url == "https://api.vectara.io"
    assert settings.hhem_model_revision == "de9a5e6ba9ba49531a022dba17e35ffeb2a6fad8"
