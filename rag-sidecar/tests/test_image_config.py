"""The sidecar image carries the routing data and processing profiles it reads at run time (03.1 gap 2).

The image is built with context rag-sidecar/ and holds /app/src and /app/config; a checkout reads the repo-root config/rag.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SIDECAR_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SIDECAR_DIR.parent
SHIPPED_CONFIG_DIR = SIDECAR_DIR / "config" / "rag"
# Every JSON the sidecar reads at run time; each plan that adds one asserts its presence here.
REQUIRED_CONFIG_FILES = ("parse-routing.json", "processing-profiles.json", "language-packs.json")
CONFIG_FILES = tuple(sorted(path.name for path in SHIPPED_CONFIG_DIR.glob("*.json")))

_PROBE = """
import sys
sys.path.insert(0, sys.argv[1])
from rag_sidecar.preflight import config
assert config.__file__.startswith(sys.argv[1]), config.__file__
cfg = config.load_routing_config()
print("routing", cfg.version, config.default_routing_config_path())
from rag_sidecar.preflight.config import load_processing_profiles
profiles = load_processing_profiles()
print("profiles", len(profiles.profiles), config.default_processing_profiles_path())
from rag_sidecar.contracts import languages
print("languages", [pack.code for pack in languages.load_language_registry().packs], languages.default_language_packs_path())
"""

_PROFILE_PROBE = """
import sys
sys.path.insert(0, sys.argv[1])
from rag_sidecar.ingest import tiered
assert tiered.__file__.startswith(sys.argv[1]), tiered.__file__
print("profile", tiered.load_profile("general@1").id)
"""


def _image_layout(root: Path, *, with_config: bool) -> Path:
    """What the Dockerfile copies into /app: src/ and, when shipped, config/rag/."""
    app = root / "app"
    shutil.copytree(SIDECAR_DIR / "src", app / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if with_config:
        (app / "config" / "rag").mkdir(parents=True)
        for name in CONFIG_FILES:
            shutil.copyfile(SHIPPED_CONFIG_DIR / name, app / "config" / "rag" / name)
    return app


def _run(probe: str, app: Path) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("PYTHON")}
    return subprocess.run(
        [sys.executable, "-c", probe, str(app / "src")],
        cwd=app,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_routing_data_and_profiles_resolve_from_an_image_like_layout(tmp_path):
    app = _image_layout(tmp_path, with_config=True)

    done = _run(_PROBE, app)

    assert done.returncode == 0, done.stderr[-2000:]
    assert f"{app / 'config' / 'rag' / 'parse-routing.json'}" in done.stdout
    assert f"{app / 'config' / 'rag' / 'processing-profiles.json'}" in done.stdout
    assert f"languages ['zh', 'en', 'it'] {app / 'config' / 'rag' / 'language-packs.json'}" in done.stdout


def test_the_worker_loads_a_profile_from_an_image_like_layout(tmp_path):
    pytest.importorskip("docling_core")
    app = _image_layout(tmp_path, with_config=True)

    done = _run(_PROFILE_PROBE, app)

    assert done.returncode == 0, done.stderr[-2000:]
    assert "profile general@1" in done.stdout


def test_a_missing_config_fails_with_an_error_that_names_the_paths_it_tried(tmp_path):
    app = _image_layout(tmp_path, with_config=False)

    done = _run(_PROBE, app)

    assert done.returncode != 0
    assert "RagConfigMissing" in done.stderr, done.stderr[-2000:]
    # The contracts build their Language type from the registry at import (D-06), so it is the first file missed.
    assert str(app / "config" / "rag" / "language-packs.json") in done.stderr


def test_a_checkout_still_reads_the_repo_root_config():
    from rag_sidecar.preflight import config

    assert config.default_routing_config_path() == REPO_ROOT / "config" / "rag" / "parse-routing.json"
    assert hasattr(config, "default_processing_profiles_path"), "the profiles path has no resolver"
    assert config.default_processing_profiles_path() == REPO_ROOT / "config" / "rag" / "processing-profiles.json"


@pytest.mark.parametrize("name", REQUIRED_CONFIG_FILES)
def test_the_image_ships_every_config_file_the_sidecar_reads(name):
    assert name in CONFIG_FILES, f"rag-sidecar/config/rag/{name} is missing; copy config/rag/{name} there"


@pytest.mark.parametrize("name", CONFIG_FILES)
def test_the_copy_shipped_in_the_image_matches_the_repo_config(name):
    shipped = SIDECAR_DIR / "config" / "rag" / name
    assert shipped.is_file(), f"rag-sidecar/config/rag/{name} is missing; copy config/rag/{name} there"
    assert shipped.read_bytes() == (REPO_ROOT / "config" / "rag" / name).read_bytes(), (
        f"rag-sidecar/config/rag/{name} differs from config/rag/{name}; copy the repo file over it"
    )


def _stages() -> dict[str, list[str]]:
    text = re.sub(r"\\\n", " ", (SIDECAR_DIR / "Dockerfile").read_text(encoding="utf-8"))
    stages: dict[str, list[str]] = {}
    current: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"FROM \S+ AS (\S+)", line)
        if match:
            current = stages.setdefault(match.group(1), [])
        current.append(line)
    return stages


@pytest.mark.parametrize("stage", ["docling", "runtime"])
def test_every_image_stage_copies_the_config_next_to_src(stage):
    lines = _stages()[stage]
    assert "WORKDIR /app" in lines
    assert "COPY config ./config" in lines, f"stage {stage} does not ship config/rag"


def test_the_docker_context_does_not_ignore_the_config():
    ignored = (SIDECAR_DIR / ".dockerignore").read_text(encoding="utf-8").split()
    assert not any(pattern.strip("/") in {"config", "config/*", "config/**"} for pattern in ignored)
