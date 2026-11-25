import asyncio
import contextlib
import os
import sys
import time
import types
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from rag_sidecar.contracts import (
    DoclingOptions,
    ParseJobAccepted,
    ParseJobRequest,
    ParseJobState,
    ParseResult,
    SidecarError,
    SidecarInfo,
    SidecarReady,
)
from rag_sidecar.main import CONTRACTS_SCHEMA_VERSION, create_app
from rag_sidecar.parse import converter as converter_module
from rag_sidecar.parse.converter import (
    PageCapExceeded,
    StubConverter,
    default_converter,
    docling_available,
    stub_result,
)
from rag_sidecar.parse.jobs import JobRunner, QueueFull
from rag_sidecar.parse.upload import MalformedUpload, UploadTooLarge, read_upload
from rag_sidecar.settings import SidecarSettings, load_settings

PDF_BYTES = b"%PDF-1.4 stub"
WAIT_SECONDS = float(os.environ.get("PARSE_TEST_WAIT_SECONDS", "30"))


def make_request(**overrides) -> ParseJobRequest:
    values = {
        "profile_id": "general@1",
        "profile_version": 1,
        "docling": DoclingOptions(
            ocr=False,
            force_full_page_ocr=False,
            table_mode="fast",
            heading_hierarchy=True,
            generate_picture_images=False,
        ),
        "ocr_languages": ["en"],
        "max_tokens": 512,
        "repeat_table_header": True,
    }
    values.update(overrides)
    return ParseJobRequest(**values)


def wait_until(predicate, timeout: float = WAIT_SECONDS):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def gate(tmp_path):
    path = tmp_path / "gate"
    yield path
    path.touch()


@pytest.fixture
def make_runner():
    runners: list[JobRunner] = []

    def build(converter, clock=None, **settings) -> JobRunner:
        options = {"clock": clock} if clock is not None else {}
        runner = JobRunner(SidecarSettings(**settings), converter, **options)
        runners.append(runner)
        return runner

    yield build
    for runner in runners:
        runner.close()


def finished(runner: JobRunner, job_id: str):
    return wait_until(lambda: (s := runner.state(job_id)) is not None and s.status in ("succeeded", "failed") and s)


def test_runner_job_moves_from_queued_through_running_to_succeeded(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate)))
    job_id = runner.submit(make_request(), PDF_BYTES)

    assert runner.state(job_id).status in ("queued", "running")
    wait_until(lambda: runner.state(job_id).status == "running")
    gate.touch()
    state = finished(runner, job_id)

    assert state.status == "succeeded"
    assert state.error_class is None
    assert isinstance(state.result, ParseResult)
    assert state.result.markdown == stub_result().markdown


def test_runner_second_job_reads_queued_while_the_only_worker_is_busy(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate)), parse_workers=1, parse_queue=2)
    first = runner.submit(make_request(), PDF_BYTES)
    wait_until(lambda: runner.state(first).status == "running")
    second = runner.submit(make_request(), PDF_BYTES)

    assert runner.state(second).status == "queued"
    gate.touch()
    assert finished(runner, second).status == "succeeded"


def test_runner_failed_job_reports_snake_case_error_class_and_no_message_text(make_runner):
    runner = make_runner(StubConverter(raises=RuntimeError, message="confidential contract wording"))
    state = finished(runner, runner.submit(make_request(), PDF_BYTES))

    assert state.status == "failed"
    assert state.error_class == "runtime_error"
    assert state.result is None
    assert "confidential" not in state.model_dump_json()


def test_runner_converter_supplied_error_class_is_kept(make_runner):
    runner = make_runner(StubConverter(error_class="ocr_failed"))
    state = finished(runner, runner.submit(make_request(), PDF_BYTES))

    assert state.status == "failed"
    assert state.error_class == "ocr_failed"


