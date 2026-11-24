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


def _stages() -> dict[str, list[str]]:
    stages: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in _dockerfile_lines():
        if line.startswith("FROM "):
            match = re.fullmatch(r"FROM \S+ AS (\S+)", line)
            assert match, f"every stage must be named: {line}"
            current = stages.setdefault(match.group(1), [])
        assert current is not None, "instruction before the first FROM"
        current.append(line)
    return stages


def _stage_env(lines: list[str], name: str) -> str | None:
    for line in lines:
        if line.startswith("ENV "):
            match = re.search(rf"\b{name}=(\S+)", line)
            if match:
                return match.group(1)
    return None


def test_base_image_is_python_312_slim():
    assert any(line.startswith("FROM python:3.12-slim") for line in _dockerfile_lines())


def test_base_image_is_pinned_by_digest():
    froms = [line for line in _dockerfile_lines() if line.startswith("FROM ")]
    assert froms and all(re.fullmatch(r"FROM \S+@sha256:[0-9a-f]{64}( AS \S+)?", line) for line in froms), froms


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
    for name, lines in _stages().items():
        users = [line for line in lines if line.startswith("USER ")]
        assert users, name
        assert users[-1].split()[1] not in {"root", "0"}, name


def test_has_healthcheck_on_health_path():
    for name, lines in _stages().items():
        checks = [line for line in lines if line.startswith("HEALTHCHECK")]
        assert checks, name
        assert "/health" in checks[0], name


def test_no_secret_is_baked_into_env_or_arg():
    for line in _dockerfile_lines():
        if line.startswith(("ENV ", "ARG ")):
            assert "RAG_SIDECAR_SECRET" not in line


def test_cmd_runs_venv_uvicorn_without_uv_at_runtime():
    # The image runs as a system user without a home directory, so invoking uv at
    # runtime fails to initialise its cache; the CMD must call the venv binary directly.
    for name, lines in _stages().items():
        cmds = [line for line in lines if line.startswith("CMD ")]
        assert len(cmds) == 1, name
        cmd = json.loads(cmds[0][len("CMD "):])
        assert cmd[0] == "/app/.venv/bin/uvicorn", name
        assert "rag_sidecar.main:app" in cmd, name
        assert all(part not in ("uv", "uvx") for part in cmd), name


def test_default_target_is_the_slim_last_stage_without_docling():
    stages = _stages()
    assert list(stages)[-1] == "runtime"
    assert not any("--extra docling" in line or "docling-tools" in line for line in stages["runtime"])


def test_docling_stage_installs_the_extra_locked():
    lines = _stages()["docling"]
    syncs = [line for line in lines if "uv sync" in line]
    assert len(syncs) >= 2
    assert all("--extra docling" in line for line in syncs), syncs


def test_docling_stage_bakes_models_into_fixed_directories():
    lines = _stages()["docling"]
    artifacts = _stage_env(lines, "RAG_SIDECAR_DOCLING_ARTIFACTS")
    hf_home = _stage_env(lines, "HF_HOME")
    tiktoken_dir = _stage_env(lines, "TIKTOKEN_CACHE_DIR")
    assert artifacts and hf_home and tiktoken_dir
    for path in (artifacts, hf_home, tiktoken_dir):
        assert path.startswith("/opt/"), path
    assert len({artifacts, hf_home, tiktoken_dir}) == 3

    downloads = [line for line in lines if "docling-tools models download" in line]
    assert len(downloads) == 1
    target = rf"""["']?({re.escape(artifacts)}|\$\{{?RAG_SIDECAR_DOCLING_ARTIFACTS\}}?)["']?(\s|$)"""
    assert re.search(rf"(-o|--output-dir) {target}", downloads[0]), downloads[0]
    warm = [line for line in lines if "cl100k_base" in line]
    assert warm and warm[0].startswith("RUN ")


def test_docling_stage_downloads_before_dropping_privileges():
    lines = _stages()["docling"]
    download_at = next(i for i, line in enumerate(lines) if "docling-tools models download" in line)
    warm_at = next(i for i, line in enumerate(lines) if "cl100k_base" in line)
    user_at = next(i for i, line in enumerate(lines) if line.startswith("USER "))
    assert download_at < user_at and warm_at < user_at


def test_dockerignore_excludes_environment_and_secrets():
    entries = (SIDECAR_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()
    for required in (".venv", "tests", ".env"):
        assert required in entries


def test_locked_dependencies_exclude_eval_only_packages():
    lock = tomllib.loads((SIDECAR_DIR / "uv.lock").read_text(encoding="utf-8"))
    names = {package["name"].lower() for package in lock["package"]}
    assert FORBIDDEN_PACKAGES.isdisjoint(names), FORBIDDEN_PACKAGES & names
