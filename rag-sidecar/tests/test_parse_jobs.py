import os
import sys
import time
import types
import uuid
from pathlib import Path

import pytest
from pydantic import SecretStr

from rag_sidecar.contracts import DoclingOptions, ParseJobRequest, ParseResult
from rag_sidecar.parse import converter as converter_module
from rag_sidecar.parse.converter import (
    PageCapExceeded,
    StubConverter,
    default_converter,
    docling_available,
    stub_result,
)
from rag_sidecar.parse.jobs import JobRunner, QueueFull
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
    runner = make_runner(StubConverter(raises=PageCapExceeded))
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