def test_runner_page_count_above_settings_cap_fails_with_page_cap(make_runner):
    runner = make_runner(StubConverter(result=stub_result(page_count=5)), page_cap=3)
    state = finished(runner, runner.submit(make_request(), PDF_BYTES))

    assert state.status == "failed"
    assert state.error_class == "page_cap"


def test_runner_request_page_cap_below_settings_cap_wins(make_runner):
    runner = make_runner(StubConverter(result=stub_result(page_count=5)), page_cap=300)
    state = finished(runner, runner.submit(make_request(page_cap=4), PDF_BYTES))

    assert state.status == "failed"
    assert state.error_class == "page_cap"


def test_runner_page_count_within_cap_succeeds(make_runner):
    runner = make_runner(StubConverter(result=stub_result(page_count=3)), page_cap=3)
    assert finished(runner, runner.submit(make_request(), PDF_BYTES)).status == "succeeded"


def test_runner_page_cap_exceeded_exception_maps_to_page_cap(make_runner):
    runner = make_runner(StubConverter(raises=PageCapExceeded, message=""))
    state = finished(runner, runner.submit(make_request(), PDF_BYTES))

    assert state.error_class == "page_cap"


def test_runner_fourth_submit_raises_queue_full_with_one_worker_and_queue_two(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate)), parse_workers=1, parse_queue=2)
    for _ in range(3):
        runner.submit(make_request(), PDF_BYTES)

    with pytest.raises(QueueFull):
        runner.submit(make_request(), PDF_BYTES)


def test_runner_rejected_submit_leaves_no_job_directory_behind(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate)), parse_workers=1, parse_queue=0)
    runner.submit(make_request(), PDF_BYTES)
    before = sorted(path.name for path in runner.root.iterdir())

    with pytest.raises(QueueFull):
        runner.submit(make_request(), PDF_BYTES)

    assert sorted(path.name for path in runner.root.iterdir()) == before
    assert len(before) == 1


def test_runner_capacity_frees_when_a_job_finishes(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate)), parse_workers=1, parse_queue=0)
    first = runner.submit(make_request(), PDF_BYTES)
    with pytest.raises(QueueFull):
        runner.submit(make_request(), PDF_BYTES)

    gate.touch()
    finished(runner, first)
    second = runner.submit(make_request(), PDF_BYTES)

    assert finished(runner, second).status == "succeeded"


def test_runner_job_reads_expired_after_ttl_and_its_directory_is_gone(make_runner):
    clock = FakeClock()
    runner = make_runner(StubConverter(), clock=clock, parse_ttl_seconds=60)
    job_id = runner.submit(make_request(), PDF_BYTES)
    assert finished(runner, job_id).status == "succeeded"

    clock.now += 59
    assert runner.state(job_id).status == "succeeded"
    clock.now += 2
    state = runner.state(job_id)

    assert state.status == "expired"
    assert state.result is None
    assert list(runner.root.iterdir()) == []
    assert runner.artifact(job_id, "picture-1.png") is None


def test_runner_unknown_job_id_is_none_not_expired(make_runner):
    runner = make_runner(StubConverter())

    assert runner.state(str(uuid.uuid4())) is None
    assert runner.state("../../etc/passwd") is None
    assert runner.delete(str(uuid.uuid4())) is False


def test_runner_running_job_never_expires_while_it_runs(make_runner, gate):
    clock = FakeClock()
    runner = make_runner(StubConverter(gate_path=str(gate)), clock=clock, parse_ttl_seconds=60)
    job_id = runner.submit(make_request(), PDF_BYTES)
    wait_until(lambda: runner.state(job_id).status == "running")

    clock.now += 10_000

    assert runner.state(job_id).status == "running"


def test_runner_delete_removes_the_job_and_its_files_at_once(make_runner):
    runner = make_runner(StubConverter(artifacts={"picture-1.png": b"png"}))
    job_id = runner.submit(make_request(), PDF_BYTES)
    finished(runner, job_id)

    assert runner.delete(job_id) is True

    assert runner.state(job_id) is None
    assert list(runner.root.iterdir()) == []
    assert runner.delete(job_id) is False


