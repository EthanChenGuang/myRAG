import json
import re
import tomllib
from pathlib import Path

SIDECAR_DIR = Path(__file__).resolve().parent.parent
FORBIDDEN_PACKAGES = {"deepeval", "ragas", "langchain", "anthropic"}


def _dockerfile_lines() -> list[str]:
    text = (SIDECAR_DIR / "Dockerfile").read_text(encoding="utf-8")
    joined = re.sub(r"\\\n", " ", text)
    return [line.strip() for line in joined.splitlines() if line.strip() and not line.strip().startswith("#")]


def test_base_image_is_python_312_slim():
    assert any(line.startswith("FROM python:3.12-slim") for line in _dockerfile_lines())


def test_uv_image_is_pinned_to_an_exact_tag():
    copies = [line for line in _dockerfile_lines() if line.startswith("COPY --from=ghcr.io/astral-sh/uv:")]
    assert copies, "uv binary must be copied from the astral image"
    assert re.search(r"uv:\d+\.\d+\.\d+ ", copies[0])


def test_dependencies_install_locked_without_dev():
    syncs = [line for line in _dockerfile_lines() if "uv sync" in line]
    assert len(syncs) >= 2
    for line in syncs:
        assert "--locked" in line
        assert "--no-dev" in line
        assert "--frozen" not in line


def test_runs_as_non_root_user():
    users = [line for line in _dockerfile_lines() if line.startswith("USER ")]
    assert users
    assert users[-1].split()[1] not in {"root", "0"}


def test_has_healthcheck_on_health_path():
    checks = [line for line in _dockerfile_lines() if line.startswith("HEALTHCHECK")]
    assert checks
    assert "/health" in checks[0]


def test_no_secret_is_baked_into_env_or_arg():
    for line in _dockerfile_lines():
        if line.startswith(("ENV ", "ARG ")):
            assert "RAG_SIDECAR_SECRET" not in line


def test_cmd_runs_venv_uvicorn_without_uv_at_runtime():
    # The image runs as a system user without a home directory, so invoking uv at
    # runtime fails to initialise its cache; the CMD must call the venv binary directly.
    cmds = [line for line in _dockerfile_lines() if line.startswith("CMD ")]
    assert len(cmds) == 1
    cmd = json.loads(cmds[0][len("CMD "):])
    assert cmd[0] == "/app/.venv/bin/uvicorn"
    assert "rag_sidecar.main:app" in cmd
    assert all(part not in ("uv", "uvx") for part in cmd)


def test_dockerignore_excludes_environment_and_secrets():
    entries = (SIDECAR_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()
    for required in (".venv", "tests", ".env"):
        assert required in entries


def test_locked_dependencies_exclude_eval_only_packages():
    lock = tomllib.loads((SIDECAR_DIR / "uv.lock").read_text(encoding="utf-8"))
    names = {package["name"].lower() for package in lock["package"]}
    assert FORBIDDEN_PACKAGES.isdisjoint(names), FORBIDDEN_PACKAGES & names
