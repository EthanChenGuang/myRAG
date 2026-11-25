"""POST /v1/hidden-text and the PDF hidden-text checker (plan 03.2-35, D-33, D-46)."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts.ingest_security import HiddenTextReport
from rag_sidecar.main import create_app
from rag_sidecar.settings import SidecarSettings

pytest.importorskip("pypdfium2")
pytest.importorskip("pdfplumber")

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "eval" / "fixtures" / "security" / "pdf"
GENERATOR = REPO_ROOT / "eval" / "fixtures" / "security" / "generate_hidden_pdfs.py"
SECRET = "h" * 48
HEADER = "x-sidecar-secret"
BOUNDARY = "HIDDENBOUNDARY"


def _generator():
    loaded = sys.modules.get("hidden_pdf_fixtures")
    if loaded is not None:
        return loaded
    spec = importlib.util.spec_from_file_location("hidden_pdf_fixtures", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def multipart(data: bytes, mime: str = "application/pdf", filename: str = "doc.pdf", request: dict | None = None) -> bytes:
    meta = request or {
        "filename": filename,
        "mime_type": mime,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
    }
    return (
        f"--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n".encode()
        + json.dumps(meta).encode()
        + f"\r\n--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n".encode()
        + data
        + f"\r\n--{BOUNDARY}--\r\n".encode()
    )


def _settings(**overrides) -> SidecarSettings:
    values = {
        "secret": SecretStr(SECRET),
        "sidecar_env": "test",
        "ingest_converter": "recorded",
        "ingest_recorded_dir": str(REPO_ROOT / "eval/fixtures/parse/recorded"),
        "max_upload_mb": 1,
    }
    values.update(overrides)
    return SidecarSettings(**values)


@pytest.fixture
def client():
    with TestClient(create_app(_settings())) as test_client:
        yield test_client


def post(client: TestClient, data: bytes, **kwargs):
    return client.post(
        "/v1/hidden-text",
        content=multipart(data, **kwargs),
        headers={HEADER: SECRET, "content-type": f"multipart/form-data; boundary={BOUNDARY}"},
    )


def report_for(client: TestClient, name: str) -> HiddenTextReport:
    response = post(client, (FIXTURE_DIR / name).read_bytes(), filename=name)
    assert response.status_code == 200, response.text
    return HiddenTextReport.model_validate(response.json())


def test_the_generator_rebuilds_the_committed_fixtures_byte_for_byte():
    generator = _generator()
    first = generator.build_fixtures()
    second = generator.build_fixtures()
    assert first == second
    assert {"white-on-white.pdf", "clean-plain.pdf"} <= set(first)
    for name, data in first.items():
        assert (FIXTURE_DIR / name).read_bytes() == data, f"{name} differs; rerun generate_hidden_pdfs.py"


def test_white_on_white_is_reported_with_its_span(client):
    report = report_for(client, "white-on-white.pdf")

    assert report.status == "hidden_found"
    assert len(report.spans) == 1
    span = report.spans[0]
    assert span.reason == "color_near_background"
    assert span.text == _generator().HIDDEN_SENTENCE["white-on-white"]
    assert span.page == 1
    assert span.bbox is not None and len(span.bbox) == 4
    assert report.checker_version


def test_a_plain_pdf_is_clean(client):
    report = report_for(client, "clean-plain.pdf")

    assert report.status == "clean"
    assert report.spans == []
    assert report.dropped == 0


def test_no_secret_configured_is_503():
    with TestClient(create_app(_settings(secret=None))) as unsecured:
        data = (FIXTURE_DIR / "white-on-white.pdf").read_bytes()
        response = unsecured.post(
            "/v1/hidden-text",
            content=multipart(data),
            headers={"content-type": f"multipart/form-data; boundary={BOUNDARY}"},
        )
    assert response.status_code == 503


def test_a_wrong_secret_is_401(client):
    data = (FIXTURE_DIR / "white-on-white.pdf").read_bytes()
    response = client.post(
        "/v1/hidden-text",
        content=multipart(data),
        headers={HEADER: "x" * 48, "content-type": f"multipart/form-data; boundary={BOUNDARY}"},
    )
    assert response.status_code == 401


def test_a_request_over_the_size_limit_is_refused(client):
    data = b"%PDF-1.4\n" + b"0" * (2 * 1024 * 1024)
    response = post(client, data)
    assert response.status_code == 413
    assert response.json()["error"] == "upload_too_large"


def test_a_request_whose_digest_does_not_match_the_file_is_refused(client):
    data = (FIXTURE_DIR / "white-on-white.pdf").read_bytes()
    meta = {"filename": "doc.pdf", "mime_type": "application/pdf", "sha256": "0" * 64, "size_bytes": len(data)}
    response = post(client, data, request=meta)
    assert response.status_code == 422
    assert response.json()["error"] == "hidden_text_mismatch"


HIDDEN_CASES = [
    ("white-on-white.pdf", "color_near_background"),
    ("tiny-font.pdf", "font_too_small"),
    ("off-page.pdf", "outside_page"),
    ("invisible-render.pdf", "invisible_render_mode"),
    ("covered-text.pdf", "covered_by_object"),
    ("form-white-text.pdf", "color_near_background"),
]
VISIBLE_LINES = {
    "white-on-white.pdf": "VISIBLE_EN",
    "tiny-font.pdf": "VISIBLE_ZH",
    "off-page.pdf": "VISIBLE_IT",
    "invisible-render.pdf": "VISIBLE_EN",
    "covered-text.pdf": "VISIBLE_IT",
    "form-white-text.pdf": "VISIBLE_EN",
}
CLEAN_CASES = [
    "clean-plain.pdf",
    "clean-dark-header.pdf",
    "clean-footnotes.pdf",
    "clean-crop-marks.pdf",
    "clean-scan.pdf",
    "clean-ocr-layer.pdf",
    "link-annotation.pdf",
    "zero-pages.pdf",
]


@pytest.mark.parametrize(("name", "reason"), HIDDEN_CASES)
def test_each_hiding_technique_is_found_with_its_reason(client, name, reason):
    generator = _generator()
    report = report_for(client, name)

    assert report.status == "hidden_found"
    assert [span.reason for span in report.spans] == [reason]
    assert report.spans[0].text == generator.HIDDEN_SENTENCE[name.removesuffix(".pdf")]
    reported = " ".join(span.text for span in report.spans)
    for line in getattr(generator, VISIBLE_LINES[name]):
        assert line not in reported


@pytest.mark.parametrize("name", CLEAN_CASES)
def test_clean_fixtures_are_not_flagged(client, name):
    report = report_for(client, name)

    assert report.status == "clean", [(span.reason, span.text) for span in report.spans]
    assert report.spans == []


def test_the_corpus_manifest_matches_every_fixture():
    generator = _generator()
    manifest = json.loads((FIXTURE_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest == generator.manifest(generator.build_fixtures())
    assert {name for name in manifest["fixtures"]} == {path.name for path in FIXTURE_DIR.glob("*.pdf")}


def test_link_annotation_targets_are_returned(client):
    report = report_for(client, "link-annotation.pdf")
    assert report.link_targets == [_generator().LINK_TARGET]


def test_a_hidden_fixture_without_links_returns_no_target(client):
    assert report_for(client, "white-on-white.pdf").link_targets == []


def _check(data: bytes, mime: str = "application/pdf") -> HiddenTextReport:
    from rag_sidecar.security import check_hidden_text

    return check_hidden_text(data, mime)


@pytest.mark.parametrize(
    "path",
    [REPO_ROOT / "config" / "rag" / "hidden-text-rules.json", REPO_ROOT / "rag-sidecar" / "config" / "rag" / "hidden-text-rules.json"],
)
def test_the_rules_file_and_its_copy_validate_against_the_model(path):
    from rag_sidecar.contracts.ingest_security import HiddenTextRules

    rules = HiddenTextRules.model_validate(json.loads(path.read_text(encoding="utf-8")))
    assert rules.zero_width_threshold >= 1
    assert rules.pdf.min_span_chars >= 1


def test_two_runs_give_equal_reports_ordered_by_page_then_position():
    data = _generator().many_fragments(120, per_page=50)
    first, second = _check(data), _check(data)

    assert first == second
    keys = [(span.page, -span.bbox[3], span.bbox[0]) for span in first.spans]
    assert keys == sorted(keys)
    assert [span.page for span in first.spans][:1] == [1] and first.spans[-1].page == 3
    assert [span.text for span in first.spans[:2]] == ["hidden fragment 0000", "hidden fragment 0001"]


def test_a_file_with_500_hidden_fragments_is_bounded_with_a_dropped_count():
    report = _check(_generator().many_fragments(500))

    assert report.status == "hidden_found"
    assert len(report.spans) == 200
    assert report.dropped == 300
    assert report.spans[-1].text == "hidden fragment 0199"


def test_a_10000_character_hidden_span_is_cut_to_2000_characters():
    report = _check(_generator().long_span(10_000))

    assert len(report.spans) == 1
    assert len(report.spans[0].text) == 2_000
    assert report.dropped == 0


def test_a_fragment_below_the_minimum_character_count_is_dropped():
    report = _check(_generator().short_fragment())

    assert report.status == "clean"
    assert report.spans == [] and report.dropped == 0


@pytest.mark.parametrize("mime", ["text/plain", "text/html", "application/vnd.ms-excel", "image/png"])
def test_an_unsupported_mime_type_is_not_checked(client, mime):
    data = b"plain synthetic text with nothing hidden"
    response = post(client, data, mime=mime, filename="doc.bin")
    assert response.status_code == 200
    report = HiddenTextReport.model_validate(response.json())
    assert report.status == "not_checked"
    assert report.spans == [] and report.link_targets == []


def test_an_unreadable_pdf_is_refused_not_reported_clean(client):
    response = post(client, b"%PDF-1.4\nthis is not a pdf body\n")
    assert response.status_code == 422
    assert response.json()["error"] == "unreadable_document"


_BLOCKED_IMPORT = """
import sys
class _Block:
    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in {"pypdfium2", "pypdfium2_raw", "pdfplumber", "pdfminer"}:
            raise ImportError(f"blocked {name}")
        return None
sys.meta_path.insert(0, _Block())
import rag_sidecar.security as security
import rag_sidecar.main  # noqa: F401
assert "pypdfium2" not in sys.modules and "pdfplumber" not in sys.modules
report = security.check_hidden_text(b"plain", "text/plain")
assert report.status == "not_checked", report
try:
    security.check_hidden_text(b"%PDF-1.4", "application/pdf")
except security.CheckerUnavailable:
    print("ok")
"""


def test_the_package_imports_without_the_preflight_extra():
    import subprocess

    done = subprocess.run(
        [sys.executable, "-I", "-c", _BLOCKED_IMPORT],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(REPO_ROOT / "rag-sidecar" / "src"), "RAG_SIDECAR_SECRET": ""},
        check=False,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.strip().endswith("ok")


def test_the_route_answers_503_checker_unavailable_without_the_extra(client, monkeypatch):
    for name in ("pypdfium2", "pypdfium2.raw", "pdfplumber"):
        monkeypatch.setitem(sys.modules, name, None)
    response = post(client, (FIXTURE_DIR / "white-on-white.pdf").read_bytes())
    assert response.status_code == 503
    assert response.json()["error"] == "checker_unavailable"