def test_runner_artifact_must_match_the_name_pattern_and_be_listed_by_the_result(make_runner):
    runner = make_runner(
        StubConverter(artifacts={"picture-1.png": b"png-bytes"}, unlisted={"secret.txt": b"unlisted"})
    )
    job_id = runner.submit(make_request(), PDF_BYTES)
    finished(runner, job_id)

    listed = runner.artifact(job_id, "picture-1.png")
    assert listed is not None and listed.read_bytes() == b"png-bytes"
    for name in ("secret.txt", "result.json", "../result.json", "..", ".", ".hidden", "a/b", "PICTURE-1.PNG", "x" * 65, ""):
        assert runner.artifact(job_id, name) is None, name


def test_runner_artifact_is_none_while_the_job_has_not_succeeded(make_runner, gate):
    runner = make_runner(StubConverter(gate_path=str(gate), artifacts={"picture-1.png": b"png"}))
    job_id = runner.submit(make_request(), PDF_BYTES)

    assert runner.artifact(job_id, "picture-1.png") is None


def test_runner_job_ids_are_random_uuids(make_runner):
    runner = make_runner(StubConverter())
    first = runner.submit(make_request(), PDF_BYTES)
    second = runner.submit(make_request(), PDF_BYTES)

    assert first != second
    assert uuid.UUID(first).version == 4
    assert uuid.UUID(second).version == 4


def test_runner_accepts_a_source_path_and_never_names_files_after_user_input(make_runner, tmp_path):
    source = tmp_path / "Quarterly Report.pdf"
    source.write_bytes(PDF_BYTES)
    runner = make_runner(StubConverter())
    job_id = runner.submit(make_request(), source)
    finished(runner, job_id)

    assert all("Quarterly" not in path.name for path in runner.root.rglob("*"))
    assert source.exists()


def test_runner_crashed_worker_fails_the_job_and_the_pool_recovers(make_runner):
    runner = make_runner(StubConverter(crash_marker=b"CRASH"))
    crashed = finished(runner, runner.submit(make_request(), b"CRASH"))

    assert crashed.status == "failed"
    assert crashed.error_class == "worker_crashed"
    assert finished(runner, runner.submit(make_request(), PDF_BYTES)).status == "succeeded"


def test_settings_defaults_are_safe():
    settings = SidecarSettings()

    assert settings.parse_workers == 1
    assert settings.parse_queue == 8
    assert settings.parse_ttl_seconds == 3600
    assert settings.max_upload_mb == 20
    assert settings.max_upload_bytes == 20 * 1024 * 1024
    assert settings.page_cap == 300
    assert settings.docling_artifacts is None


def test_settings_read_the_parse_variables_from_the_environment(monkeypatch):
    monkeypatch.setenv("RAG_SIDECAR_SECRET", "s" * 48)
    monkeypatch.setenv("RAG_SIDECAR_PARSE_WORKERS", "2")
    monkeypatch.setenv("RAG_SIDECAR_PARSE_QUEUE", "3")
    monkeypatch.setenv("RAG_SIDECAR_PARSE_TTL_SECONDS", "120")
    monkeypatch.setenv("RAG_SIDECAR_MAX_UPLOAD_MB", "5")
    monkeypatch.setenv("RAG_SIDECAR_PAGE_CAP", "40")
    monkeypatch.setenv("RAG_SIDECAR_DOCLING_ARTIFACTS", "/opt/docling-models")
    settings = load_settings()

    assert settings.secret == SecretStr("s" * 48)
    assert settings.parse_workers == 2
    assert settings.parse_queue == 3
    assert settings.parse_ttl_seconds == 120
    assert settings.max_upload_mb == 5
    assert settings.page_cap == 40
    assert settings.docling_artifacts == "/opt/docling-models"


