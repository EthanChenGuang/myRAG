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


HIDDEN_CASES = [
    ("white-text.docx", "color_near_background"),
    ("tiny-size.docx", "font_too_small"),
    ("comments.docx", "comment"),
    ("tracked-deletion.docx", "tracked_deletion"),
    ("vanish-by-style.docx", "vanished_run"),
]
VISIBLE_LINES = {
    "white-text.docx": "VISIBLE_EN",
    "tiny-size.docx": "VISIBLE_IT",
    "comments.docx": "VISIBLE_ZH",
    "tracked-deletion.docx": "VISIBLE_EN",
    "vanish-by-style.docx": "VISIBLE_EN",
}
CLEAN_CASES = ["clean-plain.docx", "clean-styled.docx", "clean-empty.docx"]


@pytest.mark.parametrize(("name", "reason"), HIDDEN_CASES)
def test_each_word_hiding_technique_is_found_with_its_reason(client, name, reason):
    generator = _generator()
    report = report_for(client, name)

    assert report.status == "hidden_found"
    assert [span.reason for span in report.spans] == [reason]
    assert report.spans[0].text == generator.HIDDEN_SENTENCE[name.removesuffix(".docx")]
    reported = " ".join(span.text for span in report.spans)
    for line in getattr(generator, VISIBLE_LINES[name]):
        assert line not in reported


def test_a_run_that_turns_vanish_off_inside_a_vanished_style_is_not_reported(client):
    report = report_for(client, "vanish-by-style.docx")
    assert _generator().UNVANISHED_IN_STYLE not in " ".join(span.text for span in report.spans)


@pytest.mark.parametrize("name", CLEAN_CASES)
def test_clean_word_fixtures_are_not_flagged(client, name):
    report = report_for(client, name)

    assert report.status == "clean", [(span.reason, span.text) for span in report.spans]
    assert report.spans == [] and report.dropped == 0


def test_a_word_file_with_no_run_is_clean_with_zero_spans():
    from rag_sidecar.security import check_hidden_text

    report = check_hidden_text((FIXTURE_DIR / "clean-empty.docx").read_bytes(), DOCX_MIME)
    assert report.status == "clean" and report.spans == []


def _refuse_member_reads(monkeypatch):
    import zipfile

    def refuse(self, *args, **kwargs):
        raise AssertionError("a member was opened")

    monkeypatch.setattr(zipfile.ZipFile, "open", refuse)


def test_a_package_with_more_members_than_the_cap_is_refused_unread(client, monkeypatch):
    from rag_sidecar.security.docx_checks import MAX_MEMBERS

    data = _generator().too_many_members(MAX_MEMBERS + 1)
    _refuse_member_reads(monkeypatch)
    response = post_docx(client, data)
    assert response.status_code == 422
    assert response.json()["error"] == "unsafe_package"


def test_a_member_whose_declared_size_exceeds_the_cap_is_refused_unread(client, monkeypatch):
    from rag_sidecar.security.docx_checks import MAX_PART_BYTES

    data = _generator().oversized_member(MAX_PART_BYTES + (1 << 20))
    assert len(data) < 1 << 20
    _refuse_member_reads(monkeypatch)
    response = post_docx(client, data)
    assert response.status_code == 422
    assert response.json()["error"] == "unsafe_package"


def test_a_package_whose_total_declared_size_exceeds_the_cap_is_refused_unread(client, monkeypatch):
    from rag_sidecar.security.docx_checks import MAX_PART_BYTES, MAX_TOTAL_BYTES

    members = MAX_TOTAL_BYTES // MAX_PART_BYTES + 1
    data = _generator().oversized_package(members, MAX_PART_BYTES)
    _refuse_member_reads(monkeypatch)
    response = post_docx(client, data)
    assert response.status_code == 422
    assert response.json()["error"] == "unsafe_package"


def test_a_part_with_an_internal_entity_definition_is_refused(client):
    response = post_docx(client, _generator().entity_expansion())
    assert response.status_code == 422
    assert response.json()["error"] == "unsafe_package"


def test_the_checker_raises_unsafe_package_for_entities():
    from rag_sidecar.security import UnsafePackage, check_hidden_text

    with pytest.raises(UnsafePackage):
        check_hidden_text(_generator().entity_expansion(), DOCX_MIME)


def test_a_file_that_is_not_a_zip_is_unreadable_not_clean(client):
    response = post_docx(client, b"synthetic bytes that are not a package")
    assert response.status_code == 422
    assert response.json()["error"] == "unreadable_document"


def test_a_password_protected_word_file_is_refused(client):
    response = post_docx(client, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504)
    assert response.status_code == 422
    assert response.json()["error"] == "encrypted_document"


_BLOCKED_DOCX_IMPORT = """
import sys
from pathlib import Path
class _Block:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {"defusedxml", "docx", "lxml"}:
            raise ImportError(f"blocked {name}")
        return None
sys.meta_path.insert(0, _Block())
import rag_sidecar.security as security
import rag_sidecar.main  # noqa: F401
assert "defusedxml" not in sys.modules
try:
    security.check_hidden_text(Path(sys.argv[1]).read_bytes(), sys.argv[2])
except security.CheckerUnavailable:
    print("ok")
"""


def test_the_word_checker_is_unavailable_without_the_extra():
    done = subprocess.run(
        [sys.executable, "-I", "-c", _BLOCKED_DOCX_IMPORT, str(FIXTURE_DIR / "clean-plain.docx"), DOCX_MIME],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(SIDECAR_DIR / "src"), "RAG_SIDECAR_SECRET": ""},
        check=False,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.strip().endswith("ok")
