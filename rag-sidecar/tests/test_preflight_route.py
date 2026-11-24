"""POST /v1/preflight route (plan 03.1-37)."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts.routing import PreflightResult
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

REPO_ROOT = Path(__file__).resolve().parents[2]
MIXED_PDF = REPO_ROOT / "eval/fixtures/parse/pdf/mixed-routing.pdf"
ENC_PDF = Path(__file__).parent / "fixtures/preflight/user-password.pdf"
SECRET = "p" * 48
HEADER = "x-sidecar-secret"


def multipart_body(file_payload: bytes) -> bytes:
    return (
        b"--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.pdf\"\r\n"
        b"Content-Type: application/pdf\r\n\r\n" + file_payload + b"\r\n--BOUNDARY--\r\n"
    )


@pytest.fixture
def client():
    recorded = REPO_ROOT / "eval/fixtures/parse/recorded"
    settings = SidecarSettings(
        secret=SecretStr(SECRET),
        sidecar_env="test",
        ingest_converter="recorded",
        ingest_recorded_dir=str(recorded),
        max_upload_mb=1,
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_preflight_without_secret_is_401(client):
    response = client.post("/v1/preflight", data=multipart_body(MIXED_PDF.read_bytes()))
    assert response.status_code == 401


def test_preflight_mixed_fixture_returns_preflight_result_without_text(client):
    response = client.post(
        "/v1/preflight",
        content=multipart_body(MIXED_PDF.read_bytes()),
        headers={HEADER: SECRET, "content-type": "multipart/form-data; boundary=BOUNDARY"},
    )
    assert response.status_code == 200
    result = PreflightResult.model_validate(response.json())
    assert result.page_count == 10
    from rag_sidecar.contracts.routing import PageSignals

    assert "text" not in PageSignals.model_fields


def test_preflight_rejects_non_pdf(client):
    response = client.post(
        "/v1/preflight",
        content=multipart_body(b"plain-text"),
        headers={HEADER: SECRET, "content-type": "multipart/form-data; boundary=BOUNDARY"},
    )
    assert response.status_code == 415


def test_preflight_rejects_oversized_upload(client):
    huge = b"%PDF-" + (b"0" * (2 * 1024 * 1024))
    response = client.post(
        "/v1/preflight",
        content=multipart_body(huge),
        headers={HEADER: SECRET, "content-type": "multipart/form-data; boundary=BOUNDARY"},
    )
    assert response.status_code == 413


def test_preflight_encrypted_pdf_is_422(client):
    response = client.post(
        "/v1/preflight",
        content=multipart_body(ENC_PDF.read_bytes()),
        headers={HEADER: SECRET, "content-type": "multipart/form-data; boundary=BOUNDARY"},
    )
    assert response.status_code == 422
    assert response.json()["error"] == "encrypted_pdf"


def test_slow_preflight_does_not_block_health(client, monkeypatch):
    gate = threading.Event()

    def slow_l1(*args, **kwargs):
        gate.set()
        time.sleep(0.4)
        from rag_sidecar.preflight import l1 as l1_mod

        return l1_mod.l1_signals(*args, **kwargs)

    monkeypatch.setattr("rag_sidecar.preflight.run.l1_signals", slow_l1)

    def run_probe():
        response = client.post(
            "/v1/preflight",
            content=multipart_body(MIXED_PDF.read_bytes()),
            headers={HEADER: SECRET, "content-type": "multipart/form-data; boundary=BOUNDARY"},
        )
        assert response.status_code == 200

    thread = threading.Thread(target=run_probe)
    thread.start()
    assert gate.wait(timeout=5)
    for _ in range(20):
        health = client.get("/health")
        assert health.status_code == 200
        if not thread.is_alive():
            break
        time.sleep(0.05)
    thread.join(timeout=5)
    assert not thread.is_alive()