@pytest.mark.parametrize("bad", ["abc", "", "0", "-4", "1.5", "999999999"])
def test_settings_fall_back_to_the_default_for_unusable_values(monkeypatch, bad):
    for name in (
        "RAG_SIDECAR_PARSE_WORKERS",
        "RAG_SIDECAR_PARSE_QUEUE",
        "RAG_SIDECAR_PARSE_TTL_SECONDS",
        "RAG_SIDECAR_MAX_UPLOAD_MB",
        "RAG_SIDECAR_PAGE_CAP",
    ):
        monkeypatch.setenv(name, bad)
    monkeypatch.setenv("RAG_SIDECAR_DOCLING_ARTIFACTS", "")
    settings = load_settings()

    assert settings.parse_workers == 1
    assert settings.parse_queue == (0 if bad == "0" else 8)
    assert settings.parse_ttl_seconds == 3600
    assert settings.max_upload_mb == 20
    assert settings.page_cap == 300
    assert settings.docling_artifacts is None


def test_default_converter_is_none_when_docling_is_not_installed():
    assert docling_available() is False
    assert default_converter() is None


def test_default_converter_wraps_the_adapter_when_docling_is_importable(monkeypatch, tmp_path):
    calls: list[tuple[Path, Path]] = []

    class FakeDoclingConverter:
        def convert(self, input_path, request, out_dir):
            calls.append((input_path, out_dir))
            return stub_result(page_count=2)

    adapter = types.ModuleType("rag_sidecar.parse.docling_adapter")
    adapter.DoclingConverter = FakeDoclingConverter
    monkeypatch.setitem(sys.modules, "docling", types.ModuleType("docling"))
    monkeypatch.setitem(sys.modules, "rag_sidecar.parse.docling_adapter", adapter)

    assert docling_available() is True
    converter = default_converter()
    assert converter is not None
    result = converter.convert(tmp_path / "in.pdf", make_request(), tmp_path)

    assert result.page_count == 2
    assert calls == [(tmp_path / "in.pdf", tmp_path)]
    assert converter_module.default_converter() is not None


SECRET = "k" * 48
AUTH = {"x-sidecar-secret": SECRET}
UNKNOWN_JOB = str(uuid.UUID(int=1))
MIB = 1024 * 1024


@pytest.fixture
def make_client():
    stack = contextlib.ExitStack()

    def build(converter=None, secret=SECRET, **settings) -> TestClient:
        app = create_app(SidecarSettings(secret=SecretStr(secret) if secret else None, **settings), converter=converter)
        return stack.enter_context(TestClient(app))

    yield build
    stack.close()


def post_job(client, *, request_json=None, file_bytes=PDF_BYTES, filename="report.pdf", headers=AUTH, parts=("file", "request")):
    files = {"file": (filename, file_bytes, "application/pdf")} if "file" in parts else None
    data = {"request": request_json if request_json is not None else make_request().model_dump_json()} if "request" in parts else None
    return client.post("/v1/parse/jobs", files=files, data=data, headers=headers)


def poll_state(client, job_id, wanted=("succeeded", "failed", "expired")):
    def read():
        body = client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH).json()
        return body if body.get("status") in wanted else None

    return wait_until(read)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/v1/parse/jobs"),
        ("GET", f"/v1/parse/jobs/{UNKNOWN_JOB}"),
        ("DELETE", f"/v1/parse/jobs/{UNKNOWN_JOB}"),
        ("GET", f"/v1/parse/jobs/{UNKNOWN_JOB}/artifacts/picture-1.png"),
    ],
)
def test_routes_reject_a_missing_or_wrong_secret_with_401(make_client, method, path):
    client = make_client(StubConverter())

    missing = client.request(method, path)
    wrong = client.request(method, path, headers={"x-sidecar-secret": "x" * 48})

    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert SidecarError.model_validate(missing.json()).error == "unauthorized"


