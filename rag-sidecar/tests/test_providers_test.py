import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar import providers_test
from rag_sidecar.contracts import ProviderTestResult
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET = "k" * 48
HEADER = "x-sidecar-secret"
PLACEHOLDER_KEY = "VQ7XK2ZP9LM4WR8T"
VECTARA_BASE = "https://probe-host-vectara.example.com:7443"
VECTARA_HOST = "probe-host-vectara.example.com"
ROUTE = "/v1/providers/test"
CODES = {
    "ok",
    "not_configured",
    "unauthorized",
    "timeout",
    "unreachable",
    "rate_limited",
    "provider_error",
    "bad_response",
}


class _Recorder:
    def __init__(self, handler):
        self.requests: list[httpx.Request] = []
        self._handler = handler

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


def _settings(**overrides) -> SidecarSettings:
    values = {
        "secret": SecretStr(SECRET),
        "vectara_api_key": SecretStr(PLACEHOLDER_KEY),
        "vectara_base_url": VECTARA_BASE,
    }
    values.update(overrides)
    return SidecarSettings(**values)


def _client(monkeypatch, handler, **overrides) -> tuple[TestClient, _Recorder]:
    recorder = _Recorder(handler)
    monkeypatch.setattr(
        providers_test, "default_transport", lambda: httpx.MockTransport(recorder)
    )
    return TestClient(create_app(_settings(**overrides))), recorder


def _post(client: TestClient, body, headers=None) -> httpx.Response:
    return client.post(
        ROUTE,
        content=json.dumps(body) if not isinstance(body, str) else body,
        headers={HEADER: SECRET, **(headers or {})},
    )


def _assert_no_leak(text: str) -> None:
    for needle in (
        PLACEHOLDER_KEY,
        VECTARA_BASE,
        VECTARA_HOST,
        f"{VECTARA_HOST}:7443",
        "evaluate_factual_consistency",
        "http",
    ):
        assert needle not in text
    for i in range(len(PLACEHOLDER_KEY) - 3):
        assert PLACEHOLDER_KEY[i : i + 4] not in text


def test_without_the_shared_secret_is_401(monkeypatch):
    client, recorder = _client(
        monkeypatch, lambda request: httpx.Response(200, json={"score": 0.9})
    )
    response = client.post(ROUTE, json={"provider": "vectara"})
    assert response.status_code == 401
    assert recorder.requests == []


def test_with_the_secret_unset_is_refused_like_every_route(monkeypatch):
    recorder = _Recorder(lambda request: httpx.Response(200, json={"score": 0.9}))
    monkeypatch.setattr(
        providers_test, "default_transport", lambda: httpx.MockTransport(recorder)
    )
    client = TestClient(
        create_app(SidecarSettings(vectara_api_key=SecretStr(PLACEHOLDER_KEY)))
    )
    response = client.post(
        ROUTE, json={"provider": "vectara"}, headers={HEADER: SECRET}
    )
    assert response.status_code == 503
    assert recorder.requests == []


def test_vectara_unset_key_is_not_configured_without_a_call(monkeypatch):
    client, recorder = _client(
        monkeypatch,
        lambda request: httpx.Response(200, json={"score": 0.9}),
        vectara_api_key=None,
    )
    response = _post(client, {"provider": "vectara"})
    assert response.status_code == 200
    result = ProviderTestResult.model_validate(response.json())
    assert (result.ok, result.code, result.latencyMs) == (False, "not_configured", 0)
    assert recorder.requests == []


def test_vectara_mocked_200_is_ok_with_latency(monkeypatch):
    client, recorder = _client(
        monkeypatch, lambda request: httpx.Response(200, json={"score": 0.9})
    )
    response = _post(client, {"provider": "vectara"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"provider", "ok", "latencyMs", "code", "message"}
    result = ProviderTestResult.model_validate(body)
    assert (result.provider, result.ok, result.code) == ("vectara", True, "ok")
    assert result.latencyMs >= 0
    assert len(recorder.requests) == 1
    sent = recorder.requests[0]
    assert sent.headers["x-api-key"] == PLACEHOLDER_KEY
    assert json.loads(sent.content)["source_texts"] == ["ok"]


@pytest.mark.parametrize(
    ("handler", "code"),
    [
        (
            lambda request: httpx.Response(
                401, json={"error": f"bad key {PLACEHOLDER_KEY} at {VECTARA_BASE}"}
            ),
            "unauthorized",
        ),
        (
            lambda request: httpx.Response(403, text=f"forbidden {request.url}"),
            "unauthorized",
        ),
        (lambda request: httpx.Response(429, text="slow down"), "rate_limited"),
        (
            lambda request: httpx.Response(500, text=f"boom {request.url}"),
            "provider_error",
        ),
        (
            lambda request: httpx.Response(200, text=f"<html>{request.url}</html>"),
            "bad_response",
        ),
    ],
)
def test_vendor_failures_map_to_fixed_codes_and_never_leak(monkeypatch, handler, code):
    client, _ = _client(monkeypatch, handler)
    response = _post(client, {"provider": "vectara"})
    assert response.status_code == 200
    result = ProviderTestResult.model_validate(response.json())
    assert result.code == code
    assert result.message == providers_test.MESSAGES[code]
    _assert_no_leak(response.text)


def test_network_error_embedding_the_address_is_unreachable_and_not_echoed(
    monkeypatch, caplog
):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            f"connect ECONNREFUSED {VECTARA_HOST}:7443 {request.url}", request=request
        )

    client, _ = _client(monkeypatch, refuse)
    with caplog.at_level(logging.DEBUG):
        response = _post(client, {"provider": "vectara"})
    assert response.json()["code"] == "unreachable"
    _assert_no_leak(response.text)
    own = [record for record in caplog.records if record.name.startswith("rag_sidecar")]
    assert any(record.getMessage() == "[Providers] provider test" for record in own)
    for record in own:
        _assert_no_leak(record.getMessage())
        _assert_no_leak(
            json.dumps(
                {
                    k: str(v)
                    for k, v in record.__dict__.items()
                    if k in ("provider", "ok", "code")
                }
            )
        )


def test_timeout_is_timeout(monkeypatch):
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    client, _ = _client(monkeypatch, slow)
    assert _post(client, {"provider": "vectara"}).json()["code"] == "timeout"


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "openai"},
        {"provider": "vectara", "url": "https://attacker.example.com"},
        {},
        "not json",
    ],
)
def test_unknown_provider_or_extra_field_is_422_with_no_call(monkeypatch, body):
    client, recorder = _client(
        monkeypatch, lambda request: httpx.Response(200, json={"score": 0.9})
    )
    response = _post(client, body)
    assert response.status_code == 422
    assert response.json() == {"error": "invalid_provider_test_request"}
    assert recorder.requests == []


def test_every_code_has_a_fixed_message():
    assert set(providers_test.MESSAGES) == CODES
