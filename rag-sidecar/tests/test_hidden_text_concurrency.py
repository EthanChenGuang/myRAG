"""UF-5: the hidden-text checker runs in a bounded number of threads; a timed-out check keeps its slot until its thread ends."""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

import rag_sidecar.security.router as router_module
from rag_sidecar.settings import SidecarSettings

pytest.importorskip("pypdfium2")
pytest.importorskip("pdfplumber")

REPO_ROOT = Path(__file__).resolve().parents[2]
PDF = REPO_ROOT / "eval" / "fixtures" / "security" / "pdf" / "white-on-white.pdf"
BOUNDARY = "CONCURRENCYBOUNDARY"


def _body(data: bytes) -> bytes:
    meta = {"filename": "doc.pdf", "mime_type": "application/pdf", "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
    return (
        f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n".encode()
        + json.dumps(meta).encode()
        + f"\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".encode()
        + data
        + f"\r\n--{BOUNDARY}--\r\n".encode()
    )


def _client(max_concurrent: int, timeout_s: float) -> TestClient:
    settings = SidecarSettings(
        secret=SecretStr("c" * 48),
        sidecar_env="test",
        ingest_converter="recorded",
        ingest_recorded_dir=str(REPO_ROOT / "eval/fixtures/parse/recorded"),
        max_upload_mb=1,
    )
    app = FastAPI()
    app.include_router(router_module.build_hidden_text_router(settings, timeout_s=timeout_s, max_concurrent=max_concurrent), prefix="/v1")
    return TestClient(app)


def _post(client: TestClient):
    return client.post("/v1/hidden-text", content=_body(PDF.read_bytes()), headers={"content-type": f"multipart/form-data; boundary={BOUNDARY}"})


def test_a_timed_out_check_holds_its_slot_until_the_thread_ends(monkeypatch):
    real = router_module.check_hidden_text
    release = threading.Event()
    finished = threading.Event()
    calls: list[int] = []

    def stuck(data, mime_type, rules):
        calls.append(1)
        try:
            if len(calls) == 1:
                release.wait(10)
            return real(data, mime_type, rules)
        finally:
            if len(calls) == 1:
                finished.set()

    monkeypatch.setattr(router_module, "check_hidden_text", stuck)
    with _client(max_concurrent=1, timeout_s=0.2) as client:
        first = _post(client)
        assert first.status_code == 504
        assert first.json()["error"] == "hidden_text_timeout"

        busy = _post(client)
        assert busy.status_code == 503
        assert busy.json()["error"] == "checker_unavailable"
        assert len(calls) == 1, "a refused request must not start a checker thread"

        release.set()
        assert finished.wait(10)
        # the finally of the worker releases the slot just after `finished` is set
        for _ in range(50):
            again = _post(client)
            if again.status_code != 503:
                break
            threading.Event().wait(0.05)
        assert again.status_code == 200, again.text


def test_sequential_checks_reuse_the_slot():
    with _client(max_concurrent=1, timeout_s=30) as client:
        for _ in range(3):
            response = _post(client)
            assert response.status_code == 200, response.text


def test_the_default_limit_is_bounded():
    assert 1 <= router_module.MAX_CONCURRENT_CHECKS <= 8