@pytest.mark.parametrize(
    ("method", "path"),
    [("POST", "/v1/parse/jobs"), ("GET", f"/v1/parse/jobs/{UNKNOWN_JOB}"), ("DELETE", f"/v1/parse/jobs/{UNKNOWN_JOB}")],
)
def test_routes_answer_503_when_no_secret_is_configured(make_client, method, path):
    response = make_client(StubConverter(), secret=None).request(method, path, headers=AUTH)

    assert response.status_code == 503
    assert SidecarError.model_validate(response.json()).error == "sidecar secret not configured"


def test_post_returns_202_then_get_returns_state_and_delete_removes_the_job(make_client):
    client = make_client(StubConverter())

    created = post_job(client)
    assert created.status_code == 202
    job_id = ParseJobAccepted.model_validate(created.json()).job_id
    assert set(created.json()) == {"job_id"}

    body = poll_state(client, job_id)
    state = ParseJobState.model_validate(body)
    assert state.status == "succeeded"
    assert state.result is not None and state.result.markdown == stub_result().markdown

    assert client.delete(f"/v1/parse/jobs/{job_id}", headers=AUTH).status_code == 204
    assert client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH).status_code == 404
    assert client.delete(f"/v1/parse/jobs/{job_id}", headers=AUTH).status_code == 404


def test_get_reports_queued_or_running_before_the_job_finishes(make_client, gate):
    client = make_client(StubConverter(gate_path=str(gate)))
    job_id = post_job(client).json()["job_id"]

    body = client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH).json()

    assert ParseJobState.model_validate(body).status in ("queued", "running")
    gate.touch()
    assert poll_state(client, job_id)["status"] == "succeeded"


def test_get_unknown_or_malformed_job_id_is_404_with_a_sidecar_error(make_client):
    client = make_client(StubConverter())

    for job_id in (UNKNOWN_JOB, "not-a-uuid", "job_0123", "%2e%2e"):
        response = client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH)
        assert response.status_code == 404, job_id
        assert SidecarError.model_validate(response.json()).error == "job_not_found"


@pytest.mark.parametrize(
    "variant",
    ["bad_profile", "not_json", "unknown_field", "missing_request", "missing_file", "empty_file"],
)
def test_post_rejects_an_invalid_upload_with_422_and_a_sidecar_error(make_client, variant):
    client = make_client(StubConverter())
    options = {
        "bad_profile": {"request_json": make_request().model_dump_json().replace("general@1", "General")},
        "not_json": {"request_json": "{nope"},
        "unknown_field": {"request_json": make_request().model_dump_json()[:-1] + ',"extra":1}'},
        "missing_request": {"parts": ("file",)},
        "missing_file": {"parts": ("request",)},
        "empty_file": {"file_bytes": b""},
    }[variant]

    response = post_job(client, **options)

    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_parse_request"
    assert list(client.app.state.parse_runner.root.iterdir()) == []


def test_post_with_a_non_multipart_body_is_422(make_client):
    client = make_client(StubConverter())

    response = client.post("/v1/parse/jobs", content=b"{}", headers={**AUTH, "content-type": "application/json"})

    assert response.status_code == 422
    assert SidecarError.model_validate(response.json()).error == "invalid_parse_request"


def test_post_upload_over_the_limit_is_413_and_leaves_no_files(make_client):
    client = make_client(StubConverter(), max_upload_mb=1)

    response = post_job(client, file_bytes=b"x" * (MIB + 1))

    assert response.status_code == 413
    assert SidecarError.model_validate(response.json()).error == "upload_too_large"
    assert list(client.app.state.parse_runner.root.iterdir()) == []


def test_post_declared_size_far_above_the_limit_is_rejected_before_reading(make_client):
    client = make_client(StubConverter(), max_upload_mb=1)

    response = post_job(client, file_bytes=b"x" * (3 * MIB))

    assert response.status_code == 413


def test_post_upload_at_exactly_the_limit_is_accepted(make_client):
    client = make_client(StubConverter(), max_upload_mb=1)

    assert post_job(client, file_bytes=b"x" * MIB).status_code == 202


