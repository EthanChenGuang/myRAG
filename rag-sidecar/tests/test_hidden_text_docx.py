"""The Word (.docx) hidden-text checker behind POST /v1/hidden-text (plan 03.2-36, D-33, D-46, D-52)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rag_sidecar.contracts.ingest_security import HiddenTextReport
from rag_sidecar.main import create_app

pytest.importorskip("defusedxml")

from test_hidden_text import HEADER, SECRET, _settings, multipart  # noqa: E402
from test_image_boundary import _stages  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "rag-sidecar"
FIXTURE_DIR = REPO_ROOT / "eval" / "fixtures" / "security" / "docx"
GENERATOR = REPO_ROOT / "eval" / "fixtures" / "security" / "generate_hidden_docx.py"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
BOUNDARY = "HIDDENBOUNDARY"
HIDDEN_TEXT_EXTRA = {
    "pypdfium2": "5.15.2",
    "pdfplumber": "0.11.11",
    "python-docx": "1.2.0",
    "lxml": "6.1.3",
    "defusedxml": "0.7.1",
}


def _generator():
    loaded = sys.modules.get("hidden_docx_fixtures")
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location("hidden_docx_fixtures", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def client():
    with TestClient(create_app(_settings())) as test_client:
        yield test_client


def post_docx(client: TestClient, data: bytes, name: str = "doc.docx"):
    return client.post(
        "/v1/hidden-text",
        content=multipart(data, mime=DOCX_MIME, filename=name),
        headers={HEADER: SECRET, "content-type": f"multipart/form-data; boundary={BOUNDARY}"},
    )


def report_for(client: TestClient, name: str) -> HiddenTextReport:
    response = post_docx(client, (FIXTURE_DIR / name).read_bytes(), name)
    assert response.status_code == 200, response.text
    return HiddenTextReport.model_validate(response.json())


def test_the_generator_rebuilds_the_committed_fixtures_byte_for_byte():
    generator = _generator()
    first = generator.build_fixtures()
    second = generator.build_fixtures()
    assert first == second
    assert {"hidden-run.docx", "clean-plain.docx"} <= set(first)
    for name, data in first.items():
        assert (FIXTURE_DIR / name).read_bytes() == data, f"{name} differs; rerun generate_hidden_docx.py"


def test_the_corpus_manifest_matches_every_fixture():
    generator = _generator()
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest == generator.manifest(generator.build_fixtures())
    assert set(manifest["fixtures"]) == {path.name for path in FIXTURE_DIR.glob("*.docx")}


def test_a_vanished_run_is_reported_with_its_span(client):
    report = report_for(client, "hidden-run.docx")

    assert report.status == "hidden_found"
    assert [span.reason for span in report.spans] == ["vanished_run"]
    span = report.spans[0]
    assert span.text == _generator().HIDDEN_SENTENCE["hidden-run"]
    assert span.page is None and span.bbox is None
    assert report.checker_version


def test_a_plain_word_file_is_clean(client):
    report = report_for(client, "clean-plain.docx")

    assert report.status == "clean"
    assert report.spans == [] and report.dropped == 0


def test_the_hidden_text_extra_pins_the_locked_versions():
    pyproject = tomllib.loads((SIDECAR_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    extra = pyproject["project"]["optional-dependencies"].get("hidden-text")
    assert extra is not None
    assert sorted(extra) == sorted(f"{name}=={version}" for name, version in HIDDEN_TEXT_EXTRA.items())
    lock = tomllib.loads((SIDECAR_DIR / "uv.lock").read_text(encoding="utf-8"))
    versions = {entry["name"]: entry["version"] for entry in lock["package"]}
    for name, version in HIDDEN_TEXT_EXTRA.items():
        assert versions[name] == version, (name, versions[name])
    sidecar = next(entry for entry in lock["package"] if entry["name"] == "rag-sidecar")
    assert "hidden-text" in sidecar["metadata"]["provides-extras"]
    assert {dep["name"] for dep in sidecar["optional-dependencies"]["hidden-text"]} == set(HIDDEN_TEXT_EXTRA)


@pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not installed")
def test_the_lock_file_is_consistent_with_pyproject():
    done = subprocess.run(
        ["uv", "lock", "--check", "--offline"],
        cwd=SIDECAR_DIR,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-2000:]


@pytest.mark.parametrize("stage", ["docling", "runtime"])
def test_every_image_stage_that_ships_the_rules_installs_the_hidden_text_extra(stage):
    syncs = [line for line in _stages()[stage] if "uv sync" in line]
    assert syncs
    assert all("--extra hidden-text" in line for line in syncs), syncs
