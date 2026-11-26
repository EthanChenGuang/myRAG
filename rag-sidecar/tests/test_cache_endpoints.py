import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.cache import CacheBackendUnavailable, RefusalNotCached
from rag_sidecar.contracts import (
    CacheCheckResponse,
    CachedAnswer,
    CacheInvalidateResponse,
    SidecarError,
)
from rag_sidecar.main import create_app
from rag_sidecar.settings import REDIS_URL_ENV_VAR, SidecarSettings, load_settings

SECRET = "k" * 48
HEADER = "x-sidecar-secret"
PATHS = ("/v1/cache/check", "/v1/cache/store", "/v1/cache/invalidate")
TENANT = "o:0f0e0d0c-0b0a-4908-8706-050403020100"
KEY_HASH = "ab" * 32
PLACEHOLDER_URL = "redis://placeholder-user:placeholder-pass@cache.invalid:6379/0"
ENV_EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"

ANSWER = {
    "answer_text": "Placeholder answer.",
    "citations": [],
    "sources": [],
    "source_versions": [{"document_id": "doc-1", "version": 1}],
    "answer_language": "en",
    "rag_mode": "strict",
    "is_refusal": False,
    "groundedness": {"status": "not_checked", "label": "not_checked", "reason": "scorer_unavailable"},
    "trace_id": "trace-1",
    "created_at": "2026-11-25T00:00:00Z",
}


def _bodies(answer=None):
    common = {"tenant_key": TENANT, "key_hash": KEY_HASH, "embedding_profile_id": "p1", "vector": [0.1, 0.2]}
    return {
        "/v1/cache/check": {**common, "max_distance": 0.1},
        "/v1/cache/store": {
            **common,
            "query_text_masked": "placeholder masked question",
            "answer": answer or ANSWER,
            "ttl_seconds": 60,
        },
        "/v1/cache/invalidate": {"tenant_key": TENANT, "document_ids": None},
    }


class FakeService:
    def __init__(self):
        self.calls: list[tuple[str, object]] = []

    def check(self, request):
        self.calls.append(("check", request))
        return CacheCheckResponse(
            hit=True, entry_id="e1", distance=0.01, answer=CachedAnswer.model_validate(ANSWER)
        )

    def store(self, request):
        self.calls.append(("store", request))
        if request.answer.is_refusal:
            raise RefusalNotCached("refusal_not_cached")

    def invalidate(self, request):
        self.calls.append(("invalidate", request))
        return CacheInvalidateResponse(deleted=3)


def _client(redis_url=None, service=None):
    settings = SidecarSettings(secret=SecretStr(SECRET), redis_url=SecretStr(redis_url) if redis_url else None)
    return TestClient(create_app(settings, cache_service=service))


@pytest.mark.parametrize("path", PATHS)
def test_every_cache_path_needs_the_shared_secret(path):
    response = _client(service=FakeService()).post(path, json=_bodies()[path])
    assert response.status_code == 401
    assert SidecarError.model_validate(response.json()).error == "unauthorized"


@pytest.mark.parametrize("path", PATHS)
def test_without_redis_url_every_path_is_503(path):
    response = _client().post(path, json=_bodies()[path], headers={HEADER: SECRET})
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "semantic_cache_not_configured"


@pytest.mark.parametrize("path", PATHS)
def test_without_the_cache_extra_every_path_is_503(path, monkeypatch):
    def missing(_url):
        raise CacheBackendUnavailable("semantic_cache_extra_missing")

    monkeypatch.setattr("rag_sidecar.cache.router.CacheService", missing)
    response = _client(redis_url=PLACEHOLDER_URL).post(path, json=_bodies()[path], headers={HEADER: SECRET})
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "semantic_cache_unavailable"


def test_check_store_and_invalidate_with_a_fake_service():
    service = FakeService()
    client = _client(redis_url=PLACEHOLDER_URL, service=service)
    bodies = _bodies()
    check = client.post("/v1/cache/check", json=bodies["/v1/cache/check"], headers={HEADER: SECRET})
    assert check.status_code == 200
    assert CacheCheckResponse.model_validate(check.json()).hit is True
    store = client.post("/v1/cache/store", json=bodies["/v1/cache/store"], headers={HEADER: SECRET})
    assert store.status_code == 204
    invalidate = client.post("/v1/cache/invalidate", json=bodies["/v1/cache/invalidate"], headers={HEADER: SECRET})
    assert invalidate.status_code == 200
    assert CacheInvalidateResponse.model_validate(invalidate.json()).deleted == 3
    assert [name for name, _ in service.calls] == ["check", "store", "invalidate"]


@pytest.mark.parametrize("path", PATHS)
def test_a_malformed_tenant_key_is_422_and_reaches_no_service(path):
    service = FakeService()
    body = {**_bodies()[path], "tenant_key": "o:not-a-uuid"}
    response = _client(redis_url=PLACEHOLDER_URL, service=service).post(path, json=body, headers={HEADER: SECRET})
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_cache_request"
    assert service.calls == []


def test_store_of_a_refusal_is_422_and_stores_nothing():
    service = FakeService()
    refusal = {**ANSWER, "is_refusal": True}
    body = _bodies(answer=refusal)["/v1/cache/store"]
    response = _client(redis_url=PLACEHOLDER_URL, service=service).post(
        "/v1/cache/store", json=body, headers={HEADER: SECRET}
    )
    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "refusal_not_cached"


def test_a_backend_failure_is_503_and_the_url_is_not_logged(caplog):
    class Broken(FakeService):
        def check(self, request):
            raise ConnectionError(f"cannot reach {PLACEHOLDER_URL}")

    caplog.set_level(logging.DEBUG)
    response = _client(redis_url=PLACEHOLDER_URL, service=Broken()).post(
        "/v1/cache/check", json=_bodies()["/v1/cache/check"], headers={HEADER: SECRET}
    )
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "semantic_cache_backend_error"
    assert PLACEHOLDER_URL not in response.text
    assert "placeholder-pass" not in caplog.text


def test_settings_read_redis_url_as_a_secret_and_never_print_it(monkeypatch, caplog):
    monkeypatch.setenv(REDIS_URL_ENV_VAR, PLACEHOLDER_URL)
    caplog.set_level(logging.DEBUG)
    settings = load_settings()
    assert isinstance(settings.redis_url, SecretStr)
    assert settings.redis_url.get_secret_value() == PLACEHOLDER_URL
    assert "placeholder-pass" not in repr(settings)
    assert "placeholder-pass" not in str(settings)
    create_app(settings)
    assert "placeholder-pass" not in caplog.text
    monkeypatch.setenv(REDIS_URL_ENV_VAR, "  ")
    assert load_settings().redis_url is None


def test_env_example_lists_an_empty_redis_url_with_one_comment_naming_the_cache_extra():
    lines = ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
    matches = [index for index, line in enumerate(lines) if line.startswith("REDIS_URL=")]
    assert len(matches) == 1
    assert lines[matches[0]] == "REDIS_URL="
    comment = lines[matches[0] - 1]
    assert comment.startswith("#") and "cache" in comment