def test_post_with_a_full_queue_is_429_with_retry_after(make_client, gate):
    client = make_client(StubConverter(gate_path=str(gate)), parse_workers=1, parse_queue=0)
    assert post_job(client).status_code == 202

    response = post_job(client)

    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1
    assert SidecarError.model_validate(response.json()).error == "parse_queue_full"


def test_post_never_names_files_after_the_uploaded_filename(make_client):
    client = make_client(StubConverter())
    job_id = post_job(client, filename="../../evil name.pdf").json()["job_id"]
    poll_state(client, job_id)

    names = [path.name for path in client.app.state.parse_runner.root.rglob("*")]
    assert names and all("evil" not in name for name in names)


def test_get_artifact_returns_the_bytes_with_a_content_type(make_client):
    client = make_client(StubConverter(artifacts={"picture-1.png": b"png-bytes", "docling.json": b"{}"}, unlisted={"x.png": b"no"}))
    job_id = post_job(client).json()["job_id"]
    poll_state(client, job_id)

    picture = client.get(f"/v1/parse/jobs/{job_id}/artifacts/picture-1.png", headers=AUTH)
    document = client.get(f"/v1/parse/jobs/{job_id}/artifacts/docling.json", headers=AUTH)

    assert picture.status_code == 200 and picture.content == b"png-bytes"
    assert picture.headers["content-type"] == "image/png"
    assert document.headers["content-type"].startswith("application/json")
    for name in ("x.png", "result.json", "missing.png", "PICTURE.png", ".hidden"):
        response = client.get(f"/v1/parse/jobs/{job_id}/artifacts/{name}", headers=AUTH)
        assert response.status_code == 404, name
        assert SidecarError.model_validate(response.json()).error == "artifact_not_found"
    assert client.get(f"/v1/parse/jobs/{UNKNOWN_JOB}/artifacts/picture-1.png", headers=AUTH).status_code == 404


def test_failed_job_state_carries_the_error_class_and_no_message(make_client):
    client = make_client(StubConverter(raises=ValueError, message="private page text"))
    job_id = post_job(client).json()["job_id"]

    body = poll_state(client, job_id)

    assert ParseJobState.model_validate(body).error_class == "value_error"
    assert "private" not in str(body)


def test_poll_after_the_ttl_reads_expired_not_404(make_client):
    client = make_client(StubConverter(), parse_ttl_seconds=1)
    job_id = post_job(client).json()["job_id"]
    poll_state(client, job_id, wanted=("succeeded",))

    body = poll_state(client, job_id, wanted=("expired",))

    assert ParseJobState.model_validate(body).status == "expired"


def test_parse_routes_answer_503_docling_unavailable_without_a_converter(make_client):
    client = make_client(None)

    created = post_job(client)
    polled = client.get(f"/v1/parse/jobs/{UNKNOWN_JOB}", headers=AUTH)
    fetched = client.get(f"/v1/parse/jobs/{UNKNOWN_JOB}/artifacts/picture-1.png", headers=AUTH)
    deleted = client.delete(f"/v1/parse/jobs/{UNKNOWN_JOB}", headers=AUTH)

    for response in (created, polled, fetched, deleted):
        assert response.status_code == 503
        assert SidecarError.model_validate(response.json()).error == "docling_unavailable"


def test_health_answers_while_a_slow_job_runs(make_client):
    client = make_client(StubConverter(delay_seconds=2.0))
    job_id = post_job(client).json().get("job_id")
    wait_until(lambda: client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH).json().get("status") == "running")

    started = time.monotonic()
    response = client.get("/health")
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 1.0
    assert client.get(f"/v1/parse/jobs/{job_id}", headers=AUTH).json()["status"] == "running"


def test_contracts_schema_version_is_incremented(make_client):
    client = make_client(StubConverter())

    info = SidecarInfo.model_validate(client.get("/v1/info", headers=AUTH).json())

    assert CONTRACTS_SCHEMA_VERSION == 2
    assert info.contracts_schema_version == 2


