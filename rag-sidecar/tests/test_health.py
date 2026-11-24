import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import SidecarError, SidecarHealth, SidecarReady
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings, load_settings

SECRET_48 = "s" * 48
SECRET_31 = "s" * 31


def _client(secret: str | None) -> TestClient:
    settings = SidecarSettings(secret=SecretStr(secret) if secret is not None else None)
    return TestClient(create_app(settings))


def test_health_is_200_without_secret_configured():
    response = _client(None).get("/health")
    assert response.status_code == 200
    assert SidecarHealth.model_validate(response.json()).status == "ok"


def test_health_is_200_with_secret_configured_and_no_header():
    response = _client(SECRET_48).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_is_503_when_secret_unset():
    response = _client(None).get("/ready")
    assert response.status_code == 503
    assert SidecarReady.model_validate(response.json()).status == "not_ready"


def test_ready_is_503_when_secret_is_31_characters():
    response = _client(SECRET_31).get("/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"


def test_ready_is_200_when_secret_is_48_characters():
    response = _client(SECRET_48).get("/ready")
    assert response.status_code == 200
    assert SidecarReady.model_validate(response.json()).status == "ready"


@pytest.mark.parametrize("path", ["/v1/info", "/v1/unknown", "/docs", "/openapi.json"])
def test_unconfigured_secret_refuses_every_non_probe_path_even_with_header(path):
    response = _client(None).get(path, headers={"x-sidecar-secret": SECRET_48})
    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "sidecar secret not configured"


def test_short_secret_is_treated_as_unconfigured():
    response = _client(SECRET_31).get("/v1/info", headers={"x-sidecar-secret": SECRET_31})
    assert response.status_code == 503


def test_load_settings_reads_environment_once(monkeypatch):
    monkeypatch.setenv("RAG_SIDECAR_SECRET", SECRET_48)
    settings = load_settings()
    assert settings.secret_configured is True
    assert settings.min_secret_length == 32
    assert settings.version

    monkeypatch.delenv("RAG_SIDECAR_SECRET")
    assert load_settings().secret_configured is False


def test_load_settings_treats_empty_secret_as_unset(monkeypatch):
    monkeypatch.setenv("RAG_SIDECAR_SECRET", "")
    assert load_settings().secret is None


def test_ready_is_503_when_ingest_worker_on_without_supabase_env():
    settings = SidecarSettings(secret=SecretStr(SECRET_48), ingest_worker=True)
    response = TestClient(create_app(settings)).get("/ready")
    assert response.status_code == 503
    assert SidecarReady.model_validate(response.json()).reason == "worker_env_missing"


def test_default_settings_do_not_start_ingest_worker():
    client = TestClient(create_app(SidecarSettings(secret=SecretStr(SECRET_48))))
    assert getattr(client.app.state, "ingest_worker", None) is None
    assert client.get("/ready").status_code == 200
