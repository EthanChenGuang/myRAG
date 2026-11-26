"""The hidden-text check in the worker's preflight (plan 03.2-38, D-33, D-34).

Under tiered routing the worker checks the original when the snapshot asks for it and sends the report with every
post-parse advance call; with the check off it runs nothing and sends exactly the body it sent before.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("docling_core.transforms.chunker.hybrid_chunker")
pytest.importorskip("pypdfium2")
pytest.importorskip("pdfplumber")

from test_ingest_tiered import (  # noqa: E402
    _BUCKET,
    _WORKER,
    Env,
    SyntheticConverter,
    _job,
    _synthetic_preflight,
)

from rag_sidecar.contracts.ingest_security import HiddenTextReport  # noqa: E402
from rag_sidecar.contracts.queue import AdvanceRequest  # noqa: E402
from rag_sidecar.ingest.process_job import JobOutcome, process_job  # noqa: E402
from rag_sidecar.preflight.hidden_text_hook import (  # noqa: E402
    CHECKER_UNAVAILABLE,
    HiddenTextPreflightUnavailable,
    hidden_text_mime_type,
    run_hidden_text_preflight,
)
from rag_sidecar.security.hidden_text import EncryptedDocument  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
SECURITY_PDF = REPO_ROOT / "eval" / "fixtures" / "security" / "pdf"
MANIFEST = json.loads((SECURITY_PDF / "manifest.json").read_text(encoding="utf-8"))["fixtures"]
WHITE = "white-on-white.pdf"
CLEAN = "clean-plain.pdf"

_FOUND = HiddenTextReport.model_validate(
    {
        "status": "hidden_found",
        "spans": [{"page": 1, "text": "A synthetic sentence the page hides.", "reason": "color_near_background", "bbox": None}],
        "checker_version": "hidden-text/1/test",
    }
)


class RecordingChecker:
    def __init__(self, report: HiddenTextReport | None = None, error: Exception | None = None) -> None:
        self.calls: list[tuple[int, str]] = []
        self.report = report or _FOUND
        self.error = error

    def __call__(self, data: bytes, mime_type: str) -> HiddenTextReport:
        self.calls.append((len(data), mime_type))
        if self.error is not None:
            raise self.error
        return self.report


_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def _stable(value: Any) -> str:
    """A dump with the random cache ids replaced, so two runs of the same job compare equal."""
    return _UUID.sub("<id>", json.dumps(value, sort_keys=True, default=str))


def _process(env: Env) -> JobOutcome:
    return asyncio.run(process_job(env.job, env.deps))


def _pdf_env(tmp_path: Path, original: bytes, *, mode: str | None, checker: Any = None, sha: str = "e" * 64) -> Env:
    settings = {} if mode is None else {"hidden_text_check": mode}
    job = _job(sha=sha, **settings)
    return Env(
        tmp_path,
        job,
        original,
        converter=SyntheticConverter(),
        preflight=_synthetic_preflight(1, [(1, 1, "fast")]),
        hidden_text_checker=checker,
    )


# ---------------------------------------------------------------------------------------------------------------------
# run_hidden_text_preflight
# ---------------------------------------------------------------------------------------------------------------------


def test_off_runs_no_check():
    checker = RecordingChecker()
    assert run_hidden_text_preflight(_job(sha="e" * 64), b"%PDF", checker=checker) is None
    assert checker.calls == []


@pytest.mark.parametrize("mode", ["flag", "quarantine"])
def test_a_pdf_is_checked_with_its_bytes_and_media_type(mode):
    checker = RecordingChecker()
    report = run_hidden_text_preflight(_job(sha="e" * 64, hidden_text_check=mode), b"%PDF-1.4", checker=checker)
    assert report == _FOUND
    assert checker.calls == [(8, "application/pdf")]


@pytest.mark.parametrize(
    ("mime", "filename", "expected"),
    [
        ("application/pdf", "x.bin", "application/pdf"),
        ("application/octet-stream", "notes.PDF", "application/pdf"),
        (None, "memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("text/markdown", "notes.pdf", None),
        ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx", None),
        ("", "notes.txt", None),
    ],
)
def test_only_the_formats_the_app_sends_to_the_checker_are_checked(mime, filename, expected):
    assert hidden_text_mime_type(mime, filename) == expected


def test_a_format_without_a_checker_is_not_checked_in_the_worker():
    checker = RecordingChecker()
    job = _job(sha="e" * 64, filename="notes.md", mime="text/markdown", hidden_text_check="quarantine")
    assert run_hidden_text_preflight(job, b"# notes", checker=checker) is None
    assert checker.calls == []


def test_a_checker_error_under_quarantine_is_retryable_and_under_flag_is_left_to_the_app():
    failing = RecordingChecker(error=RuntimeError("boom"))
    with pytest.raises(HiddenTextPreflightUnavailable) as raised:
        run_hidden_text_preflight(_job(sha="e" * 64, hidden_text_check="quarantine"), b"%PDF", checker=failing)
    assert raised.value.error_class == CHECKER_UNAVAILABLE and raised.value.retryable is True
    assert run_hidden_text_preflight(_job(sha="e" * 64, hidden_text_check="flag"), b"%PDF", checker=failing) is None


def test_an_encrypted_original_under_quarantine_is_not_retried():
    with pytest.raises(HiddenTextPreflightUnavailable) as raised:
        run_hidden_text_preflight(
            _job(sha="e" * 64, hidden_text_check="quarantine"), b"%PDF", checker=RecordingChecker(error=EncryptedDocument())
        )
    assert raised.value.retryable is False


def test_the_real_checker_finds_the_white_on_white_sentence():
    expected = MANIFEST[WHITE]
    report = run_hidden_text_preflight(
        _job(sha=expected["sha256"], hidden_text_check="quarantine"), (SECURITY_PDF / WHITE).read_bytes()
    )
    assert report is not None and report.status == "hidden_found"
    assert [(span.text, span.reason) for span in report.spans] == [(expected["hidden_text"], expected["reason"])]


# ---------------------------------------------------------------------------------------------------------------------
# The advance body
# ---------------------------------------------------------------------------------------------------------------------


def test_an_advance_request_without_a_report_serialises_exactly_as_before():
    request = AdvanceRequest(worker_id=_WORKER, attempt_no=1, phase="post_parse", parse_cache_id="c", deadline_ms=40_000)
    assert request.model_dump(mode="json") == {
        "worker_id": _WORKER,
        "attempt_no": 1,
        "phase": "post_parse",
        "parse_cache_id": "c",
        "deadline_ms": 40_000,
        "cursor": None,
        "provisional": False,
    }


def test_a_report_is_only_sent_with_post_parse():
    with pytest.raises(ValueError):
        AdvanceRequest(worker_id=_WORKER, attempt_no=1, phase="begin", deadline_ms=1, hidden_text_report=_FOUND)


# ---------------------------------------------------------------------------------------------------------------------
# The tiered flow
# ---------------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["flag", "quarantine"])
def test_a_tiered_pdf_sends_the_report_with_every_advance_call(tmp_path, mode):
    checker = RecordingChecker()
    env = _pdf_env(tmp_path, b"%PDF-1.4 synthetic", mode=mode, checker=checker)

    outcome = _process(env)

    assert outcome == JobOutcome(status="ready")
    assert checker.calls == [(len(b"%PDF-1.4 synthetic"), "application/pdf")]
    calls = env.advance_calls()
    assert calls and all(call["hidden_text_report"] == _FOUND.model_dump(mode="json") for call in calls)


def test_the_real_checker_report_of_the_white_pdf_reaches_advance(tmp_path):
    expected = MANIFEST[WHITE]
    env = _pdf_env(tmp_path, (SECURITY_PDF / WHITE).read_bytes(), mode="quarantine", sha=expected["sha256"])

    assert _process(env) == JobOutcome(status="ready")

    (call,) = env.advance_calls()
    report = call["hidden_text_report"]
    assert report["status"] == "hidden_found"
    assert [span["text"] for span in report["spans"]] == [expected["hidden_text"]]


def test_a_clean_pdf_sends_a_clean_report(tmp_path):
    expected = MANIFEST[CLEAN]
    env = _pdf_env(tmp_path, (SECURITY_PDF / CLEAN).read_bytes(), mode="quarantine", sha=expected["sha256"])

    assert _process(env) == JobOutcome(status="ready")
    (call,) = env.advance_calls()
    assert call["hidden_text_report"]["status"] == "clean" and call["hidden_text_report"]["spans"] == []


def test_off_makes_no_check_and_sends_and_records_exactly_what_it_did_before(tmp_path):
    checker = RecordingChecker()
    baseline_env = _pdf_env(tmp_path / "baseline", b"%PDF-1.4 synthetic", mode=None, checker=checker)
    off_env = _pdf_env(tmp_path / "off", b"%PDF-1.4 synthetic", mode="off", checker=checker)

    assert _process(baseline_env) == _process(off_env) == JobOutcome(status="ready")

    assert checker.calls == []
    assert _stable(off_env.advance_calls()) == _stable(baseline_env.advance_calls())
    assert all("hidden_text_report" not in call for call in off_env.advance_calls())
    assert _stable(off_env.job.model_dump(mode="json")) == _stable(baseline_env.job.model_dump(mode="json"))
    cache_keys = lambda env: sorted((entry.parser, entry.options_hash) for entry in env.ledger.cache.values())  # noqa: E731
    assert cache_keys(off_env) == cache_keys(baseline_env)


def test_a_checker_error_under_quarantine_fails_the_job_retryably_before_anything_is_handed_over(tmp_path):
    env = _pdf_env(tmp_path, b"%PDF-1.4 synthetic", mode="quarantine", checker=RecordingChecker(error=RuntimeError("down")))

    outcome = _process(env)

    assert outcome == JobOutcome(status="queued", error_class=CHECKER_UNAVAILABLE)
    assert env.job.status == "queued" and env.job.retries == 1
    assert env.advance_calls() == []


def test_a_checker_error_under_flag_hands_over_without_a_report(tmp_path):
    env = _pdf_env(tmp_path, b"%PDF-1.4 synthetic", mode="flag", checker=RecordingChecker(error=RuntimeError("down")))

    assert _process(env) == JobOutcome(status="ready")
    assert all("hidden_text_report" not in call for call in env.advance_calls())


def _resumed_env(tmp_path: Path, cursor: str, checker: RecordingChecker) -> Env:
    env = _pdf_env(tmp_path, b"%PDF-1.4 synthetic", mode="quarantine", checker=checker)
    job = env.job.model_copy(
        update={"status": "chunking", "stage": "chunking", "stage_state": {"parse_cache_id": "00000000-0000-4000-8000-0000000000c9", "cursor": cursor}}
    )
    env.ledger.jobs[job.id] = job
    return env


def test_a_reclaimed_job_before_scan_injection_checks_its_original_again(tmp_path):
    checker = RecordingChecker()
    env = _resumed_env(tmp_path, "content_hash_dedup", checker)

    assert _process(env) == JobOutcome(status="ready")

    assert checker.calls == [(len(b"%PDF-1.4 synthetic"), "application/pdf")]
    assert ("download", _BUCKET, env.job.original_ref.path) in env.storage.calls
    (call,) = env.advance_calls()
    assert call["hidden_text_report"] == _FOUND.model_dump(mode="json")


def test_a_reclaimed_job_past_scan_injection_checks_nothing(tmp_path):
    checker = RecordingChecker()
    env = _resumed_env(tmp_path, "scan_injection", checker)

    assert _process(env) == JobOutcome(status="ready")

    assert checker.calls == []
    assert all("hidden_text_report" not in call for call in env.advance_calls())