def fake_docling(monkeypatch):
    class FakeDoclingConverter:
        def convert(self, input_path, request, out_dir):
            return stub_result()

    adapter = types.ModuleType("rag_sidecar.parse.docling_adapter")
    adapter.DoclingConverter = FakeDoclingConverter
    monkeypatch.setitem(sys.modules, "docling", types.ModuleType("docling"))
    monkeypatch.setitem(sys.modules, "rag_sidecar.parse.docling_adapter", adapter)


def test_ready_is_503_docling_artifacts_missing_when_docling_is_installed_without_its_models(make_client, monkeypatch, tmp_path):
    fake_docling(monkeypatch)

    unset = make_client(None).get("/ready")
    absent = make_client(None, docling_artifacts=str(tmp_path / "missing")).get("/ready")

    for response in (unset, absent):
        assert response.status_code == 503
        ready = SidecarReady.model_validate(response.json())
        assert ready.status == "not_ready" and ready.reason == "docling_artifacts_missing"


def test_ready_is_200_when_the_docling_artifacts_directory_exists(make_client, monkeypatch, tmp_path):
    fake_docling(monkeypatch)

    response = make_client(None, docling_artifacts=str(tmp_path)).get("/ready")

    assert response.status_code == 200
    assert SidecarReady.model_validate(response.json()).status == "ready"


def test_ready_is_unchanged_without_docling_or_with_an_injected_converter(make_client, monkeypatch):
    assert make_client(None).get("/ready").status_code == 200
    fake_docling(monkeypatch)
    assert make_client(StubConverter()).get("/ready").status_code == 200


def multipart_stream(chunks):
    async def generate():
        for chunk in chunks:
            yield chunk

    return generate()


def multipart_body(file_payload: bytes, request_payload: bytes = b"{}") -> bytes:
    boundary = b"BOUNDARY"
    return (
        b"--BOUNDARY\r\nContent-Disposition: form-data; name=\"request\"\r\n\r\n" + request_payload + b"\r\n"
        b"--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n"
        b"Content-Type: application/pdf\r\n\r\n" + file_payload + b"\r\n--" + boundary + b"--\r\n"
    )


def test_upload_reader_writes_the_file_part_and_returns_the_request_part(tmp_path):
    destination = tmp_path / "input.bin"
    body = multipart_body(b"A" * 5000, b'{"k":1}')
    chunks = [body[i : i + 700] for i in range(0, len(body), 700)]

    parsed = asyncio.run(read_upload(multipart_stream(chunks), "multipart/form-data; boundary=BOUNDARY", destination, 10_000))

    assert parsed.request_json == b'{"k":1}'
    assert parsed.file_bytes == 5000
    assert destination.read_bytes() == b"A" * 5000


def test_upload_reader_stops_consuming_once_the_limit_is_passed(tmp_path):
    destination = tmp_path / "input.bin"
    consumed = 0

    async def endless():
        nonlocal consumed
        yield b"--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\n"
        while True:
            consumed += 1
            yield b"B" * 4096
            if consumed > 1000:
                return

    with pytest.raises(UploadTooLarge):
        asyncio.run(read_upload(endless(), "multipart/form-data; boundary=BOUNDARY", destination, 20_000))

    assert consumed < 20
    assert destination.stat().st_size <= 20_000


@pytest.mark.parametrize("content_type", ["application/json", "multipart/form-data", "multipart/form-data; boundary="])
def test_upload_reader_rejects_a_body_that_is_not_multipart(tmp_path, content_type):
    with pytest.raises(MalformedUpload):
        asyncio.run(read_upload(multipart_stream([b"{}"]), content_type, tmp_path / "input.bin", 1000))


def test_upload_reader_rejects_a_duplicate_file_part(tmp_path):
    part = b'--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nxx\r\n'
    body = part + part + b"--BOUNDARY--\r\n"

    with pytest.raises(MalformedUpload):
        asyncio.run(read_upload(multipart_stream([body]), "multipart/form-data; boundary=BOUNDARY", tmp_path / "input.bin", 1000))
