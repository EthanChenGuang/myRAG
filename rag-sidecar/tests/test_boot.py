import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

SECRET_48 = "s" * 48

SIDECAR_DIR = Path(__file__).resolve().parent.parent
BOOT_TIMEOUT_SECONDS = 20


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.mark.parametrize(
    "sidecar_env",
    [None, "", "production", "TEST"],
)
def test_recorded_converter_requires_test_env(sidecar_env):
    with pytest.raises(ValidationError) as error:
        SidecarSettings(
            secret=SecretStr(SECRET_48),
            ingest_converter="recorded",
            ingest_recorded_dir="/tmp/recorded-fixtures",
            sidecar_env=sidecar_env,
        )
    assert "recorded_converter_requires_test_env" in str(error.value)


def test_recorded_dir_with_docling_converter_requires_test_env():
    with pytest.raises(ValidationError) as error:
        SidecarSettings(
            secret=SecretStr(SECRET_48),
            ingest_recorded_dir="/tmp/recorded-fixtures",
            sidecar_env=None,
        )
    assert "recorded_converter_requires_test_env" in str(error.value)


def test_recorded_converter_allowed_in_test_env():
    settings = SidecarSettings(
        secret=SecretStr(SECRET_48),
        ingest_converter="recorded",
        ingest_recorded_dir="/tmp/recorded-fixtures",
        sidecar_env="test",
    )
    assert settings.ingest_converter == "recorded"


def test_create_app_refuses_recorded_converter_outside_tests():
    with pytest.raises(ValidationError):
        create_app(
            SidecarSettings(
                secret=SecretStr(SECRET_48),
                ingest_converter="recorded",
                ingest_recorded_dir="/tmp/recorded-fixtures",
            )
        )


def test_locked_environment_boots_and_answers_probes(tmp_path):
    venv_dir = tmp_path / "venv"
    env = {key: value for key, value in os.environ.items() if key != "RAG_SIDECAR_SECRET"}
    env["UV_PROJECT_ENVIRONMENT"] = str(venv_dir)
    sync = subprocess.run(
        ["uv", "sync", "--project", str(SIDECAR_DIR), "--locked", "--no-dev"],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert sync.returncode == 0, sync.stderr
    python = venv_dir / "bin" / "python"
    port = _free_port()
    process = subprocess.Popen(
        [str(python), "-m", "uvicorn", "rag_sidecar.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=SIDECAR_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + BOOT_TIMEOUT_SECONDS
        health = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            try:
                health = httpx.get(f"{base_url}/health", timeout=1.0)
                if health.status_code == 200:
                    break
            except httpx.TransportError:
                time.sleep(0.2)
        assert health is not None and health.status_code == 200
        assert health.json() == {"status": "ok"}
        assert httpx.get(f"{base_url}/ready", timeout=2.0).status_code == 503
        assert httpx.get(f"{base_url}/v1/info", timeout=2.0).status_code == 503
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
